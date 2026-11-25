import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { CoordinatorLab, until } from "../scripts/coordinator-lab.ts";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore, type MeetingCommand } from "../storage/meeting-store.ts";
import { RecoveryController, ownerFor } from "../coordination/recovery-controller.ts";
import { RemoteRuntime, availableRuntimes } from "../coordination/runtime-rpc.ts";
import type { CommandResult, MetadataState } from "../coordination/helper-client.ts";
import { startMeetingRuntime } from "../coordination/runtime-service.ts";
import { ControlWire } from "../coordination/wire.ts";

const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!;
const connectionString = process.env.ZOOM_STORAGE_ADMIN_URL!;
if (!connectionString) throw new Error("Run npm run test:runtimes");

test("independent remote runtimes renew, survive leader change and recover retained outcomes after two crashes", { timeout: 120000 }, async () => {
  const lab = await CoordinatorLab.create(3, clusterId);
  const db = await Database.open({ connectionString, clusterId });
  const pool = createPool(connectionString), store = new MeetingStore(db, pool);
  const callerId = randomUUID(), identity = { clusterId, nodeId: callerId, incarnation: randomUUID() };
  const wire = new ControlWire(identity);
  const runtimeURL = new URL(connectionString); runtimeURL.username = "zoom_runtime"; runtimeURL.password = process.env.ZOOM_STORAGE_RUNTIME_PASSWORD!;
  const children: ChildProcess[] = [];
  const closed = new Map<ChildProcess, Promise<unknown>>();
  async function request(child: ChildProcess, operation: string, body: object = {}): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Runtime evidence request timed out")), 10000);
      const receive = (message: any) => { if (message.id === id) done(message.error ? new Error(`${operation}: ${message.error}`) : undefined, message.result); };
      const exit = () => done(new Error("Runtime exited"));
      const done = (error?: Error, value?: unknown) => { clearTimeout(timer); child.removeListener("message", receive); child.removeListener("exit", exit); error ? reject(error) : resolve(value); };
      child.on("message", receive); child.once("exit", exit);
      child.send({ id, operation, ...body }, error => { if (error) done(error); });
    });
  }
  async function start(runtimeId: string = randomUUID(), expectedRevision = 0) {
    const incarnation = randomUUID(), token = randomBytes(32).toString("hex");
    const config = { clusterId, runtimeId, incarnation, expectedRevision, intervalMs: 60, readinessMs: 1200,
      address: "127.0.0.1:0", callers: [callerId], token, helperToken: lab.token,
      helpers: lab.nodes.map(n => ({ helperId: n.id, address: n.address })), helperTimeoutMs: 300,
      connectionString, runtimeConnectionString: runtimeURL.href };
    const child = fork(new URL("./fixtures/runtime-child.ts", import.meta.url), [], { windowsHide: true,
      stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, ZOOM_RUNTIME_CONFIG: JSON.stringify(config) } });
    children.push(child); closed.set(child, once(child, "exit"));
    const started = await Promise.race([
      once(child, "message").then(([message]) => { if (message.error) throw new Error(message.error); return message; }),
      closed.get(child)!.then(() => { throw new Error("Runtime exited before startup"); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Runtime startup timed out")), 10000); timer.unref(); }),
    ]);
    const remote = new RemoteRuntime({ clusterId, runtimeId, incarnation, address: started.address, token, identity, timeoutMs: 500 }, wire);
    await until("runtime registration", async () => await remote.available() ? true : undefined);
    return { child, remote };
  }
  async function crash(child: ChildProcess) { child.kill("SIGKILL"); await closed.get(child); }
  try {
    let leader = await lab.leader(), helper = lab.connection(leader);
    const nodes = [await start(), await start(), await start()];
    const routes = nodes.map(n => n.remote);
    const meetingId = randomUUID();
    assert.equal((await helper.call<CommandResult>("apply", { command: { id: randomUUID(), kind: "reserve", meetingId, code: "remote-" + meetingId.slice(0, 8) } })).code, "OK");
    let controller = new RecoveryController(helper, store, { clusterId, suspicionMs: 700 });
    await until("remote activation", async () => await controller.tick(meetingId, await availableRuntimes(routes)) === "READY" ? true : undefined);
    await until("scheduled readiness", async () => await request(nodes[0].child, "ready", { meetingId }) ? true : undefined);
    let state = await helper.call<MetadataState>("read");
    const revision = state.meetings[meetingId].assignment!.renewalRevision;
    await until("multiple autonomous renewals", async () => (await helper.call<MetadataState>("read")).meetings[meetingId].assignment!.renewalRevision >= revision + 3 ? true : undefined);
    const join: MeetingCommand = { id: randomUUID(), participantId: randomUUID(), secret: randomBytes(32).toString("hex"), lamport: 10, operation: { type: "join", name: "Retained remote" } };
    // A ready probe is an observation, not a reservation across the next refresh.
    const outcome = await until("original command outcome", () => request(nodes[0].child, "execute", { meetingId, command: join }));
    await lab.crash(leader);
    leader = await lab.leader(); helper = lab.connection(leader);
    controller = new RecoveryController(helper, store, { clusterId, suspicionMs: 700 });
    state = await helper.call<MetadataState>("read");
    const prior = state.meetings[meetingId].assignment!.renewalRevision;
    await until("renewal through replacement leader", async () => (await helper.call<MetadataState>("read")).meetings[meetingId].assignment!.renewalRevision > prior ? true : undefined);
    assert.equal(await controller.tick(meetingId, await availableRuntimes(routes)), "READY");
    const first = ownerFor(clusterId, state.meetings[meetingId]);
    await crash(nodes[0].child); await crash(nodes[1].child);
    await until("takeover on sole remaining runtime", async () => {
      const result = await controller.tick(meetingId, await availableRuntimes(routes));
      const current = await helper.call<MetadataState>("read");
      return result === "READY" && current.meetings[meetingId].generation === 2 ? true : undefined;
    }, 20000);
    await until("survivor readiness", async () => await request(nodes[2].child, "ready", { meetingId }) ? true : undefined);
    assert.deepEqual(await until("retained command retry", () => request(nodes[2].child, "execute", { meetingId, command: join })), outcome);
    assert.equal((await store.observe(meetingId)).state.members[join.participantId].name, "Retained remote");
    await assert.rejects(store.activate(first), /FENCED/);
    // The restarted process keeps runtime ID, gets a new incarnation and uses
    // the observed registration revision supplied by its provisioner.
    const restarted = await start(nodes[0].remote.runtimeId, 1);
    assert.notEqual(restarted.remote.incarnation, first.incarnation);
    assert.equal(await request(restarted.child, "ready", { meetingId }), false);
    await assert.rejects(restarted.remote.prepare({ ...first, incarnation: restarted.remote.incarnation }), /ASSIGNMENT_CONFLICT/);
    assert.equal(await nodes[0].remote.available(), false);
    // Quorum refusal must clear the surviving runtime's local service gate.
    for (const node of lab.nodes.filter(n => n.id !== leader.id && n.child)) await lab.crash(node);
    await until("runtime readiness withdrawn without quorum", async () => !await request(nodes[2].child, "ready", { meetingId }) ? true : undefined);
    await assert.rejects(request(nodes[2].child, "execute", { meetingId, command: { ...join, id: randomUUID() } }), /NOT_READY/);
  } finally {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    await Promise.allSettled([...closed.values()]);
    await pool.end(); await db.close(); await lab.stop();
  }
});

