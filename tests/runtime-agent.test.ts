import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { RuntimeAgent } from "../coordination/runtime-agent.ts";
import { LeaderRoute } from "../coordination/helper-route.ts";
import type { ControlArguments, HelperAccess, MetadataCommand, MetadataState, Operation } from "../coordination/helper-client.ts";
import type { Owner, Observation } from "../storage/meeting-store.ts";
import { emptyState } from "../storage/engine.ts";

function fixture() {
  const clusterId = randomUUID(), runtimeId = randomUUID(), incarnation = randomUUID(), meetingId = randomUUID();
  const owner: Owner = { clusterId, runtimeId, incarnation, meetingId, generation: 1, attemptId: randomUUID() };
  const state: MetadataState = { version: 1, cluster: clusterId, highWater: 0, runtimes: {}, meetings: {
    [meetingId]: { id: meetingId, code: "scheduled", generation: 1, assignment: { runtimeId, incarnation,
      attemptId: owner.attemptId, phase: "READY", renewalRevision: 0 } },
  } };
  const commands: MetadataCommand[] = [];
  const outcomes = new Map<string, object>();
  let loseRegistration = false;
  const helper: HelperAccess = { async call<T>(operation: Operation, args: ControlArguments = {}): Promise<T> {
    if (operation === "read") return structuredClone(state) as T;
    assert.equal(operation, "apply");
    const c = args.command!;
    commands.push(structuredClone(c));
    let result = outcomes.get(c.id);
    if (!result) {
      if (c.kind === "register") {
        if ((state.runtimes[runtimeId]?.revision ?? 0) !== c.expectedRevision) result = { code: "REVISION_CONFLICT" };
        else { state.runtimes[runtimeId] = { id: runtimeId, incarnation, revision: c.expectedRevision! + 1 }; result = { code: "OK" }; }
      } else {
        assert.equal(c.kind, "renew");
        const a = state.meetings[meetingId].assignment!;
        assert.equal(c.expectedRevision, a.renewalRevision);
        a.renewalRevision++;
        result = { code: "OK" };
      }
      outcomes.set(c.id, result);
    }
    if (c.kind === "register" && loseRegistration) { loseRegistration = false; throw new Error("REPLY_LOST"); }
    return result as T;
  } };
  const store = { async prepare() { return {} as Observation; }, async observe() { return { ...owner, phase: "ACTIVE", code: "scheduled", watermark: 0, state: emptyState(), observedAt: "" } as Observation; } };
  const options = { clusterId, runtimeId, incarnation, expectedRevision: 0, intervalMs: 10, readinessMs: 1000 };
  return { owner, state, helper, store, options, commands, loseRegistration: () => { loseRegistration = true; } };
}

test("runtime registers once and renews READY assignments without controller traffic", async () => {
  const f = fixture();
  const agent = new RuntimeAgent(f.helper, f.store, f.options);
  const abort = new AbortController();
  const running = agent.run({ signal: abort.signal, report: (_id, error) => { if (error) throw error; } });
  try {
    for (let i = 0; i < 100 && f.state.meetings[f.owner.meetingId].assignment!.renewalRevision < 3; i++) await delay(5);
    assert.ok(f.state.meetings[f.owner.meetingId].assignment!.renewalRevision >= 3);
    assert.equal(f.commands.filter(c => c.kind === "register").length, 1);
    assert.equal(agent.authority(f.owner.meetingId)?.ready(), true);
  } finally { abort.abort(); await running; }
  assert.equal(agent.authority(f.owner.meetingId)?.ready() ?? false, false);
});

test("uncertain registration retries the identical command and revocation stops renewal", async () => {
  const f = fixture(); f.loseRegistration();
  const agent = new RuntimeAgent(f.helper, f.store, f.options);
  await assert.rejects(agent.tick(), /REPLY_LOST/);
  assert.equal(agent.registered, false);
  await agent.tick();
  assert.deepEqual(f.commands[0], f.commands[1]);
  assert.equal(agent.registered, true);
  const authority = agent.authority(f.owner.meetingId)!;
  assert.equal(authority.ready(), true);
  f.state.runtimes[f.owner.runtimeId] = { id: f.owner.runtimeId, incarnation: randomUUID(), revision: 2 };
  await assert.rejects(agent.tick(), /REGISTRATION_REVOKED/);
  assert.equal(authority.ready(), false);
  const n = f.commands.length;
  await assert.rejects(agent.tick(), /STOPPED/);
  assert.equal(f.commands.length, n, "a replaced process must not register again");
});

test("stop during preparation cannot install a late authority", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(r => { entered = r; });
  const waiting = new Promise<void>(r => { release = r; });
  f.store.prepare = async () => { entered(); await waiting; return {} as Observation; };
  const agent = new RuntimeAgent(f.helper, f.store, f.options);
  const tick = agent.tick();
  await arrived;
  agent.stop(); release();
  await assert.rejects(tick, /STOPPED/);
  assert.equal(agent.authority(f.owner.meetingId), undefined);
  assert.equal(f.commands.filter(c => c.kind === "renew").length, 0);
});

test("a failed refresh clears all readiness and remote preparation checks committed identity", async () => {
  const f = fixture();
  const agent = new RuntimeAgent(f.helper, f.store, f.options);
  await agent.tick();
  await assert.rejects(agent.prepare({ ...f.owner, attemptId: randomUUID() }), /ASSIGNMENT_CONFLICT/);
  await assert.rejects(agent.prepare({ ...f.owner, incarnation: randomUUID() }), /RUNTIME_MISMATCH/);
  const authority = agent.authority(f.owner.meetingId)!;
  f.helper.call = async () => { throw new Error("QUORUM_LOST"); };
  await assert.rejects(agent.tick(), /QUORUM_LOST/);
  assert.equal(authority.ready(), false);
  agent.stop();
});

test("configured leader routes retry reads and never replay an uncertain mutation", async () => {
  let writes = 0, reads = 0;
  const dead: HelperAccess = { async call() { throw new Error("UNAVAILABLE"); } };
  const live: HelperAccess = { async call<T>(operation: Operation): Promise<T> {
    if (operation === "read") { reads++; return { cluster: "ok" } as T; }
    writes++; throw new Error("COMMITTED_REPLY_LOST");
  } };
  const route = new LeaderRoute([dead, live]);
  assert.deepEqual(await route.call("read"), { cluster: "ok" });
  await assert.rejects(route.call("apply", { command: { id: randomUUID(), kind: "register" } }), /COMMITTED_REPLY_LOST/);
  assert.equal(writes, 1);
  await route.call("read");
  assert.equal(reads, 2);
});

test("terminal registration errors reach the run-loop report and completion promise", async () => {
  const f = fixture();
  f.state.runtimes[f.owner.runtimeId] = { id: f.owner.runtimeId, incarnation: randomUUID(), revision: 1 };
  const agent = new RuntimeAgent(f.helper, f.store, f.options);
  const errors: string[] = [];
  await assert.rejects(agent.run({ signal: new AbortController().signal, report: (_id, error) => { if (error) errors.push(error.message); } }), /REGISTRATION_REVISION_CONFLICT/);
  assert.deepEqual(errors, ["REGISTRATION_REVISION_CONFLICT"]);
  assert.equal(agent.registered, false);
});
