import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Database, createPool } from "../storage/database.ts";
import {
  MeetingStore,
  type Owner,
  type Authority,
} from "../storage/meeting-store.ts";
import { StorageInspector } from "../storage/inspector.ts";
import { StorageLab } from "../scripts/storage-lab.ts";
import { until } from "../scripts/coordinator-lab.ts";

const root = process.env.ZOOM_STORAGE_LAB_ROOT!;
const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!;
const url = process.env.ZOOM_STORAGE_ADMIN_URL!;
if (!root || !clusterId || !url) throw new Error("Run npm run test:storage");
const observations: Record<string, unknown>[] = [];
function roleURL(role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  return parsed.href;
}
async function fixture() {
  const db = await Database.open({ connectionString: url, clusterId });
  const runtime = createPool(
    roleURL("zoom_runtime", process.env.ZOOM_STORAGE_RUNTIME_PASSWORD!),
  );
  const store = new MeetingStore(db, runtime);
  const owner: Owner = {
    clusterId,
    meetingId: randomUUID(),
    generation: 1,
    runtimeId: randomUUID(),
    incarnation: randomUUID(),
    attemptId: randomUUID(),
  };
  await store.create(owner.meetingId, "fault-" + randomUUID().slice(0, 12));
  await store.install(owner);
  await store.activate(owner);
  const authority: Authority = { owner, ready: () => true };
  const participant = {
    participantId: randomUUID(),
    secret: randomBytes(32).toString("hex"),
  };
  const join = {
    ...participant,
    id: randomUUID(),
    lamport: 10,
    operation: { type: "join" as const, name: "Persistent Alice" },
  };
  const outcome = await store.execute(authority, join);
  return {
    db,
    runtime,
    store,
    owner,
    authority,
    participant,
    join,
    outcome,
    async stop() {
      await runtime.end();
      await db.close();
    },
  };
}

test(
  "paused client loses its idle transaction lock; recovery never bypasses the fence",
  { timeout: 20000 },
  async () => {
    const lab = await StorageLab.resume(root);
    const f = await fixture();
    let holder: string | undefined;
    try {
      const paused = lab.startTransactionHolder(f.owner.meetingId);
      holder = paused.containerId;
      await until(
        "holder idle with an open transaction",
        async () => {
          const row = await f.db.pool.query(
            "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction' AND backend_xid IS NOT NULL",
            [paused.applicationName],
          );
          return row.rowCount ? row.rows[0] : undefined;
        },
        5000,
      );
      const started = performance.now();
      lab.docker(["pause", holder]);
      const next = {
        ...f.owner,
        generation: 2,
        runtimeId: randomUUID(),
        incarnation: randomUUID(),
        attemptId: randomUUID(),
      };
      await assert.rejects(
        f.store.install(next),
        (error: any) => error.code === "55P03",
      );
      assert.equal((await f.store.observe(f.owner.meetingId)).generation, 1);
      await until(
        "server timeout to release paused client's fence",
        async () => {
          await f.store.install(next);
          return true;
        },
        5000,
      );
      await f.store.activate(next);
      assert.equal(
        (await f.store.observe(next.meetingId)).watermark,
        1,
        "uncommitted counter leaked",
      );
      await assert.rejects(f.store.execute(f.authority, f.join), /FENCED/);
      assert.deepEqual(
        await f.store.execute({ owner: next, ready: () => true }, f.join),
        f.outcome,
      );
      observations.push({
        scenario: "paused-client-transaction",
        elapsedMs: Math.round(performance.now() - started),
        oldOwnerRejected: true,
        rollbackPreservedWatermark: 1,
      });
    } finally {
      if (holder) lab.docker(["rm", "--force", holder]);
      await f.stop();
    }
  },
);

