import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SessionJournal } from "../client/session-journal.ts";
import { ClientSession } from "../client/client-session.ts";
import type { MeetingCommand, Outcome, Replay } from "../storage/types.ts";
import { emptyState } from "../storage/engine.ts";

const outcome: Outcome = { code: "OK", seq: 1, generation: 1, grantVersion: 0 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zoom-session-"));
  const path = join(root, "session.sqlite");
  const target = { clusterId: randomUUID(), meetingId: randomUUID(), name: "Alice" };
  const open = () => SessionJournal.open(path, target);
  return { path, target, open, clean: () => rm(root, { recursive: true, force: true }) };
}
function page(meetingId: string, seqs: number[], watermark = seqs.at(-1) ?? 0): Replay {
  return { meetingId, code: "session", generation: 1, runtimeId: randomUUID(), incarnation: randomUUID(),
    attemptId: randomUUID(), phase: "ACTIVE", watermark, observedAt: new Date().toISOString(), state: emptyState(),
    events: seqs.map(seq => ({ seq, generation: 1, lamport: seq + 10, kind: "chat", payload: { participantId: randomUUID(), content: `chat ${seq}` } })),
    scannedWatermark: seqs.at(-1) ?? watermark };
}

test("credentials and initial join are committed before use and immutable through reopen", async () => {
  const f = await fixture();
  let journal = f.open();
  try {
    const original = journal.pending()[0];
    assert.match(original.secret, /^[a-f0-9]{64}$/);
    assert.deepEqual(original.operation, { type: "join", name: "Alice" });
    const input = { type: "chat" as const, content: "original" };
    const id = journal.enqueue(input);
    input.content = "mutated";
    original.operation = { type: "leave" };
    journal.close(); journal = f.open();
    assert.deepEqual(journal.pending().map(c => c.operation), [{ type: "join", name: "Alice" }, { type: "chat", content: "original" }]);
    assert.equal(journal.pending()[1].id, id);
    assert.equal(journal.pending()[0].participantId, original.participantId);
    assert.equal(journal.pending()[0].secret, original.secret);
    assert.throws(() => SessionJournal.open(f.path, { ...f.target, meetingId: randomUUID() }), /SESSION_TARGET/);
    assert.equal(JSON.stringify(journal.view()).includes(original.secret), false);
  } finally { journal.close(); await f.clean(); }
});

test("a durable session refuses SQLite memory databases", async () => {
  const f = await fixture();
  try { assert.throws(() => SessionJournal.open(":memory:", f.target), /DURABLE_SESSION_PATH/); }
  finally { await f.clean(); }
});

test("lost replies survive agent restart and replay the exact command before later commands", async () => {
  const f = await fixture();
  let journal = f.open();
  const sent: MeetingCommand[] = [];
  let loseReply = true;
  const transport = {
    async execute(command: MeetingCommand) { sent.push(structuredClone(command)); if (loseReply) throw new Error("LOST_REPLY"); return outcome; },
    async read() { return page(f.target.meetingId, [1]); }, close() {},
  };
  try {
    let session = new ClientSession(journal, async () => transport);
    await assert.rejects(session.step(), /LOST_REPLY/);
    assert.equal(session.state, "reconnecting");
    const pending = journal.pending()[0];
    journal.close(); journal = f.open();
    session = new ClientSession(journal, async () => transport);
    const chatId = session.submit({ type: "chat", content: "after restart" });
    loseReply = false;
    await session.step();
    assert.deepEqual(sent[1], pending);
    assert.equal(sent[2].id, chatId);
    assert.equal(journal.pending().length, 0);
    assert.equal(session.state, "connected");
    assert.equal(journal.view().cursor.seq, 1);
    assert.equal(journal.view().events.length, 1);
  } finally { journal.close(); await f.clean(); }
});

test("replay atomically retains pages and rejects wrong scopes, gaps and regressing watermarks", async () => {
  const f = await fixture();
  let journal = f.open();
  try {
    const first = page(f.target.meetingId, [1, 2], 4);
    journal.recordReplay({ meetingId: f.target.meetingId, subscriptionRevision: 0, seq: 0 }, first);
    assert.equal(journal.view().cursor.seq, 2);
    journal.close(); journal = f.open();
    const cursor = journal.view().cursor;
    assert.deepEqual(journal.view().events.map(e => e.seq), [1, 2]);
    assert.throws(() => journal.recordReplay({ ...cursor, subscriptionRevision: 1 }, page(f.target.meetingId, [3, 4])), /CURSOR/);
    assert.throws(() => journal.recordReplay(cursor, page(randomUUID(), [3, 4])), /CURSOR/);
    assert.throws(() => journal.recordReplay(cursor, page(f.target.meetingId, [4])), /CURSOR/);
    assert.throws(() => journal.recordReplay(cursor, page(f.target.meetingId, [3], 2)), /CURSOR/);
    assert.equal(journal.view().cursor.seq, 2);
    journal.recordReplay(cursor, page(f.target.meetingId, [3, 4]));
    assert.deepEqual(journal.view().events.map(e => e.seq), [1, 2, 3, 4]);
    assert.equal(journal.view(2).events.length, 2);
  } finally { journal.close(); await f.clean(); }
});