test("terminal registration conflict releases the runtime listener and database pools", { timeout: 15000 }, async () => {
  const lab = await CoordinatorLab.create(1, clusterId);
  let runtime: Awaited<ReturnType<typeof startMeetingRuntime>> | undefined;
  try {
    const helper = lab.connection(await lab.leader());
    const runtimeId = randomUUID();
    assert.equal((await helper.call<CommandResult>("apply", { command: { id: randomUUID(), kind: "register", runtimeId, incarnation: randomUUID() } })).code, "OK");
    runtime = await startMeetingRuntime({ clusterId, runtimeId, expectedRevision: 0,
      address: "127.0.0.1:0", callers: [randomUUID()], token: randomBytes(32).toString("hex"), helperToken: lab.token,
      helpers: lab.nodes.map(n => ({ helperId: n.id, address: n.address })), connectionString, runtimeConnectionString: connectionString,
    }, () => {});
    await assert.rejects(runtime.done, /REGISTRATION_REVISION_CONFLICT/);
    const address = runtime.address;
    await until("terminal registration closes listener", async () => {
      try { await fetch(`http://${address}/v1/runtime`, { signal: AbortSignal.timeout(200) }); return undefined; }
      catch { return true; }
    }, 1000);
  } finally { await runtime?.close(); await lab.stop(); }
});
