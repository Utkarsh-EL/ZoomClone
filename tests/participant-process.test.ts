import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import { CoordinatorLab, until } from "../scripts/coordinator-lab.ts";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";
import { RecoveryController, ownerFor } from "../coordination/recovery-controller.ts";
import { RemoteRuntime, availableRuntimes } from "../coordination/runtime-rpc.ts";
import { ParticipantConnection } from "../client/participant-transport.ts";
import { SessionJournal } from "../client/session-journal.ts";
import type { CommandResult, MetadataState } from "../coordination/helper-client.ts";
import { ControlWire } from "../coordination/wire.ts";

const clusterId = process.env.ZOOM_STORAGE_CLUSTER_ID!, connectionString = process.env.ZOOM_STORAGE_ADMIN_URL!;
if (!connectionString) throw new Error("Run npm run test:runtimes");

function jsonProcess(script: string, env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
  const lines = createInterface({ input: child.stdout });
  const messages: any[] = [];
  lines.on("line", line => { try { messages.push(JSON.parse(line)); if (messages.length > 200) messages.shift(); } catch {} });
  return { child, messages, exited, async crash() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; lines.close(); },
    async event(event: string) { return until(event, async () => {
      const value = messages.find(m => m.event === event); if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Process exited: ${stderr}`); return undefined;
    }); },
    async request(action: string, body: object = {}) {
      const id = randomUUID(); child.stdin.write(JSON.stringify({ id, action, ...body }) + "\n");
      return until(`participant ${action}`, async () => {
        const result = messages.find(m => m.id === id); if (!result) return undefined;
        if (result.error) throw new Error(result.error); return result.result;
      }, 3000);
    } };
}

async function attachBrowser(process: ReturnType<typeof jsonProcess>) {
  const started = await process.event("participant.started"), url = new URL(started.browser.url);
  const wire = new ControlWire({ clusterId, nodeId: randomUUID(), incarnation: randomUUID() });
  const socket = new WebSocket(`ws://${url.host}/v1/attachment`, "zoom.attachment.v1", { headers: { Origin: url.origin } });
  socket.on("error", () => {}); await once(socket, "open");
  let attachment: unknown;
  async function call(action: string, body: object = {}): Promise<any> {
    const packet = wire.request({ version: 1, action, ...(attachment ? { attachment } : {}), ...body });
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("ATTACHMENT_TIMEOUT")); }, 2000);
      function receive(raw: WebSocket.RawData) {
        const p = JSON.parse(raw.toString()); if (p.requestId !== packet.requestId || p.kind !== "control.reply") return;
        clearTimeout(timer); socket.off("message", receive);
        const reply = wire.receive(p, packet.requestId, started.participantId);
        reply.error ? reject(new Error(reply.error.code)) : resolve(reply.body);
      }
      socket.on("message", receive);
    });
    socket.send(JSON.stringify(packet)); return result;
  }
  attachment = (await call("attach", { token: url.hash.slice(1) })).attachment;
  return { call, close: () => socket.terminate() };
}

