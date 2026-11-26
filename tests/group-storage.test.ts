import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";
import type { Authority, MeetingCommand, Owner, ParticipantCredential } from "../storage/types.ts";
import type { Operation } from "../storage/engine.ts";

const connectionString = process.env.ZOOM_STORAGE_ADMIN_URL!;
const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!;
if (!connectionString) throw new Error("Run through scripts/storage-check.ts for an isolated PostgreSQL lab");
const participant = (): ParticipantCredential => ({ participantId: randomUUID(), secret: randomBytes(32).toString("hex") });
const command = (p: ParticipantCredential, operation: Operation): MeetingCommand => ({ ...p, id: randomUUID(), lamport: 1, operation });
async function fixture() {
  const db = await Database.open({ connectionString, clusterId, initialize: true });
  const url = new URL(connectionString); url.username = "zoom_runtime"; url.password = process.env.ZOOM_STORAGE_RUNTIME_PASSWORD!;
  const runtime = createPool(url.href), store = new MeetingStore(db, runtime);
  const owner: Owner = { clusterId, meetingId: randomUUID(), generation: 1, runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID() };
  await store.create(owner.meetingId, "groups-" + owner.meetingId.slice(0, 8));
  await store.install(owner); await store.activate(owner);
  const auth: Authority = { owner, ready: () => true };
  const people = [participant(), participant(), participant(), participant()];
  for (const [i, p] of people.entries()) await store.execute(auth, command(p, { type: "join", name: ["Alice", "Bob", "Charlie", "Outsider"][i] }));
  return { db, runtime, store, owner, auth, people, close: async () => { await runtime.end(); await db.close(); } };
}

test("private SQL groups deliver earlier history to multiple joined subscribers and exclude invitees and outsiders", async () => {
  const f = await fixture();
  try {
    const [alice, bob, charlie, outsider] = f.people;
    const create = command(alice, { type: "group-create", name: "Private study" });
    const created = await f.store.execute(f.auth, create), groupId = create.id;
    assert.equal(created.code, "OK"); assert.equal(created.groupId, groupId); assert.equal(created.groupSeq, 1);
    const publicBefore = await f.store.read(f.auth, outsider, 0, 200);
    const send = command(alice, { type: "group-chat", groupId, content: "earlier private message" });
    await f.store.execute(f.auth, send);
    for (const p of [bob, charlie]) {
      const invite = command(alice, { type: "group-invite", groupId, participantId: p.participantId });
      await f.store.execute(f.auth, invite);
      assert.deepEqual((await f.store.listGroups(f.auth, p, "", 16)).groups, [{ groupId, name: "Private study", membership: "invited", invitationId: invite.id }]);
      await assert.rejects(f.store.readGroup(f.auth, p, groupId, 0, 16), /GROUP_ACCESS_DENIED/);
      assert.equal((await f.store.execute(f.auth, command(p, { type: "group-join", groupId, invitationId: invite.id }))).code, "OK");
      const page = await f.store.readGroup(f.auth, p, groupId, 0, 16);
      assert.equal(page.events.some(e => e.payload.content === "earlier private message"), true);
      assert.deepEqual(page.events.map(e => e.seq), Array.from({ length: page.scannedWatermark }, (_, i) => i + 1));
    }
    assert.deepEqual((await f.store.listGroups(f.auth, outsider, "", 16)).groups, []);
    await assert.rejects(f.store.readGroup(f.auth, outsider, groupId, 0, 16), /GROUP_ACCESS_DENIED/);
    const denied = await f.store.execute(f.auth, command(outsider, { type: "group-chat", groupId, content: "intrusion" }));
    assert.equal(denied.code, "GROUP_ACCESS_DENIED"); assert.equal(denied.groupSeq, undefined);
    const publicAfter = await f.store.read(f.auth, outsider, 0, 200);
    assert.deepEqual(publicAfter.events, publicBefore.events);
    assert.deepEqual(publicAfter.state, publicBefore.state);
    assert.equal(publicAfter.watermark, publicBefore.watermark);
    assert.equal(JSON.stringify(publicAfter).includes("Private study"), false);
    assert.equal(JSON.stringify(await f.store.observe(f.owner.meetingId)).includes("private message"), false);
    assert.equal((await f.store.readGroup(f.auth, alice, groupId, 0, 2)).events.length, 2);
    await assert.rejects(f.store.readGroup(f.auth, alice, groupId, 0, 17), /INVALID_CURSOR/);
    await assert.rejects(f.runtime.query("SELECT * FROM zoom.inspect_outcomes"), /permission denied/);
  } finally { await f.close(); }
});

