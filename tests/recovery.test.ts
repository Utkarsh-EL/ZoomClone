import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { CoordinatorLab } from "../scripts/coordinator-lab.ts";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";
import { RecoveryController } from "../coordination/recovery-controller.ts";
import { RuntimeAuthority } from "../coordination/runtime-authority.ts";
import type { CommandResult, MetadataState, Operation, ControlArguments } from "../coordination/helper-client.ts";

const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!;
const connectionString = process.env.ZOOM_STORAGE_ADMIN_URL!;
if (!connectionString) throw new Error("Run npm run test:recovery");

test("activation resumes after every durable boundary and fences a returning owner", { timeout: 90000 }, async () => {
  const lab = await CoordinatorLab.create(3, clusterId);
  const db = await Database.open({ connectionString, clusterId });
  const runtime = createPool(connectionString);
  const store = new MeetingStore(db, runtime);
  try {
    let leader = await lab.leader();
    let helper = lab.connection(leader);
    const apply = async (command: object) => {
      const result = await helper.call<CommandResult>("apply", { command: { id: randomUUID(), ...command } as any });
      assert.equal(result.code, "OK"); return result;
    };
    const meetingId = randomUUID();
    const candidates = [0, 1].map(() => ({ runtimeId: randomUUID(), incarnation: randomUUID(),
      prepare: async (owner: any) => { await store.prepare(owner); } }));
    await apply({ kind: "reserve", meetingId, code: "recover-" + meetingId.slice(0, 8) });
    for (const c of candidates) await apply({ kind: "register", runtimeId: c.runtimeId, incarnation: c.incarnation });
    const stages: string[] = [];
    for (let i = 0; i < 6; i++) {
      const child = fork(new URL("../scripts/recovery-step.ts", import.meta.url), [], { windowsHide: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, ZOOM_RECOVERY_STEP: JSON.stringify({
          clusterId, meetingId, candidates, helper: { clusterId, nodeId: randomUUID(), helperId: leader.id,
            address: leader.address, token: lab.token },
        }) } });
      const closed = once(child, "exit");
      try {
        const message = await Promise.race([once(child, "message").then(([message]) => message),
          closed.then(() => { throw new Error("Recovery child exited before reporting a stage"); }),
          new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Recovery child timed out")), 10000); timer.unref(); }),
        ]);
        if (message.error) throw new Error(message.error);
        stages.push(message.stage);
      } finally { child.kill("SIGKILL"); await closed; }
    }
    assert.deepEqual(stages, ["ASSIGNED", "CREATED", "FENCED", "INTENT", "ACTIVE", "READY"]);
    let state = await helper.call<MetadataState>("read");
    const first = { clusterId, meetingId, generation: 1, ...state.meetings[meetingId].assignment! };
    const authority = new RuntimeAuthority(helper, store, first, { readinessMs: 2000 });
    assert.equal(authority.ready(), false);
    await authority.renew();
    assert.equal(authority.ready(), true);
    const p = { participantId: randomUUID(), secret: randomBytes(32).toString("hex") };
    const join = { ...p, id: randomUUID(), lamport: 10, operation: { type: "join" as const, name: "Retained" } };
    const outcome = await store.execute(authority, join);
    let now = 0;
    const controller = new RecoveryController(helper, store, { clusterId, suspicionMs: 100, now: () => now });
    assert.equal(await controller.tick(meetingId, candidates), "READY");
    now = 101;
    // A committed renewal wins over a timer based on an older revision.
    await authority.renew();
    assert.equal(await controller.tick(meetingId, candidates), "READY");
    now = 202;
    assert.equal(await controller.tick(meetingId, candidates), "ASSIGNED");
    for (let i = 0; i < 4; i++) await controller.tick(meetingId, candidates);
    await assert.rejects(authority.renew(), /GENERATION|ASSIGNMENT|FENCED/);
    assert.equal(authority.ready(), false);
    state = await helper.call<MetadataState>("read");
    assert.equal(state.meetings[meetingId].generation, 2);
    const second = { clusterId, meetingId, generation: 2, ...state.meetings[meetingId].assignment! };
    const replacement = new RuntimeAuthority(helper, store, second);
    await replacement.renew();
    assert.deepEqual(await store.execute(replacement, join), outcome);
    assert.equal((await store.observe(meetingId)).state.members[p.participantId].name, "Retained");
    await assert.rejects(store.activate(first), /FENCED/);
    // A candidate that repeatedly fails preparation must eventually be replaced.
    const failedMeeting = randomUUID();
    await apply({ kind: "reserve", meetingId: failedMeeting, code: "failed-" + failedMeeting.slice(0, 8) });
    let suspicionClock = 0;
    const failing = new RecoveryController(helper, store, { clusterId, suspicionMs: 100, now: () => suspicionClock });
    const broken = candidates.map((c, i) => i === 0 ? { ...c, prepare: async () => { throw new Error("CANDIDATE_CRASHED"); } } : c);
    assert.equal(await failing.tick(failedMeeting, broken), "ASSIGNED");
    assert.equal(await failing.tick(failedMeeting, broken), "CREATED");
    assert.equal(await failing.tick(failedMeeting, broken), "FENCED");
    await assert.rejects(failing.tick(failedMeeting, broken), /CANDIDATE_CRASHED/);
    suspicionClock = 101;
    assert.equal(await failing.tick(failedMeeting, broken), "ASSIGNED");
    let clock = 0;
    const expiring = new RuntimeAuthority(helper, store, second, { readinessMs: 100, now: () => clock });
    await expiring.renew();
    clock = 100;
    assert.equal(expiring.ready(), false, "readiness must expire without traffic");
    // A stop during a slow SQL observation cannot be undone by its late reply.
    const originalObserve = store.observe.bind(store);
    let arrived!: () => void;
    const observing = new Promise<void>(resolve => { arrived = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    store.observe = async id => { const result = await originalObserve(id); arrived(); await waiting; return result; };
    const pending = replacement.renew();
    await observing;
    replacement.stop();
    release();
    await pending;
    assert.equal(replacement.ready(), false, "stopped runtime became ready from an old response");
    store.observe = originalObserve;
    // A replacement leader starts a fresh grace interval, even far past the
    // previous worker's observation time. The loop does not need a dashboard.
    await lab.crash(leader);
    leader = await lab.leader();
    helper = lab.connection(leader);
    let freshClock = 10000;
    const successor = new RecoveryController(helper, store, { clusterId, suspicionMs: 100, now: () => freshClock });
    const abort = new AbortController();
    await successor.run(async () => [meetingId], async () => candidates, { signal: abort.signal,
      report: (_id, result) => { assert.equal(result, "READY"); abort.abort(); } });
    freshClock += 99;
    assert.equal(await successor.tick(meetingId, candidates), "READY");
    const returned = new RuntimeAuthority(helper, store, second);
    await returned.renew();
    // An established meeting may never be recreated from empty storage.
    await db.pool.query("DELETE FROM zoom.media_intentions WHERE meeting_id=$1", [meetingId]);
    await db.pool.query("DELETE FROM zoom.command_outcomes WHERE meeting_id=$1", [meetingId]);
    await db.pool.query("DELETE FROM zoom.events WHERE meeting_id=$1", [meetingId]);
    await db.pool.query("DELETE FROM zoom.participant_credentials WHERE meeting_id=$1", [meetingId]);
    await db.pool.query("DELETE FROM zoom.meeting_state WHERE meeting_id=$1", [meetingId]);
    await assert.rejects(successor.tick(meetingId, candidates), /MISSING_DURABLE_STATE/);
    // Minority observations cannot refresh readiness.
    for (const node of lab.nodes.filter(n => n.id !== leader.id && n.child)) await lab.crash(node);
    await assert.rejects(returned.renew());
    assert.equal(returned.ready(), false);
  } finally { await runtime.end(); await db.close(); await lab.stop(); }
});

test("lost replies after each Raft and SQL commit resolve the same attempt", { timeout: 45000 }, async () => {
  const lab = await CoordinatorLab.create(1, clusterId);
  const db = await Database.open({ connectionString, clusterId });
  const pool = createPool(connectionString);
  const store = new MeetingStore(db, pool);
  try {
    const helper = lab.connection(await lab.leader());
    const meetingId = randomUUID();
    const runtimeId = randomUUID(), incarnation = randomUUID();
    for (const command of [
      { id: randomUUID(), kind: "reserve" as const, meetingId, code: "uncertain-" + meetingId.slice(0, 8) },
      { id: randomUUID(), kind: "register" as const, runtimeId, incarnation },
    ]) assert.equal((await helper.call<CommandResult>("apply", { command })).code, "OK");
    // Faults lose successful replies from real helpers/transactions. They do
    // not synthesize results or roll back the already committed transition.
    const lost = new Set(["assign", "activation-intent", "confirm-ready"]);
    const originalCall = helper.call.bind(helper);
    helper.call = async <T>(operation: Operation, args: ControlArguments = {}): Promise<T> => {
      const result = await originalCall<T>(operation, args);
      if (args.command && lost.delete(args.command.kind)) throw new Error("REPLY_LOST");
      return result;
    };
    for (const method of ["create", "install", "activate"] as const) {
      const original = store[method].bind(store) as (...args: any[]) => Promise<void>;
      let once = true;
      (store as any)[method] = async (...args: any[]) => {
        await original(...args);
        if (once) { once = false; throw new Error("REPLY_LOST"); }
      };
    }
    const candidates = [{ runtimeId, incarnation, prepare: async (owner: any) => { await store.prepare(owner); } }];
    for (let i = 0; i < 6; i++) {
      await assert.rejects(new RecoveryController(helper, store, { clusterId }).tick(meetingId, candidates), /REPLY_LOST/);
      const current = await helper.call<MetadataState>("read");
      const meeting = current.meetings[meetingId];
      assert.equal(meeting.generation, 1, "retry allocated an unnecessary new generation");
      if (meeting.assignment?.phase !== "READY") {
        const gate = new RuntimeAuthority(helper, store, { clusterId, meetingId, generation: 1, ...meeting.assignment! });
        await assert.rejects(gate.renew(), /NOT_READY/);
        assert.equal(gate.ready(), false);
      }
    }
    assert.equal(await new RecoveryController(helper, store, { clusterId }).tick(meetingId, candidates), "READY");
    const state = await helper.call<MetadataState>("read");
    const gate = new RuntimeAuthority(helper, store, { clusterId, meetingId, generation: 1, ...state.meetings[meetingId].assignment! });
    await gate.renew();
    assert.equal(gate.ready(), true);
    // A lost renewal reply cannot retain earlier readiness, even though the
    // renewal committed and a later read can resolve its revision.
    lost.add("renew");
    await assert.rejects(gate.renew(), /REPLY_LOST/);
    assert.equal(gate.ready(), false);
    await gate.renew();
    assert.equal(gate.ready(), true);
  } finally { await pool.end(); await db.close(); await lab.stop(); }
});
