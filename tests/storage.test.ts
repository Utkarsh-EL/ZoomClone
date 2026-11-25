import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { Database, createPool } from "../storage/database.ts";
import {
  MeetingStore,
  type Owner,
  type Authority,
  type MeetingCommand,
} from "../storage/meeting-store.ts";

const connectionString = process.env.ZOOM_STORAGE_ADMIN_URL;
if (!connectionString)
  throw new Error(
    "Run npm run test:storage to provision the isolated PostgreSQL lab",
  );
const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!;

test("database bootstrap is explicit, durable, and bound to the cluster", async () => {
  await assert.rejects(
    Database.open({ connectionString, clusterId, initialize: false }),
    /initializ|identity/i,
  );
  const db = await Database.open({
    connectionString,
    clusterId,
    initialize: true,
  });
  try {
    const again = await Database.open({
      connectionString,
      clusterId,
      initialize: false,
    });
    await again.close();
    await assert.rejects(
      Database.open({
        connectionString,
        clusterId: randomUUID(),
        initialize: true,
      }),
      /cluster/i,
    );
    const health = await db.pool.query(
      "SELECT current_setting('server_version_num')::int AS version, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS sync",
    );
    assert.ok(health.rows[0].version >= 180000);
    assert.equal(health.rows[0].fsync, "on");
    assert.equal(health.rows[0].sync, "on");
    const inspector = await db.pool.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='zoom_inspector'",
    );
    assert.deepEqual(inspector.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    for (const [role, password] of [
      ["zoom_runtime", process.env.ZOOM_STORAGE_RUNTIME_PASSWORD!],
      ["zoom_inspector", process.env.ZOOM_STORAGE_INSPECTOR_PASSWORD!],
    ]) {
      const sql = await db.pool.query(
        "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
        [role, password],
      );
      await db.pool.query(sql.rows[0].sql);
    }
  } finally {
    await db.close();
  }
});

function runtimeURL(): string {
  const url = new URL(connectionString!);
  url.username = "zoom_runtime";
  url.password = process.env.ZOOM_STORAGE_RUNTIME_PASSWORD!;
  return url.href;
}
function owner(meetingId: string = randomUUID(), generation = 1): Owner {
  return {
    clusterId,
    meetingId,
    generation,
    runtimeId: randomUUID(),
    incarnation: randomUUID(),
    attemptId: randomUUID(),
  };
}
function authority(fence: Owner): Authority {
  return { owner: fence, ready: () => true };
}
function participant() {
  return {
    participantId: randomUUID(),
    secret: randomBytes(32).toString("hex"),
  };
}
function command(
  p: ReturnType<typeof participant>,
  operation: MeetingCommand["operation"],
): MeetingCommand {
  return { ...p, id: randomUUID(), lamport: 10, operation };
}

async function fixture() {
  const db = await Database.open({
    connectionString: connectionString!,
    clusterId,
  });
  const runtime = createPool(runtimeURL());
  const store = new MeetingStore(db, runtime);
  const assigned = owner();
  await store.create(assigned.meetingId, "room-" + randomUUID().slice(0, 12));
  await store.install(assigned);
  await store.activate(assigned);
  return {
    db,
    runtime,
    store,
    assigned,
    async stop() {
      await runtime.end();
      await db.close();
    },
  };
}

test("fences reject old owners, same-generation mismatches, late activation and CLOSED recovery", async () => {
  const f = await fixture();
  try {
    const p = participant();
    const join = command(p, { type: "join", name: "Alice" });
    const first = await f.store.execute(authority(f.assigned), join);
    const replacement = { ...owner(f.assigned.meetingId, 2) };
    await f.store.install(replacement);
    await assert.rejects(
      f.store.execute(authority(f.assigned), join),
      /FENCED/,
    );
    await assert.rejects(
      f.store.install({ ...replacement, incarnation: randomUUID() }),
      /FENCED/,
    );
    await assert.rejects(f.store.activate(f.assigned), /FENCED/);
    await f.store.activate(replacement);
    await f.store.activate(replacement);
    assert.deepEqual(
      await f.store.execute(authority(replacement), join),
      first,
    );
    await assert.rejects(
      f.store.execute(authority(replacement), {
        ...join,
        operation: { type: "join", name: "Other" },
      }),
      /ID_CONFLICT/,
    );
    const closure = owner(f.assigned.meetingId, 3);
    await f.store.close(closure);
    await f.store.close(closure);
    await assert.rejects(
      f.store.install(owner(f.assigned.meetingId, 4)),
      /CLOSED/,
    );
    await assert.rejects(f.store.activate(closure), /CLOSED/);
  } finally {
    await f.stop();
  }
});

