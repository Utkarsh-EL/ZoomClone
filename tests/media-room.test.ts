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
  await f.room.handle(f.context, { action: "produce", source: "screen", requestId: f.requestId, grantVersion: 1 });
  assert.equal(f.reads(), 2);
  await assert.rejects(f.room.handle(f.context, { action: "produce", source: "screen", requestId: randomUUID(), grantVersion: 1 }), /STALE_GRANT/);
  f.revoke();
  await assert.rejects(f.room.handle(f.context, { action: "produce", source: "camera" }), /NOT_CAPTURE_OWNER/);
  f.deny();
  await assert.rejects(f.room.handle(f.context, { action: "list" }), /NOT_READY/);
  assert.equal(f.effects.filter(e => e.action === "produce").length, 1);
});
test("a queued revocation closes an in-flight effect before the next publisher", async () => {
  const f = fixture(); let release!: () => void;
  const effects: string[] = [];
  const room = new MediaRoom(async r => { effects.push(r.action); if (r.action === "produce") await new Promise<void>(resolve => { release = resolve; }); return {}; });
  const publish = room.handle(f.context, { action: "produce", source: "camera" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.revoke(); const revoke = room.revoke(f.context.peerId);
  const next = room.handle(f.context, { action: "produce", source: "camera" });
  release(); await publish; await revoke;
  await assert.rejects(next, /NOT_CAPTURE_OWNER/);
  assert.deepEqual(effects, ["sync", "produce", "closePeer"]);
});
test("media admission is bounded and fresh authorization observes generation changes", async () => {
  const f = fixture(); let release!: () => void;
  const context = { ...f.context, authorize: async () => { await new Promise<void>(resolve => { release = resolve; }); return f.snapshot; } };
  const work = f.room.handle(context, { action: "list" });
  const queued = Array.from({ length: 15 }, () => f.room.handle(f.context, { action: "list" }));
  await assert.rejects(f.room.handle(f.context, { action: "list" }), /MEDIA_BUSY/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); await work; await Promise.all(queued);
  f.snapshot.generation = 2;
  await f.room.handle(f.context, { action: "list" });
  assert.equal(f.effects.at(-1).owner.generation, 2);
  f.snapshot.phase = "RECOVERING";
  await assert.rejects(f.room.handle(f.context, { action: "open" }), /FENCED/);
});
test("repeated revocation coalesces while a full media queue drains", async () => {
  const f = fixture(); let release!: () => void; const effects: string[] = [];
  const room = new MediaRoom(async r => { effects.push(r.action); if (r.action === "sync") await new Promise<void>(resolve => { release = resolve; }); return {}; });
  const work = room.handle(f.context, { action: "list" });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const cleanup = Array.from({ length: 40 }, () => room.revoke(f.context.peerId));
  release(); await work; await Promise.all(cleanup);
  assert.equal(effects.filter(action => action === "closePeer").length, 1);
});