test("production agents retain uncertain join/chat through process restart and two runtime crashes, then replay and refuse quorum loss", { timeout: 120000 }, async () => {
  const lab = await CoordinatorLab.create(3, clusterId), db = await Database.open({ clusterId, connectionString });
  const pool = createPool(connectionString), store = new MeetingStore(db, pool);
  const processes: ReturnType<typeof jsonProcess>[] = [];
  const identity = { clusterId, nodeId: randomUUID(), incarnation: randomUUID() };
  const runtimeURL = new URL(connectionString); runtimeURL.username = "zoom_runtime"; runtimeURL.password = process.env.ZOOM_STORAGE_RUNTIME_PASSWORD!;
  const helpers = lab.nodes.map(n => ({ helperId: n.id, address: n.address }));
  const helper = lab.connection(await lab.leader());
  let proxy: WebSocketServer | undefined;
  try {
    async function runtime(runtimeId = randomUUID(), expectedRevision = 0) {
      const token = randomBytes(32).toString("hex"), participantToken = randomBytes(32).toString("hex");
      const process = jsonProcess("scripts/meeting-runtime.ts", { ZOOM_RUNTIME_CONFIG: JSON.stringify({ clusterId, runtimeId, expectedRevision,
        intervalMs: 60, readinessMs: 1200, address: "127.0.0.1:0", callers: [identity.nodeId], token, helpers,
        helperToken: lab.token, helperTimeoutMs: 300, connectionString, runtimeConnectionString: runtimeURL.href,
        participants: { address: "127.0.0.1:0", token: participantToken } }) });
      processes.push(process);
      const started = await process.event("runtime.started");
      const route = { runtimeId, incarnation: started.incarnation, address: started.participantAddress, token: participantToken };
      const remote = new RemoteRuntime({ ...route, clusterId, address: started.address, token, identity, timeoutMs: 500 });
      await until("runtime registered", async () => await remote.available() ? true : undefined);
      return { process, route, remote };
    }
    const nodes = [await runtime(), await runtime(), await runtime()], remotes = nodes.map(n => n.remote);
    const meetingId = randomUUID(), code = "session-" + meetingId.slice(0, 8);
    assert.equal((await helper.call<CommandResult>("apply", { command: { id: randomUUID(), kind: "reserve", meetingId, code } })).code, "OK");
    const controller = new RecoveryController(helper, store, { clusterId, suspicionMs: 700 });
    await until("meeting active", async () => await controller.tick(meetingId, await availableRuntimes(remotes)) === "READY" ? true : undefined);
    const oldOwner = ownerFor(clusterId, (await helper.call<MetadataState>("read")).meetings[meetingId]);

    // Test-only relay drops a committed reply and blocks further attempts until
    // the agent is killed. The domain command itself uses production sockets.
    let dropType = "join", blocked = false, drops = 0;
    proxy = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
    await once(proxy, "listening");
    proxy.on("connection", downstream => {
      downstream.on("error", () => {});
      if (blocked) { downstream.terminate(); return; }
      const upstream = new WebSocket(`ws://${nodes[0].route.address}/v1/participant`, "zoom.participant.v1", { headers: { Authorization: `Bearer ${nodes[0].route.token}` } });
      upstream.on("error", () => downstream.terminate()); downstream.on("close", () => upstream.terminate()); upstream.on("close", () => downstream.terminate());
      const requests = new Map<string, string>(), queued: string[] = [];
      upstream.on("open", () => { for (const data of queued) upstream.send(data); queued.length = 0; });
      downstream.on("message", raw => {
        const data = raw.toString(), frame = JSON.parse(data); requests.set(frame.requestId, frame.body.command?.operation?.type);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else queued.push(data);
      });
      upstream.on("message", data => {
        const reply = JSON.parse(data.toString());
        if (!reply.error && requests.get(reply.requestId) === dropType) { blocked = true; drops++; dropType = ""; downstream.terminate(); upstream.terminate(); }
        else if (downstream.readyState === WebSocket.OPEN) downstream.send(data.toString());
      });
    });
    const proxyAddress = proxy.address() as { port: number };
    const routes = nodes.map((n, i) => ({ ...n.route, ...(i === 0 ? { address: `127.0.0.1:${proxyAddress.port}` } : {}) }));
    const aliceTarget = { clusterId, meetingId, name: "Alice" }, alicePath = join(lab.root, "alice.sqlite");
    async function agent(name: string, sessionPath: string) {
      const process = jsonProcess("scripts/participant-agent.ts", { ZOOM_PARTICIPANT_CONFIG: JSON.stringify({ sessionPath, target: { clusterId, meetingId, name },
        helpers, helperToken: lab.token, routes, helperTimeoutMs: 300, timeoutMs: 500, intervalMs: 60, browser: { address: "127.0.0.1:0" } }) });
      processes.push(process); await process.event("participant.started"); return process;
    }
    let alice = await agent("Alice", alicePath);
    await until("join reply dropped after commit", async () => drops === 1 ? true : undefined);
    await alice.crash();
    let journal = SessionJournal.open(alicePath, aliceTarget);
    const originalJoin = journal.pending()[0], aliceId = originalJoin.participantId;
    assert.equal(originalJoin.operation.type, "join"); journal.close();
    assert.equal((await store.observe(meetingId)).state.members[aliceId].joined, true);
    blocked = false; alice = await agent("Alice", alicePath);
    await until("resumed same join", async () => (await alice.request("view")).connection === "connected" ? true : undefined);
    const bob = await agent("Bob", join(lab.root, "bob.sqlite"));
    await until("Bob joined", async () => (await bob.request("view")).connection === "connected" ? true : undefined);
    let browser = await attachBrowser(alice);
    const send = await browser.call("submit", { operation: { type: "chat", content: "before failure" } });
    browser.close(); browser = await attachBrowser(alice);
    try {
      const view = (await browser.call("view")).view;
      assert.equal(view.participantId, aliceId);
      assert.ok(view.commands.some((c: any) => c.id === send.commandId));
    } finally { browser.close(); }
    await until("both clients replay first chat", async () => (await bob.request("view")).events.some((e: any) => e.payload.content === "before failure") ? true : undefined);
    assert.ok(send.commandId);
    dropType = "chat";
    const lost = await alice.request("submit", { operation: { type: "chat", content: "committed without reply" } });
    await until("chat reply dropped after commit", async () => drops === 2 ? true : undefined);
    browser = await attachBrowser(alice);
    try { assert.equal((await browser.call("view")).view.commands.find((c: any) => c.id === lost.commandId).outcome, null); }
    finally { browser.close(); }
    await alice.crash();
    journal = SessionJournal.open(alicePath, aliceTarget);
    assert.equal(journal.pending()[0].id, lost.commandId);
    const priorCursor = journal.cursor().seq; journal.close();
    await nodes[0].process.crash(); await nodes[1].process.crash();
    await until("takeover on survivor", async () => {
      const result = await controller.tick(meetingId, await availableRuntimes(remotes));
      const current = await helper.call<MetadataState>("read");
      return result === "READY" && current.meetings[meetingId].generation === 2 ? true : undefined;
    }, 25000);
    await bob.request("submit", { operation: { type: "chat", content: "while Alice was offline" } });
    await until("offline history committed", async () => (await store.observe(meetingId)).watermark === 5 ? true : undefined);
    alice = await agent("Alice", alicePath);
    const recovered = await until("Alice durable replay through survivor", async () => {
      const view = await alice.request("view"); return view.cursor.seq === 5 && view.connection === "connected" ? view : undefined;
    });
    assert.equal(recovered.participantId, aliceId);
    assert.ok(recovered.cursor.seq > priorCursor);
    assert.deepEqual(recovered.events.map((e: any) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(recovered.commands.find((c: any) => c.id === lost.commandId).outcome.generation, 1);
    browser = await attachBrowser(alice);
    try {
      const browserView = (await browser.call("view")).view;
      assert.equal(browserView.participantId, aliceId);
      assert.deepEqual(browserView.commands, recovered.commands);
      assert.deepEqual(browserView.events, recovered.events);
      assert.equal(browserView.cursor.subscriptionRevision, 0);
    } finally { browser.close(); }
    assert.equal(Object.keys(recovered.observation.state.members).length, 2);
    assert.equal((await pool.query("SELECT count(*) AS n FROM zoom.command_outcomes WHERE meeting_id=$1 AND participant_id=$2 AND command_id=$3", [meetingId, aliceId, lost.commandId])).rows[0].n, "1");
    await assert.rejects(store.execute({ owner: oldOwner, ready: () => true }, { ...originalJoin, id: randomUUID(), operation: { type: "chat", content: "stale" } }), /FENCED/);
    const restarted = await runtime(nodes[0].route.runtimeId, 1);
    const stale = await ParticipantConnection.connect({ owner: oldOwner, address: restarted.route.address, token: restarted.route.token,
      identity: { clusterId, nodeId: aliceId, incarnation: randomUUID() }, timeoutMs: 500 });
    try { await assert.rejects(stale.execute(originalJoin), /INCARNATION_MISMATCH/); } finally { stale.close(); }

    // Quorum loss cannot acknowledge another domain command. Healing allows
    // the exact durable pending command to finish without a new join.
    const leader = await lab.leader(), victims = lab.nodes.filter(n => n.id !== leader.id);
    for (const victim of victims) await lab.crash(victim);
    await until("authority unavailable", async () => (await alice.request("view")).connection === "authority unavailable" ? true : undefined);
    const waiting = await alice.request("submit", { operation: { type: "chat", content: "after quorum restoration" } });
    assert.equal((await alice.request("view")).commands.find((c: any) => c.id === waiting.commandId).outcome, null);
    assert.equal((await store.observe(meetingId)).watermark, 5);
    await lab.start(victims[0]);
    await lab.leader();
    const healed = await until("same pending command after quorum heals", async () => {
      const view = await alice.request("view"); return view.cursor.seq === 6 && view.connection === "connected" ? view : undefined;
    }, 20000).catch(async error => {
      console.log(JSON.stringify({ event: "participant.evidence-failure", participant: await alice.request("view"),
        runtime: nodes[2].process.messages.slice(-12), sql: (await store.observe(meetingId)).watermark }));
      throw error;
    });
    assert.equal(healed.commands.find((c: any) => c.id === waiting.commandId).outcome.code, "OK");
  } catch (error) {
    console.log(JSON.stringify({ event: "participant.process-diagnostics", processes: processes.map(p => ({
      exitCode: p.child.exitCode, signal: p.child.signalCode, events: p.messages.filter(m => m.event).slice(-5),
    })) }));
    throw error;
  } finally {
    await Promise.allSettled(processes.map(p => p.crash()));
    if (proxy) { for (const socket of proxy.clients) socket.terminate(); await new Promise<void>(r => proxy!.close(() => r())); }
    await pool.end(); await db.close(); await lab.stop();
  }
});