test("screen handoff commits state, contiguous events, stable outcome and reconciliation intention together", async () => {
  const f = await fixture();
  try {
    const a = participant(),
      b = participant();
    const auth = authority(f.assigned);
    await f.store.execute(auth, command(a, { type: "join", name: "Alice" }));
    await f.store.execute(auth, command(b, { type: "join", name: "Bob" }));
    const requestA = command(a, { type: "request-share" }),
      requestB = command(b, { type: "request-share" });
    await f.store.execute(auth, requestA);
    await f.store.execute(auth, requestB);
    const release = command(a, {
      type: "release-share",
      requestId: requestA.id,
    });
    const outcome = await f.store.execute(auth, release);
    assert.equal(outcome.seq, 5);
    assert.equal(outcome.grantVersion, 2);
    assert.deepEqual(await f.store.execute(auth, release), outcome);
    const read = await f.store.read(auth, a, 0, 3);
    assert.equal(read.state.holder?.participantId, b.participantId);
    assert.equal(read.watermark, 5);
    assert.equal(read.scannedWatermark, 3);
    assert.deepEqual(
      read.events.map((e) => e.seq),
      [1, 2, 3],
    );
    const remainder = await f.store.read(auth, a, read.scannedWatermark, 3);
    assert.deepEqual(
      remainder.events.map((e) => e.seq),
      [4, 5],
    );
    assert.equal(remainder.scannedWatermark, 5);
    const intent = await f.db.pool.query(
      "SELECT desired FROM zoom.media_intentions WHERE meeting_id=$1 AND seq=5",
      [f.assigned.meetingId],
    );
    assert.equal(intent.rows[0].desired.holder.requestId, requestB.id);
    assert.equal(intent.rows[0].desired.grantVersion, 2);
    await assert.rejects(
      f.store.execute(auth, {
        ...release,
        secret: randomBytes(32).toString("hex"),
      }),
      /AUTH/,
    );
    await assert.rejects(
      f.store.read(auth, { ...a, secret: randomBytes(32).toString("hex") }),
      /AUTH/,
    );
    await assert.rejects(
      f.store.execute(
        { ...auth, ready: () => false },
        command(a, { type: "chat", content: "not ready" }),
      ),
      /NOT_READY/,
    );
    assert.equal((await f.store.observe(f.assigned.meetingId)).watermark, 5);
  } finally {
    await f.stop();
  }
});

test("a fence lock blocks mutations but not consistent reads or another meeting", async () => {
  const f = await fixture();
  const lock = await f.db.pool.connect();
  try {
    const p = participant();
    await f.store.execute(
      authority(f.assigned),
      command(p, { type: "join", name: "Alice" }),
    );
    await lock.query("BEGIN");
    await lock.query(
      "SELECT meeting_id FROM zoom.meeting_fences WHERE meeting_id=$1 FOR UPDATE",
      [f.assigned.meetingId],
    );
    const visible = await f.store.read(authority(f.assigned), p);
    assert.equal(visible.watermark, 1);
    const independent = owner();
    await f.store.create(
      independent.meetingId,
      "other-" + randomUUID().slice(0, 12),
    );
    await f.store.install(independent);
    await f.store.activate(independent);
    assert.equal(
      (
        await f.store.execute(
          authority(independent),
          command(participant(), { type: "join", name: "Other" }),
        )
      ).seq,
      1,
    );
    await assert.rejects(
      f.store.execute(
        authority(f.assigned),
        command(p, { type: "chat", content: "blocked" }),
      ),
      (error: any) => error.code === "55P03",
    );
    await lock.query("ROLLBACK");
    assert.equal(
      (
        await f.store.execute(
          authority(f.assigned),
          command(p, { type: "chat", content: "after rollback" }),
        )
      ).seq,
      2,
    );
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
    await f.stop();
  }
});

