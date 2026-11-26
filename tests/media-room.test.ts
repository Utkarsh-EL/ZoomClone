import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MediaRoom } from "../media/room.ts";

function fixture() {
  const participantId = randomUUID(), peerId = randomUUID(), requestId = randomUUID();
  let allowed = true, lease = true, reads = 0;
  const snapshot = { meetingId: randomUUID(), generation: 1, runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID(), phase: "ACTIVE",
    state: { members: { [participantId]: { joined: true } }, holder: { participantId, requestId }, grantVersion: 1 } };
  const effects: any[] = [];
  const room = new MediaRoom(async request => { effects.push(request); return { epoch: "epoch", value: request.action }; });
  const context = { peerId, participantId, ownsCapture: () => lease, authorize: async () => { reads++; if (!allowed) throw new Error("NOT_READY"); return snapshot; } };
  return { room, context, snapshot, effects, requestId, deny: () => { allowed = false; }, revoke: () => { lease = false; }, reads: () => reads };
}
test("media controls freshly authorize membership, exact grant and local lease", async () => {
  const f = fixture();
  await f.room.handle(f.context, { action: "open" });
  await f.room.handle(f.context, { epoch: "epoch", action: "produce", source: "screen", requestId: f.requestId, grantVersion: 1 });
  assert.equal(f.reads(), 2);
  await assert.rejects(f.room.handle(f.context, { epoch: "epoch", action: "produce", source: "screen", requestId: randomUUID(), grantVersion: 1 }), /STALE_GRANT/);
  f.revoke();
  await assert.rejects(f.room.handle(f.context, { epoch: "epoch", action: "produce", source: "camera" }), /NOT_CAPTURE_OWNER/);
  f.deny();
  await assert.rejects(f.room.handle(f.context, { action: "list", epoch: "epoch" }), /NOT_READY/);
  assert.equal(f.effects.filter(e => e.action === "produce").length, 1);
});
test("a queued revocation closes an in-flight effect before the next publisher", async () => {
  const f = fixture(); let release!: () => void;
  const effects: string[] = [];
  const room = new MediaRoom(async r => { effects.push(r.action); if (r.action === "produce") await new Promise<void>(resolve => { release = resolve; }); return { epoch: "epoch", value: {} }; });
  const publish = room.handle(f.context, { epoch: "epoch", action: "produce", source: "camera" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.revoke(); const revoke = room.revoke(f.context.peerId);
  const next = room.handle(f.context, { epoch: "epoch", action: "produce", source: "camera" });
  release(); await publish; await revoke;
  await assert.rejects(next, /NOT_CAPTURE_OWNER/);
  assert.deepEqual(effects, ["hello", "sync", "produce", "closePeer", "hello"]);
});
test("media admission is bounded and fresh authorization observes generation changes", async () => {
  const f = fixture(); let release!: () => void;
  const context = { ...f.context, authorize: async () => { await new Promise<void>(resolve => { release = resolve; }); return f.snapshot; } };
  const work = f.room.handle(context, { action: "list", epoch: "epoch" });
  const queued = Array.from({ length: 15 }, () => f.room.handle(f.context, { action: "list", epoch: "epoch" }));
  await assert.rejects(f.room.handle(f.context, { action: "list", epoch: "epoch" }), /MEDIA_BUSY/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); await work; await Promise.all(queued);
  f.snapshot.generation = 2;
  await f.room.handle(f.context, { action: "list", epoch: "epoch" });
  assert.equal(f.effects.at(-1).owner.generation, 2);
  f.snapshot.phase = "RECOVERING";
  await assert.rejects(f.room.handle(f.context, { action: "open" }), /FENCED/);
});
test("repeated revocation coalesces while a full media queue drains", async () => {
  const f = fixture(); let release!: () => void; const effects: string[] = [];
  const room = new MediaRoom(async r => { effects.push(r.action); if (r.action === "sync") await new Promise<void>(resolve => { release = resolve; }); return { epoch: "epoch", value: {} }; });
  const work = room.handle(f.context, { action: "list", epoch: "epoch" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const cleanup = Array.from({ length: 40 }, () => room.revoke(f.context.peerId));
  release(); await work; await Promise.all(cleanup);
  assert.equal(effects.filter(action => action === "closePeer").length, 1);
});
test("disconnect revocation follows an intervening reopen instead of coalescing before it", async () => {
  const f = fixture(); let release!: () => void, opened = false, closes = 0;
  const room = new MediaRoom(async r => {
    if (r.action === "open") opened = true;
    if (r.action === "closePeer") { if (++closes === 1) await new Promise<void>(resolve => { release = resolve; }); opened = false; }
    return { epoch: "epoch", value: {} };
  });
  await room.handle(f.context, { action: "open" });
  const first = room.revoke(f.context.peerId);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const reopen = room.handle(f.context, { action: "open" }), second = room.revoke(f.context.peerId);
  release(); await first; await reopen; await second;
  assert.equal(opened, false); assert.equal(closes, 2);
});
test("unused attachment churn cannot enqueue SFU cleanup or block ordinary controls", async () => {
  const f = fixture(), effects: string[] = []; let release!: () => void;
  const room = new MediaRoom(async r => { effects.push(r.action); if (r.action === "open") await new Promise<void>(resolve => { release = resolve; }); return { epoch: "epoch", value: {} }; });
  const work = room.handle(f.context, { action: "open" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const cleanup = Array.from({ length: 1000 }, (_, i) => room.revoke(`unused-${i}`));
  const list = room.handle(f.context, { action: "list", epoch: "epoch" });
  release(); await work; await Promise.all(cleanup); await list;
  assert.equal(effects.filter(action => action === "closePeer").length, 0);
});

test("an SFU restart between negotiation and authorization cannot install a retained fence", async () => {
  const f = fixture(); let epoch = "before", synced = false, reads = 0, negotiations = 0;
  const room = new MediaRoom(async r => {
    if (r.action === "hello") { negotiations++; return { epoch, value: {} }; }
    if (r.epoch !== epoch) throw new Error("SFU_RESTARTED");
    if (r.action === "sync") synced = true;
    return { epoch, value: {} };
  });
  const context = { ...f.context, authorize: async () => { reads++; epoch = "after"; return f.snapshot; } };
  await assert.rejects(room.handle(context, { action: "open" }), /SFU_RESTARTED/);
  assert.equal(synced, false); assert.equal(reads, 1); assert.equal(negotiations, 1);
});

test("a request from an earlier SFU epoch is refused before authorization or effects", async () => {
  const f = fixture();
  await assert.rejects(f.room.handle(f.context, { action: "list", epoch: "old" }), /SFU_RESTARTED/);
  assert.equal(f.reads(), 0); assert.equal(f.effects.filter(r => r.action !== "hello").length, 0);
});

test("room shutdown refuses admission and waits for admitted work and peer teardown", async () => {
  const f = fixture(); let release!: () => void, closed = false;
  const room = new MediaRoom(async r => {
    if (r.action === "open") await new Promise<void>(resolve => { release = resolve; });
    if (r.action === "closePeer") closed = true;
    return { epoch: "epoch", value: {} };
  });
  const work = room.handle(f.context, { action: "open" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const closing = room.close();
  await assert.rejects(room.handle(f.context, { action: "open" }), /MEDIA_CLOSED/);
  assert.equal(closed, false); release(); await work; await closing; assert.equal(closed, true);
});

test("a queued close and reopen retain the reservation through revocation and shutdown", async () => {
  const f = fixture(); let release!: () => void, live = false;
  const room = new MediaRoom(async r => {
    if (r.action === "open") live = true;
    if (r.action === "closePeer") { if (!release) await new Promise<void>(resolve => { release = resolve; }); live = false; }
    return { epoch: "epoch", value: {} };
  });
  await room.handle(f.context, { action: "open" });
  const closing = room.handle(f.context, { action: "closePeer" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const reopen = room.handle(f.context, { action: "open" });
  release(); await closing; await reopen;
  await room.revoke(f.context.peerId); await room.close(); assert.equal(live, false);
});

test("failed teardown retains uncertain resources for shutdown instead of reporting quiescence", async () => {
  const f = fixture(); let available = true, live = false;
  const room = new MediaRoom(async r => {
    if (r.action === "open") live = true;
    if (r.action === "closePeer") { if (!available) throw new Error("SFU_UNAVAILABLE"); live = false; }
    return { epoch: "epoch", value: {} };
  });
  await room.handle(f.context, { action: "open" }); available = false;
  await assert.rejects(room.revoke(f.context.peerId), /SFU_UNAVAILABLE/);
  available = true; await room.close(); assert.equal(live, false);
});