test("leave and meeting departure stop fresh access while original authenticated outcomes survive takeover", async () => {
  const f = await fixture();
  try {
    const [alice, bob] = f.people;
    const create = command(alice, { type: "group-create", name: "Retained" }), groupId = create.id;
    await f.store.execute(f.auth, create);
    const invite = command(alice, { type: "group-invite", groupId, participantId: bob.participantId });
    await f.store.execute(f.auth, invite);
    const join = command(bob, { type: "group-join", groupId, invitationId: invite.id });
    const joined = await f.store.execute(f.auth, join);
    const send = command(bob, { type: "group-chat", groupId, content: "lost reply" });
    const sent = await f.store.execute(f.auth, send);
    const leave = command(bob, { type: "group-leave", groupId });
    const left = await f.store.execute(f.auth, leave);
    await assert.rejects(f.store.readGroup(f.auth, bob, groupId, 0, 16), /GROUP_ACCESS_DENIED/);
    assert.equal((await f.store.execute(f.auth, command(bob, { type: "group-join", groupId, invitationId: invite.id }))).code, "GROUP_ACCESS_DENIED");
    const reinvite = command(alice, { type: "group-invite", groupId, participantId: bob.participantId });
    await f.store.execute(f.auth, reinvite);
    await f.store.execute(f.auth, command(bob, { type: "leave" }));
    await f.store.execute(f.auth, command(bob, { type: "join", name: "Bob" }));
    assert.deepEqual((await f.store.listGroups(f.auth, bob, "", 16)).groups, []);
    assert.equal((await f.store.execute(f.auth, command(bob, { type: "group-join", groupId, invitationId: reinvite.id }))).code, "GROUP_ACCESS_DENIED");
    const owner = { ...f.owner, generation: 2, runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID() };
    await f.store.install(owner); await f.store.activate(owner);
    const next = { owner, ready: () => true };
    await assert.rejects(f.store.readGroup(f.auth, alice, groupId, 0, 16), /FENCED/);
    await assert.rejects(f.store.listGroups({ owner, ready: () => false }, alice, "", 16), /NOT_READY/);
    for (const [c, result] of [[join, joined], [send, sent], [leave, left]] as const) assert.deepEqual(await f.store.execute(next, c), result);
    assert.deepEqual((await f.store.listGroups(next, bob, "", 16)).groups, []);
    await assert.rejects(f.store.execute(next, { ...send, secret: "a".repeat(64) }), /AUTH_REQUIRED/);
    await assert.rejects(f.store.execute(next, { ...send, operation: { type: "group-chat", groupId, content: "changed" } }), /ID_CONFLICT/);
    // Reusing another issuer's command ID cannot return that issuer's outcome.
    assert.equal((await f.store.execute(next, { ...send, ...alice })).code, "OK");
    await assert.rejects(f.store.readGroup(next, bob, groupId, 0, 16), /GROUP_ACCESS_DENIED/);
    const reopened = await Database.open({ connectionString, clusterId });
    try { assert.equal((await new MeetingStore(reopened, f.runtime).readGroup(next, alice, groupId, 0, 16)).events.some(e => e.payload.content === "lost reply"), true); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("group reads and leave serialize on the meeting fence, preventing a later authorization", async () => {
  const f = await fixture();
  const lock = await f.db.pool.connect();
  try {
    const [alice] = f.people, create = command(alice, { type: "group-create", name: "Ordering" });
    await f.store.execute(f.auth, create);
    await lock.query("BEGIN");
    await lock.query("SELECT meeting_id FROM zoom.meeting_fences WHERE meeting_id=$1 FOR UPDATE", [f.owner.meetingId]);
    let finished = false;
    const reading = f.store.readGroup(f.auth, alice, create.id, 0, 16).then(p => { finished = true; return p; });
    // Observe an actual SQL lock waiter rather than treating elapsed time as ordering evidence.
    for (let i = 0; i < 100; i++) {
      const waiting = await lock.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%zoom.meeting_fences%' AND pid<>pg_backend_pid()");
      if (waiting.rows[0].n) break;
      if (i === 99) assert.fail("group read did not wait for the meeting fence");
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(finished, false);
    await lock.query("COMMIT");
    assert.equal((await reading).events.length, 1);
    await f.store.execute(f.auth, command(alice, { type: "group-leave", groupId: create.id }));
    await assert.rejects(f.store.readGroup(f.auth, alice, create.id, 1, 16), /GROUP_ACCESS_DENIED/);
    assert.equal((await f.store.execute(f.auth, command(alice, { type: "group-chat", groupId: create.id, content: "late" }))).code, "GROUP_ACCESS_DENIED");
  } finally { await lock.query("ROLLBACK"); lock.release(); await f.close(); }
});

test("a failed private event rolls back membership, sequence and outcome together", async () => {
  const f = await fixture();
  try {
    const [alice, bob] = f.people, create = command(alice, { type: "group-create", name: "Atomic" });
    await f.store.execute(f.auth, create);
    const invite = command(alice, { type: "group-invite", groupId: create.id, participantId: bob.participantId });
    await f.store.execute(f.auth, invite);
    const joining = command(bob, { type: "group-join", groupId: create.id, invitationId: invite.id });
    await f.db.pool.query("CREATE FUNCTION zoom.test_reject_group() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reject private event'; END $$");
    await f.db.pool.query("CREATE TRIGGER test_reject_group BEFORE INSERT ON zoom.group_events FOR EACH ROW EXECUTE FUNCTION zoom.test_reject_group()");
    await assert.rejects(f.store.execute(f.auth, joining), /reject private event/);
    assert.equal((await f.store.listGroups(f.auth, bob)).groups[0].membership, "invited");
    assert.equal((await f.db.pool.query("SELECT 1 FROM zoom.command_outcomes WHERE meeting_id=$1 AND command_id=$2", [f.owner.meetingId, joining.id])).rowCount, 0);
    await f.db.pool.query("DROP TRIGGER test_reject_group ON zoom.group_events");
    assert.equal((await f.store.execute(f.auth, joining)).groupSeq, 3);
  } finally {
    await f.db.pool.query("DROP TRIGGER IF EXISTS test_reject_group ON zoom.group_events");
    await f.db.pool.query("DROP FUNCTION IF EXISTS zoom.test_reject_group()"); await f.close();
  }
});

test("additive group schema upgrade preserves an existing cluster, commands and meeting replay", async () => {
  const admin = createPool(connectionString), databaseName = "zoom_upgrade_" + randomUUID().replaceAll("-", "");
  const upgradeURL = new URL(connectionString); upgradeURL.pathname = "/" + databaseName;
  let old: ReturnType<typeof createPool> | undefined;
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    old = createPool(upgradeURL.href);
    await old.query("CREATE TABLE public.zoom_schema_migrations(version int PRIMARY KEY,digest text NOT NULL)");
    for (const [i, name] of ["001-meetings.sql", "002-inspection.sql"].entries()) {
      const sql = await readFile(new URL("../storage/migrations/" + name, import.meta.url), "utf8");
      await old.query(sql);
      await old.query("INSERT INTO public.zoom_schema_migrations VALUES($1,$2)", [i + 1, createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex")]);
    }
    await old.query("INSERT INTO zoom.cluster_identity(cluster_id) VALUES($1)", [clusterId]);
    const id = randomUUID(), p = participant();
    await old.query("INSERT INTO zoom.meeting_fences(meeting_id,code,seq) VALUES($1,'upgrade',1)", [id]);
    await old.query("INSERT INTO zoom.meeting_state VALUES($1,$2)", [id, { members: { [p.participantId]: { name: "Before", joined: true } }, holder: null, queue: [], grantVersion: 0 }]);
    await old.query("INSERT INTO zoom.participant_credentials VALUES($1,$2,$3)", [id, p.participantId, createHash("sha256").update(p.secret).digest("hex")]);
    const commandId = randomUUID();
    await old.query("INSERT INTO zoom.events(meeting_id,seq,generation,participant_id,command_id,lamport,kind,payload) VALUES($1,1,1,$2,$3,7,'joined',$4)", [id, p.participantId, commandId, { participantId: p.participantId, name: "Before" }]);
    await old.query("INSERT INTO zoom.command_outcomes VALUES($1,$2,$3,'unchanged',$4)", [id, p.participantId, commandId, { code: "OK", seq: 1, generation: 1, grantVersion: 0 }]);
    const snapshot = async () => Promise.all(["meeting_fences", "meeting_state", "participant_credentials", "events", "command_outcomes"].map(async table => (await old!.query(`SELECT * FROM zoom.${table}`)).rows));
    const before = await snapshot();
    await assert.rejects(Database.open({ connectionString: upgradeURL.href, clusterId }), /migration/);
    const upgraded = await Database.open({ connectionString: upgradeURL.href, clusterId, initialize: true });
    await upgraded.close(); assert.deepEqual(await snapshot(), before);
    assert.equal((await old.query("SELECT max(version) AS version FROM public.zoom_schema_migrations")).rows[0].version, 3);
  } finally {
    await old?.end();
    // Name is generated above, has only identifier characters, and belongs to this test.
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
  }
});