test("old-command/takeover races have one fenced order and a durable retry outcome", async () => {
  const f = await fixture();
  try {
    const p = participant();
    await f.store.execute(
      authority(f.assigned),
      command(p, { type: "join", name: "Alice" }),
    );
    const old = command(p, { type: "chat", content: "racing takeover" });
    const next = owner(f.assigned.meetingId, 2);
    const [write, transition] = await Promise.allSettled([
      f.store.execute(authority(f.assigned), old),
      f.store.install(next),
    ]);
    assert.equal(transition.status, "fulfilled");
    await f.store.activate(next);
    await assert.rejects(f.store.execute(authority(f.assigned), old), /FENCED/);
    const resolved = await f.store.execute(authority(next), old);
    if (write.status === "fulfilled") assert.deepEqual(resolved, write.value);
    const state = await f.store.read(authority(next), p);
    assert.equal(state.watermark, 2);
    assert.equal(state.events.filter((e) => e.kind === "chat").length, 1);
  } finally {
    await f.stop();
  }
});

test("failed handoff rolls back state, sequence, outcome and media intention", async () => {
  const f = await fixture();
  try {
    const a = participant(),
      b = participant(),
      auth = authority(f.assigned);
    await f.store.execute(auth, command(a, { type: "join", name: "A" }));
    await f.store.execute(auth, command(b, { type: "join", name: "B" }));
    const request = command(a, { type: "request-share" });
    await f.store.execute(auth, request);
    await f.store.execute(auth, command(b, { type: "request-share" }));
    await f.db.pool.query(
      "CREATE FUNCTION zoom.test_reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected outbox write failure'; END $$",
    );
    await f.db.pool.query(
      "CREATE TRIGGER test_reject_intent BEFORE INSERT ON zoom.media_intentions FOR EACH ROW EXECUTE FUNCTION zoom.test_reject_intent()",
    );
    const release = command(a, {
      type: "release-share",
      requestId: request.id,
    });
    await assert.rejects(f.store.execute(auth, release), /injected outbox/);
    const before = await f.store.read(auth, a);
    assert.equal(before.watermark, 4);
    assert.equal(before.state.holder?.participantId, a.participantId);
    assert.equal(before.state.grantVersion, 1);
    assert.equal(before.state.queue[0].participantId, b.participantId);
    const prior = await f.db.pool.query(
      "SELECT FROM zoom.command_outcomes WHERE meeting_id=$1 AND command_id=$2",
      [f.assigned.meetingId, release.id],
    );
    assert.equal(prior.rowCount, 0);
    await f.db.pool.query(
      "DROP TRIGGER test_reject_intent ON zoom.media_intentions",
    );
    assert.equal((await f.store.execute(auth, release)).seq, 5);
  } finally {
    await f.db.pool.query(
      "DROP TRIGGER IF EXISTS test_reject_intent ON zoom.media_intentions",
    );
    await f.db.pool.query("DROP FUNCTION IF EXISTS zoom.test_reject_intent()");
    await f.stop();
  }
});

test("in-flight caller mutation cannot redirect a command outside its locked meeting", async () => {
  const f = await fixture();
  const lock = await f.db.pool.connect();
  const originalId = f.assigned.meetingId;
  try {
    const other = owner();
    await f.store.create(
      other.meetingId,
      "mutation-" + randomUUID().slice(0, 12),
    );
    await f.store.install(other);
    await f.store.activate(other);
    await lock.query("BEGIN");
    await lock.query(
      "SELECT meeting_id FROM zoom.meeting_fences WHERE meeting_id=$1 FOR UPDATE",
      [originalId],
    );
    const mutableOwner = { ...f.assigned };
    const p = participant();
    const submitted = command(p, { type: "join", name: "Original name" });
    const pending = f.store.execute(authority(mutableOwner), submitted);
    void pending.catch(() => {});
    let waiting = false;
    for (let i = 0; i < 30; i++) {
      const observed = await f.db.pool.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name='zoomclone-storage' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'",
      );
      if (observed.rowCount) {
        waiting = true;
        break;
      }
      await delay(10);
    }
    assert.equal(waiting, true, "command never reached its fence lock");
    mutableOwner.meetingId = other.meetingId;
    submitted.operation = { type: "join", name: "Changed after submission" };
    await lock.query("ROLLBACK");
    await pending;
    const original = await f.store.observe(originalId),
      unrelated = await f.store.observe(other.meetingId);
    assert.equal(original.watermark, 1);
    assert.equal(unrelated.watermark, 0, "command escaped its fence lock");
    assert.equal(original.state.members[p.participantId].name, "Original name");
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
    await f.stop();
  }
});
