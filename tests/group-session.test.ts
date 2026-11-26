import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SessionJournal } from "../client/session-journal.ts";
import { ClientSession } from "../client/client-session.ts";
import { emptyState } from "../storage/engine.ts";
import type { GroupReplay, MeetingCommand, Replay } from "../storage/types.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zoom-groups-")), path = join(root, "session.sqlite");
  const target = { clusterId: randomUUID(), meetingId: randomUUID(), name: "Alice" };
  return { path, target, open: () => SessionJournal.open(path, target), clean: () => rm(root, { recursive: true, force: true }) };
}
const outcome = { code: "OK", seq: 20, generation: 1, grantVersion: 0 };
const groupPage = (groupId: string, seq: number): GroupReplay => ({ groupId, watermark: seq, scannedWatermark: seq,
  events: [{ seq, generation: 1, lamport: 90 + seq, kind: "group-chat", payload: { participantId: randomUUID(), content: "private history" } }] });
const meetingPage = (meetingId: string): Replay => ({ meetingId, code: "demo", generation: 1, runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID(),
  phase: "ACTIVE", state: emptyState(), watermark: 0, scannedWatermark: 0, events: [], observedAt: new Date().toISOString() });

test("journal upgrades a version-one identity transactionally and preserves exact pending/result/inbox bytes", async () => {
  const f = await fixture(); let journal = f.open();
  const pending = journal.pending()[0]; journal.complete(pending.id, outcome);
  const replay = { ...meetingPage(f.target.meetingId), watermark: 1, scannedWatermark: 1,
    events: [{ seq: 1, generation: 1, lamport: 70, kind: "chat", payload: { participantId: pending.participantId, content: "retain meeting inbox" } }] };
  journal.recordReplay(journal.cursor(), replay);
  const uncertainId = journal.enqueue({ type: "chat", content: "keep exactly" });
  const uncertain = journal.pending()[0], credential = journal.credential(); journal.close();
  const old = new DatabaseSync(f.path);
  const raw = old.prepare("SELECT value FROM metadata WHERE key='identity'").get()!.value as string;
  old.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify({ ...JSON.parse(raw), version: 1 }));
  const bytes = old.prepare("SELECT * FROM commands ORDER BY ordinal").all();
  const inboxBytes = old.prepare("SELECT * FROM inbox ORDER BY seq").all();
  const cursorBytes = old.prepare("SELECT key,value FROM metadata WHERE key IN ('cursor','clock','observation') ORDER BY key").all();
  // A failed format change must roll back every new table and identity write.
  old.exec("DROP TABLE IF EXISTS group_inbox; DROP TABLE IF EXISTS group_catalog; DROP TABLE IF EXISTS group_progress; CREATE TRIGGER fail_upgrade BEFORE UPDATE ON metadata WHEN NEW.key='identity' BEGIN SELECT RAISE(ABORT,'interrupted upgrade'); END;");
  old.close();
  try {
    assert.throws(() => { const opened = f.open(); opened.close(); }, /interrupted upgrade/);
    const inspect = new DatabaseSync(f.path);
    assert.equal(JSON.parse(inspect.prepare("SELECT value FROM metadata WHERE key='identity'").get()!.value as string).version, 1);
    assert.deepEqual(inspect.prepare("SELECT * FROM commands ORDER BY ordinal").all(), bytes);
    assert.deepEqual(inspect.prepare("SELECT * FROM inbox ORDER BY seq").all(), inboxBytes);
    inspect.exec("DROP TRIGGER fail_upgrade"); inspect.close();
    journal = f.open();
    assert.deepEqual(journal.credential(), credential); assert.deepEqual(journal.pending(), [uncertain]);
    assert.equal(journal.cursor().seq, 1); assert.equal(journal.view().events[0].payload.content, "retain meeting inbox");
    assert.equal(journal.pending()[0].id, uncertainId); journal.close();
    const upgraded = new DatabaseSync(f.path);
    assert.equal(JSON.parse(upgraded.prepare("SELECT value FROM metadata WHERE key='identity'").get()!.value as string).version, 2);
    assert.deepEqual(upgraded.prepare("SELECT * FROM commands ORDER BY ordinal").all(), bytes);
    assert.deepEqual(upgraded.prepare("SELECT * FROM inbox ORDER BY seq").all(), inboxBytes);
    assert.deepEqual(upgraded.prepare("SELECT key,value FROM metadata WHERE key IN ('cursor','clock','observation') ORDER BY key").all(), cursorBytes);
    upgraded.close();
  } finally { await f.clean(); }
});