test("concurrent callers serialize one join and ordered pending commands with bounded work", async () => {
  const f = await fixture(), journal = f.open();
  const sent: MeetingCommand[] = [];
  let resolve!: () => void;
  const arrived = new Promise<void>(r => { resolve = r; });
  let release!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const session = new ClientSession(journal, async () => ({
    async execute(c) { sent.push(c); resolve(); await blocked; return outcome; },
    async read() { return page(f.target.meetingId, []); }, close() {},
  }));
  try {
    const a = session.submit({ type: "chat", content: "a" }), b = session.submit({ type: "chat", content: "b" });
    const first = session.step(); await arrived;
    const second = session.step(); release();
    await Promise.all([first, second]);
    assert.deepEqual(sent.map(c => c.id), [sent[0].id, a, b]);
    assert.ok(sent[0].lamport < sent[1].lamport && sent[1].lamport < sent[2].lamport);
    for (let i = 0; i < 128; i++) session.submit({ type: "chat", content: String(i) });
    assert.throws(() => session.submit({ type: "chat", content: "overflow" }), /PENDING_LIMIT/);
  } finally { release(); journal.close(); await f.clean(); }
});

test("leave forms a durable queue boundary and abort preserves an uncertain command", async () => {
  const f = await fixture(), journal = f.open();
  try {
    journal.enqueue({ type: "leave" });
    assert.throws(() => journal.enqueue({ type: "chat", content: "after leave" }), /SESSION_LEAVING/);
    const abort = new AbortController();
    let entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; });
    let reject!: (error: Error) => void;
    const session = new ClientSession(journal, async () => ({
      async execute() { entered(); return new Promise<Outcome>((_, r) => { reject = r; }); },
      async read() { return page(f.target.meetingId, []); }, close() { reject(new Error("CLOSED")); },
    }));
    const running = session.run(abort.signal);
    await arrived; abort.abort(); await running;
    assert.equal(journal.pending().length, 2);
  } finally { journal.close(); await f.clean(); }
});

test("abort during route lookup cannot send a command after cancellation", async () => {
  const f = await fixture(), journal = f.open(), abort = new AbortController();
  let release!: () => void, entered!: () => void, sent = 0;
  const blocked = new Promise<void>(r => { release = r; }), arrived = new Promise<void>(r => { entered = r; });
  const session = new ClientSession(journal, async () => {
    entered(); await blocked;
    return { async execute() { sent++; return outcome; }, async read() { return page(f.target.meetingId, []); }, close() {} };
  });
  try {
    const running = session.run(abort.signal); await arrived; abort.abort(); release(); await running;
    assert.equal(sent, 0);
    assert.equal(journal.pending().length, 1);
  } finally { release(); journal.close(); await f.clean(); }
});

test("malformed replay state, observations and events cannot commit an inbox entry or cursor", async () => {
  const f = await fixture(), journal = f.open();
  try {
    const malformed = [
      (p: any) => { p.state.members = "invalid"; },
      (p: any) => { delete p.state.queue; },
      (p: any) => { p.state.holder = { participantId: "bad", requestId: randomUUID() }; },
      (p: any) => { p.state.members[randomUUID()] = { name: 123, joined: true }; },
      (p: any) => { p.observedAt = "invalid"; },
      (p: any) => { delete p.generation; },
      (p: any) => { p.events[1].kind = ""; },
      (p: any) => { p.events[1].payload = []; },
      (p: any) => { p.events[1].payload.content = 123; },
    ];
    for (const mutate of malformed) {
      const replay = page(f.target.meetingId, [1, 2]); mutate(replay);
      assert.throws(() => journal.recordReplay(journal.cursor(), replay), /INVALID_CURSOR/);
      assert.equal(journal.cursor().seq, 0);
      assert.equal(journal.view().events.length, 0);
    }
  } finally { journal.close(); await f.clean(); }
});
