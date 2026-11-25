import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandResult, type HelperStatus, type MetadataState } from "../coordination/helper-client.ts";
import { buildCoordinator } from "./coordinator-build.ts";
import { CoordinatorLab, until } from "./coordinator-lab.ts";

export async function runCoordinatorScenario() {
  const lab = await CoordinatorLab.create();
  const events: { stage: string; time: string; elapsedMs: number; nodeId?: string }[] = [];
  const started = performance.now();
  const record = (stage: string, nodeId?: string) => events.push({ stage, time: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), nodeId });
  try {
    const initial = await lab.leader();
    const initialIncarnation = initial.incarnation;
    record("leader-ready", initial.id);
    let client = lab.connection(initial);
    const meetingId = randomUUID();
    const command = { id: randomUUID(), kind: "reserve" as const, meetingId, code: "demo-lab" };
    const stableOutcome = await client.call<CommandResult>("apply", { command });
    assert.equal(stableOutcome.code, "OK");
    const runtimeId = randomUUID(), runtimeIncarnation = randomUUID();
    assert.equal((await client.call<CommandResult>("apply", { command: { id: randomUUID(), kind: "register", runtimeId, incarnation: runtimeIncarnation } })).code, "OK");
    const assigned = await client.call<CommandResult>("apply", { command: { id: randomUUID(), kind: "assign", meetingId, runtimeId, incarnation: runtimeIncarnation, attemptId: randomUUID(), expectedGeneration: 0 } });
    assert.equal(assigned.code, "OK");
    assert.equal(assigned.generation, 1);
    record("metadata-committed");
    await lab.crash(initial);
    record("leader-killed", initial.id);
    const replacement = await lab.leader();
    record("replacement-ready", replacement.id);
    client = lab.connection(replacement);
    assert.deepEqual(await client.call("apply", { command }), stableOutcome);
    for (let i = 0; i < 40; i++) {
      const result = await client.call<CommandResult>("apply", { command: { id: randomUUID(), kind: "reserve", meetingId: randomUUID(), code: `snapshot-${i}` } });
      assert.equal(result.code, "OK");
    }
    const snapshot = await client.call<{ applied: number }>("snapshot");
    record("snapshot-forced", replacement.id);
    await lab.start(initial);
    await until("restarted helper snapshot catch-up", async () => {
      const status = await lab.connection(initial).call<HelperStatus>("status");
      return status.applied >= snapshot.applied ? status : undefined;
    });
    const trace = await readFile(initial.logPath, "utf8");
    const snapshotInstalled = trace.split("\n").some((line) => {
      if (!line) return false;
      const event = JSON.parse(line);
      return event.event === "send" && event.kind === "raft.snapshot.reply";
    });
    assert.equal(snapshotInstalled, true);
    record("old-voter-restarted-and-caught-up", initial.id);
    const configuration = (await client.call<HelperStatus>("status")).configuration;
    assert.equal(configuration.voters, 5);
    assert.equal(configuration.quorum, 3);
    const down = [replacement, ...lab.nodes.filter((n) => n !== replacement).slice(0, 2)];
    await Promise.all(down.map((node) => lab.crash(node)));
    record("three-voters-held-down");
    const minority = lab.nodes.find((n) => n.child)!;
    await assert.rejects(lab.connection(minority).call("read"));
    const local = await lab.connection(minority).call<HelperStatus>("status");
    assert.equal(local.configuration.voters, 5);
    assert.equal(local.configuration.quorum, 3);
    record("minority-refused-authoritative-read", minority.id);
    await Promise.all(down.map((node) => lab.start(node)));
    const restored = await lab.leader();
    client = lab.connection(restored);
    assert.deepEqual(await client.call("apply", { command }), stableOutcome);
    record("quorum-restored", restored.id);
    // Full process restart tests disk state rather than only surviving replicas.
    await Promise.all(lab.nodes.map((node) => lab.crash(node)));
    await Promise.all(lab.nodes.map((node) => lab.start(node)));
    const durable = await lab.leader();
    client = lab.connection(durable);
    const state = await client.call<MetadataState>("read");
    assert.equal(state.meetings[meetingId].generation, 1);
    assert.equal(Object.keys(state.meetings).length, 41);
    assert.deepEqual(await client.call("apply", { command }), stableOutcome);
    record("all-processes-restarted-with-retained-metadata", durable.id);
    const result = { root: lab.root, initialLeader: initial.id, replacementLeader: replacement.id, initialIncarnation,
      restartedIncarnation: initial.incarnation, stableOutcome, assignmentGeneration: assigned.generation,
      snapshotInstalled, voters: configuration.voters, quorum: configuration.quorum, minorityRejected: true,
      retainedAfterFullRestart: true, effectiveMeetingOwnershipImplemented: false, events };
    await writeFile(join(lab.root, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    return result;
  } finally { await lab.stop(); }
}

if (import.meta.main) {
  try { buildCoordinator(); console.log(JSON.stringify(await runCoordinatorScenario(), null, 2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