test("scoped replay starts from zero independently, commits clock/inbox/cursor atomically and retains history on leave", async () => {
  const f = await fixture(); let j = f.open(); const groupId = randomUUID();
  try {
    j.recordCatalog("", { groups: [{ groupId, name: "Study", membership: "member" }], nextAfter: null });
    assert.equal(j.groupCursor(groupId), 0);
    const good = groupPage(groupId, 1);
    for (const bad of [ { ...good, groupId: randomUUID() }, { ...good, scannedWatermark: 2 }, { ...good, events: [{ ...good.events[0], kind: "chat" }] },
      { ...good, events: [{ ...good.events[0], payload: { content: "missing issuer" } }] } ]) {
      assert.throws(() => j.recordGroupReplay(groupId, 0, bad), /INVALID_GROUP/);
      assert.equal(j.groupCursor(groupId), 0); assert.deepEqual(j.groupView(groupId).events, []);
    }
    j.recordGroupReplay(groupId, 0, good);
    const id = j.enqueue({ type: "group-chat", groupId, content: "after receipt" });
    assert.ok(j.pending().find(c => c.id === id)!.lamport > 91);
    j.close(); j = f.open();
    assert.equal(j.groupCursor(groupId), 1); assert.equal(j.cursor().seq, 0);
    j.recordCatalog("", { groups: [], nextAfter: null });
    assert.equal(j.groupView(groupId).membership, "left");
    assert.equal(j.groupView(groupId).events[0].payload.content, "private history");
    assert.throws(() => j.recordGroupReplay(groupId, 1, groupPage(groupId, 2)), /GROUP_ACCESS/);
  } finally { j.close(); await f.clean(); }
});

test("one bounded recovery pass fairly polls groups and a lost response preserves original commands and inbox", async () => {
  const f = await fixture(); const j = f.open();
  const ids = Array.from({ length: 9 }, () => randomUUID()).sort(), read: string[] = [], sent: MeetingCommand[] = [];
  let lose = true;
  const transport = {
    async execute(c: MeetingCommand) { sent.push(structuredClone(c)); if (lose) throw new Error("LOST_REPLY"); return outcome; },
    async read() { return meetingPage(f.target.meetingId); },
    async listGroups() { return { groups: ids.map(groupId => ({ groupId, name: "Study", membership: "member" as const })), nextAfter: null }; },
    async readGroup(_p: unknown, groupId: string, after: number) { read.push(groupId); return { ...groupPage(groupId, after + 1), watermark: after + 100 }; }, close() {},
  };
  const session = new ClientSession(j, async () => transport);
  try {
    const id = session.submit({ type: "group-create", name: "Uncertain" }), original = j.pending();
    await assert.rejects(session.step(), /LOST_REPLY/); assert.deepEqual(j.pending(), original);
    lose = false; await session.step();
    assert.equal(sent.at(-1)!.id, id); assert.deepEqual(sent[1], original[0]);
    assert.equal(read.length, 6, "one meeting page, one catalog page, six group pages per pass");
    await session.step(); assert.equal(new Set(read).size, 9, "busy earlier groups must not starve later groups");
    for (const groupId of ids) assert.ok(j.groupCursor(groupId) >= 1);
  } finally { j.close(); await f.clean(); }
});

test("paged catalog recovery preserves unseen groups until the sweep completes and validates scoped progress", async () => {
  const f = await fixture(); let j = f.open();
  const ids = Array.from({ length: 20 }, () => randomUUID()).sort();
  const summaries = ids.map(groupId => ({ groupId, name: "Study", membership: "member" as const }));
  try {
    j.recordCatalog("", { groups: summaries.slice(0, 16), nextAfter: ids[15] });
    j.close(); j = f.open(); assert.equal(j.catalogAfter(), ids[15]);
    assert.throws(() => j.recordCatalog(ids[15], { groups: [summaries[0]], nextAfter: null }), /INVALID_GROUP_CATALOG/);
    j.recordCatalog(ids[15], { groups: summaries.slice(16), nextAfter: null });
    assert.equal(j.groupsView().groups.length, 16); assert.equal(j.groupsView(ids[15]).groups.length, 4);
    j.recordGroupReplay(ids[19], 0, groupPage(ids[19], 1));
    j.recordCatalog("", { groups: summaries.slice(0, 16), nextAfter: ids[15] });
    assert.equal(j.groupView(ids[19]).membership, "member", "a partial scan is not proof of departure");
    j.recordCatalog(ids[15], { groups: [], nextAfter: null });
    assert.equal(j.groupView(ids[19]).membership, "left"); assert.equal(j.groupView(ids[19]).events.length, 1);
    assert.throws(() => j.recordCatalog("", { groups: [{ ...summaries[0], membership: "invited", invitationId: "guessed" }], nextAfter: null }), /INVALID_GROUP_CATALOG/);
  } finally { j.close(); await f.clean(); }
});
