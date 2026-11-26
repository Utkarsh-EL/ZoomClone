import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import { access, readFile, rename, writeFile } from "node:fs/promises";

const run = promisify(execFile);
test("demo controls start, status, runtime failover, participant recovery, shutdown and retained restart", { timeout: 240000 }, async () => {
  const root = join(process.cwd(), ".local", "demo-rehearsals", randomUUID());
  async function command(...args: string[]) {
    const result = await run(process.execPath, ["scripts/demo.ts", ...args, "--json", "--no-open"], { windowsHide: true,
      env: { ...process.env, ZOOM_DEMO_ROOT: root }, timeout: 100000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout.trim());
  }
  try {
    assert.equal((await command("status")).phase, "stopped");
    const started = await command("start"); assert.equal(started.ready, true);
    assert.equal(started.participants.length, 4); assert.equal(started.discoveryPeers, 4); assert.equal(started.helpers, 3);
    const identities = started.participants.map((p: any) => p.participantId);
    const controlPath = join(root, "control.json"), controlBytes = await readFile(controlPath, "utf8"), control = JSON.parse(controlBytes);
    for (const headers of [{}, { Authorization: `Bearer ${control.token}`, "X-Demo-Run": control.runId, Origin: "http://malicious.example" },
      { Authorization: `Bearer ${control.token}`, "X-Demo-Run": randomUUID() }]) {
      const rejected = await fetch(`http://127.0.0.1:${control.port}/stop`, { method: "POST", headers }); assert.equal(rejected.status, 403); await rejected.body?.cancel();
    }
    // A valid manifest pointing at an unreachable owner must not report a clean stop.
    await writeFile(controlPath, JSON.stringify({ ...control, port: 1 }));
    try { assert.equal((await command("status")).phase, "unreachable"); }
    finally { await writeFile(controlPath, controlBytes); }
    const generation = started.generation;
    const recovered = await command("fail-runtime"); assert.equal(recovered.ready, true); assert.ok(recovered.generation > generation);
    assert.deepEqual(recovered.participants.map((p: any) => p.participantId), identities);
    const crashed = await command("fail-participant", "Bob"); assert.equal(crashed.ready, false);
    const restarted = await command("restart-participant", "Bob"); assert.equal(restarted.ready, true);
    assert.deepEqual(restarted.participants.map((p: any) => p.participantId), identities);
    const stopped = await command("stop"); assert.equal(stopped.phase, "stopped"); assert.deepEqual(stopped.cleanupErrors, []);
    assert.equal((await command("status")).phase, "stopped");
    const resumed = await command("start"); assert.equal(resumed.ready, true); assert.equal(resumed.clusterId, started.clusterId);
    assert.deepEqual(resumed.participants.map((p: any) => p.participantId), identities);
    assert.ok(resumed.generation > generation);
    await command("stop");
    const aliceJournal = join(root, "Alice-0.sqlite"), retainedJournal = aliceJournal + ".retained";
    await rename(aliceJournal, retainedJournal);
    const originalBytes = await readFile(retainedJournal);
    try {
      await assert.rejects(command("start"), /PARTICIPANT_JOURNAL/);
      await assert.rejects(access(aliceJournal));
      assert.deepEqual(await readFile(retainedJournal), originalBytes);
    } finally { await command("stop"); await rename(retainedJournal, aliceJournal); }
  } finally { await command("stop"); }
});