test("restricted inspector reads without the fence and cannot expose credentials or write", async () => {
  const f = await fixture();
  const inspectorURL = roleURL(
    "zoom_inspector",
    process.env.ZOOM_STORAGE_INSPECTOR_PASSWORD!,
  );
  const inspector = new StorageInspector(inspectorURL, clusterId);
  const lock = await f.db.pool.connect();
  const raw = createPool(inspectorURL, 1);
  try {
    await lock.query("BEGIN");
    await lock.query(
      "SELECT meeting_id FROM zoom.meeting_fences WHERE meeting_id=$1 FOR UPDATE",
      [f.owner.meetingId],
    );
    const snapshot = await inspector.read(f.owner.meetingId, 10);
    assert.equal(snapshot.ownership.generation, 1);
    assert.equal(snapshot.events.length, 1);
    assert.equal(JSON.stringify(snapshot).includes("verifier"), false);
    assert.equal(
      JSON.stringify(snapshot).includes(f.participant.secret),
      false,
    );
    await assert.rejects(
      raw.query("SELECT verifier FROM zoom.participant_credentials"),
      (error: any) => error.code === "42501",
    );
    await assert.rejects(
      raw.query("DELETE FROM zoom.meeting_state"),
      (error: any) => ["42501", "25006"].includes(error.code),
    );
    await assert.rejects(
      raw.query("CREATE TABLE public.inspector_should_not_write(id int)"),
      (error: any) => ["42501", "25006"].includes(error.code),
    );
    await assert.rejects(inspector.read(f.owner.meetingId, 100000), /limit/i);
    await lock.query("ROLLBACK");
    const flags = await raw.query(
      "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    assert.equal(flags.rows[0].rolsuper, false);
    observations.push({
      scenario: "restricted-inspection",
      generation: 1,
      events: 1,
      verifiersExcluded: true,
      writeDenied: true,
    });
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
    await inspector.close();
    await raw.end();
    await f.stop();
  }
});

test(
  "failed new-lab readiness cleans only its owned service and retains the volume",
  { timeout: 20000 },
  async () => {
    class LostReadinessReply extends StorageLab {
      override compose(args: string[]): string {
        const result = super.compose(args);
        if (args[0] === "up")
          throw new Error(
            "injected readiness reply failure after resource creation",
          );
        return result;
      }
    }
    const failed = new LostReadinessReply();
    try {
      await assert.rejects(failed.start(), /injected readiness/);
      const running = failed.docker([
        "ps",
        "--quiet",
        "--filter",
        `label=org.zoomclone.lab=${failed.project}`,
      ]);
      assert.equal(running, "", "failed startup left an owned service running");
      failed.docker(["volume", "inspect", failed.project + "_meeting-data"]);
      const main = await StorageLab.resume(root);
      assert.ok(
        main.compose(["ps", "--quiet", "postgres"]),
        "cleanup stopped the unrelated main evidence lab",
      );
      observations.push({
        scenario: "failed-startup-cleanup",
        onlyOwnedServicesStopped: true,
        volumeRetained: true,
      });
    } finally {
      failed.stop();
    }
  },
);

test(
  "PostgreSQL restart retains identity, ownership, events and stable outcomes",
  { timeout: 30000 },
  async () => {
    const lab = await StorageLab.resume(root);
    const f = await fixture();
    try {
      const chat = {
        ...f.participant,
        id: randomUUID(),
        lamport: 20,
        operation: {
          type: "chat" as const,
          content: "durable before database restart",
        },
      };
      const outcome = await f.store.execute(f.authority, chat);
      const started = performance.now();
      lab.compose(["restart", "postgres"]);
      lab.compose(["up", "--detach", "--wait", "--wait-timeout", "30"]);
      const replay = await until(
        "same operation outcome after database restart",
        async () => f.store.execute(f.authority, chat),
      );
      assert.deepEqual(replay, outcome);
      const read = await f.store.read(f.authority, f.participant);
      assert.equal(read.watermark, 2);
      assert.equal(read.events.length, 2);
      const reopened = await Database.open({
        connectionString: url,
        clusterId,
        initialize: false,
      });
      await reopened.close();
      observations.push({
        scenario: "database-container-restart",
        elapsedMs: Math.round(performance.now() - started),
        volumeRetained: true,
        watermark: read.watermark,
        originalOutcomePreserved: true,
      });
      await writeFile(
        join(root, "result.json"),
        JSON.stringify(
          {
            project: lab.project,
            clusterId,
            postgres: "18.7",
            image: "postgres:18.7-bookworm",
            liveRaftOwnershipEnabled: false,
            observedAt: new Date().toISOString(),
            observations,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await f.stop();
    }
  },
);
