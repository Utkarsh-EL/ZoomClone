import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";
import { HelperClient, type HelperStatus, type MetadataState } from "../coordination/helper-client.ts";
import { LeaderRoute } from "../coordination/helper-route.ts";
import { RecoveryController, matches, ownerFor } from "../coordination/recovery-controller.ts";
import { RemoteRuntime, availableRuntimes } from "../coordination/runtime-rpc.ts";
import { StorageLab } from "./storage-lab.ts";
import { DemoChild } from "./demo-child.ts";
import { helperPath, projectRoot } from "./coordinator-build.ts";
import { localPort } from "./local-port.ts";
import { until } from "./coordinator-lab.ts";
import { loadDemoState, people, secret, writeJSON, type DemoState } from "./demo-state.ts";
import { SessionJournal } from "../client/session-journal.ts";
import { prepareDemoJournal, verifyDemoJournal } from "./demo-journal.ts";
import { boundedCommand } from "./bounded-command.ts";

type Runtime = { process: DemoChild; remote: RemoteRuntime; route: { runtimeId: string; incarnation: string; address: string; token: string } };
export class DemoStack {
  phase = "starting"; failure: string | null = null;
  state?: DemoState;
  private storage?: StorageLab;
  private db?: Database;
  private pool?: ReturnType<typeof createPool>;
  private store?: MeetingStore;
  private helpers: { process: DemoChild; client: HelperClient }[] = [];
  private discovery: { process: DemoChild; address: string }[] = [];
  private runtimes: Runtime[] = [];
  private participants = new Map<string, { process: DemoChild; url: string }>();
  private mediaAddress = "";
  private mediaName = "";
  private mediaOwned = false;
  private controllerAbort = new AbortController();
  private controllerDone?: Promise<void>;
  private stopped?: Promise<string[]>;
  private cleanup: string[] = [];
  private recoveredCrashes: string[] = [];
  readonly root: string; readonly runId: string;
  constructor(root: string, runId: string) { this.root = root; this.runId = runId; }
  cancel() { this.controllerAbort.abort(); }
  private check() { this.controllerAbort.signal.throwIfAborted(); }
  private async save() { await writeJSON(join(this.root, "demo.json"), this.state); }
  private docker(args: string[], env?: Record<string, string>, signal?: AbortSignal) {
    const timeoutMs = args[0] === "build" ? 240000 : args[0] === "compose" && args.includes("up") ? 80000 : 15000;
    return boundedCommand("docker", args, { env, signal, timeoutMs });
  }
  private spawn(name: string, script: string, key: string, config: object) {
    return new DemoChild(process.execPath, [script], { [key]: JSON.stringify(config), ZOOM_PARENT_LIFETIME: "stdin" }, join(this.root, "logs", `${name}-${this.runId}.jsonl`));
  }
  async start() {
    try {
      this.state = await loadDemoState(this.root);
      if (this.state) for (const name of people) {
        const expected = this.state.participantIds[name];
        if (expected) verifyDemoJournal(join(this.root, `${name}-${this.state.participantRevisions[name]}.sqlite`), expected);
      }
      await mkdir(join(this.root, "logs"), { recursive: true, mode: 0o700 });
      if (!this.state) {
        this.storage = new StorageLab(); await this.storage.start({ run: (args, env) => this.docker(args, env, this.controllerAbort.signal) }); this.check();
        const ports = new Set<number>(); while (ports.size < 3) ports.add(await localPort());
        this.state = { version: 2, protocol: 2, clusterId: this.storage.clusterId, storageRoot: this.storage.root, meetingId: randomUUID(), controllerId: randomUUID(),
          helperToken: secret(), discoveryToken: secret(), runtimeToken: secret(), participantToken: secret(), runtimePassword: secret(), mediaNodeId: randomUUID(), mediaToken: secret(),
          helpers: [...ports].map(port => ({ id: randomUUID(), address: `127.0.0.1:${port}`, initialized: false })), runtimeIds: [randomUUID(), randomUUID()], participantRevisions: Object.fromEntries(people.map(name => [name, 0])), participantIds: Object.fromEntries(people.map(name => [name, null])) };
        await this.save();
      } else {
        this.storage = await StorageLab.resume(this.state.storageRoot);
        if (this.storage.clusterId !== this.state.clusterId) throw new Error("DEMO_STORAGE_CLUSTER_MISMATCH");
        await this.storage.start({ run: (args, env) => this.docker(args, env, this.controllerAbort.signal) }); this.check();
      }
      const state = this.state;
      const probe = createPool(this.storage.url, 1);
      try { await until("published PostgreSQL endpoint", async () => { this.check(); try { await probe.query("SELECT 1"); return true; } catch { return undefined; } }, 15000); }
      finally { await probe.end(); }
      this.db = await Database.open({ connectionString: this.storage.url, clusterId: state.clusterId, initialize: true }); this.check();
      // This credential is provisioned once and reused across ordinary restarts.
      const role = await this.db.pool.query("SELECT format('ALTER ROLE zoom_runtime LOGIN PASSWORD %L', $1::text) AS sql", [state.runtimePassword]);
      await this.db.pool.query(role.rows[0].sql);
      const runtimeURL = new URL(this.storage.url); runtimeURL.username = "zoom_runtime"; runtimeURL.password = state.runtimePassword;
      this.pool = createPool(runtimeURL.href); this.store = new MeetingStore(this.db, this.pool);
      const bootstrap = join(this.root, "bootstrap.json"); await writeJSON(bootstrap, state.helpers.map(({ id, address }) => ({ id, address })));
      for (const [i, h] of state.helpers.entries()) {
        this.check();
        const dataDir = join(this.root, `helper-${i + 1}`);
        const exists = await stat(dataDir).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
        if (h.initialized && !exists) throw new Error("HELPER_DATA_MISSING_RESTORE_REQUIRED");
        const args = ["--cluster", state.clusterId, "--id", h.id, "--listen", h.address, "--data", dataDir, ...(!exists ? ["--new", "--bootstrap", bootstrap] : [])];
        const process = new DemoChild(helperPath, args, { ZOOM_CLUSTER_TOKEN: state.helperToken }, join(this.root, "logs", `helper-${i + 1}-${this.runId}.jsonl`));
        const client = new HelperClient({ clusterId: state.clusterId, nodeId: state.controllerId, helperId: h.id, address: h.address, token: state.helperToken, timeoutMs: 1000 });
        this.helpers.push({ process, client }); await process.event("helper.started"); h.initialized = true; await this.save();
      }
      await this.leader(); this.check();
      const helperRoutes = state.helpers.map(h => ({ helperId: h.id, address: h.address }));
      for (let i = 0; i < 4; i++) {
        this.check();
        const process = this.spawn(`discovery-${i + 1}`, "scripts/discovery-peer.ts", "ZOOM_DISCOVERY_CONFIG", {
          clusterId: state.clusterId, nodeId: randomUUID(), address: "127.0.0.1:0", token: state.discoveryToken,
          ...(i === 0 ? { initialize: true } : { bootstraps: this.discovery.slice(0, 2).map(d => d.address) }),
          announcements: [{ namespace: "service", name: "coordinators", generation: 1, value: { helpers: helperRoutes } }] });
        // Register ownership before awaiting readiness, including partial startup failures.
        const item = { process, address: "" }; this.discovery.push(item); item.address = (await process.event("discovery.started")).address;
      }
      this.mediaAddress = `http://127.0.0.1:${await localPort()}`;
      this.mediaName = "zoom-demo-media-" + state.clusterId.slice(0, 8);
      const helper = new LeaderRoute(this.helpers.map(h => h.client));
      const metadata = await helper.call<MetadataState>("read");
      if (!metadata.meetings[state.meetingId]) {
        // First reservation uses an original ID stable across an uncertain reply.
        const result = await helper.call<{ code: string }>("apply", { command: { id: state.meetingId, kind: "reserve", meetingId: state.meetingId, code: "assignment-demo" } });
        if (result.code !== "OK") throw new Error(result.code);
      }
      for (const [i, runtimeId] of state.runtimeIds.entries()) {
        this.check();
        const current = await helper.call<MetadataState>("read");
        const process = this.spawn(`runtime-${i + 1}`, "scripts/meeting-runtime.ts", "ZOOM_RUNTIME_CONFIG", {
          clusterId: state.clusterId, runtimeId, expectedRevision: current.runtimes[runtimeId]?.revision ?? 0,
          address: "127.0.0.1:0", token: state.runtimeToken, callers: [state.controllerId], helpers: helperRoutes, helperToken: state.helperToken,
          discovery: this.discoveryOptions(), helperTimeoutMs: 800, connectionString: this.storage.url, runtimeConnectionString: runtimeURL.href,
          participants: { address: "127.0.0.1:0", token: state.participantToken, timeoutMs: 10000 },
          media: { routes: [{ meetingId: state.meetingId, address: this.mediaAddress, nodeId: state.mediaNodeId, token: state.mediaToken, observationPath: join(this.root, `media-runtime-${i + 1}.json`) }] } });
        // Track the process before event parsing so cleanup owns failed starts.
        const temporary = { process } as Runtime; this.runtimes.push(temporary);
        const started = await process.event("runtime.started");
        temporary.route = { runtimeId, incarnation: started.incarnation, address: started.participantAddress, token: state.participantToken };
        temporary.remote = new RemoteRuntime({ clusterId: state.clusterId, runtimeId, incarnation: started.incarnation, address: started.address, token: state.runtimeToken,
          identity: { clusterId: state.clusterId, nodeId: state.controllerId, incarnation: this.runId }, timeoutMs: 1000 });
        await until("registered demo runtime", async () => await temporary.remote.available() ? true : undefined);
      }
      await this.startMedia(); this.check();
      this.controllerDone = this.recover(); void this.controllerDone.catch(error => { if (!this.controllerAbort.signal.aborted) { this.failure = String(error); this.phase = "degraded"; } });
      await until("ACTIVE demo meeting", async () => {
        const current = await helper.call<MetadataState>("read"), meeting = current.meetings[state.meetingId];
        if (meeting?.assignment?.phase !== "READY") return undefined;
        const sql = await this.store!.observe(state.meetingId);
        return sql.phase === "ACTIVE" && matches(sql, ownerFor(state.clusterId, meeting)) ? true : undefined;
      }, 30000);
      for (const name of people) { this.check(); await this.startParticipant(name); }
      this.phase = "running";
      await this.waitReady();
    } catch (error) { this.failure = error instanceof Error ? error.message : "DEMO_STARTUP_FAILED"; this.phase = "failed"; throw error; }
  }
  private discoveryOptions() { return { bootstraps: this.discovery.slice(0, 2).map(d => d.address), token: this.state!.discoveryToken, timeoutMs: 2000 }; }
  private async leader() {
    return until("leader with a fresh read barrier", async () => {
      this.check();
      for (const h of this.helpers) {
        if (!h.process.alive) continue;
        try { const status = await h.client.call<HelperStatus>("status"); if (status.role === "Leader") { await h.client.call("read"); return h.client; } } catch {}
      }
      return undefined;
    }, 15000);
  }
  private async recover() {
    const controllers = new Map<HelperClient, RecoveryController>();
    while (!this.controllerAbort.signal.aborted) {
      try {
        const client = await this.leader();
        let worker = controllers.get(client);
        if (!worker) { worker = new RecoveryController(client, this.store!, { clusterId: this.state!.clusterId, suspicionMs: 1500 }); controllers.set(client, worker); }
        const available = await availableRuntimes(this.runtimes.filter(r => r.process.alive && r.remote).map(r => r.remote));
        await worker.tick(this.state!.meetingId, available);
      } catch (error) { if (!this.controllerAbort.signal.aborted) this.failure = error instanceof Error ? error.message : "RECOVERY_UNAVAILABLE"; }
      await delay(200, undefined, { signal: this.controllerAbort.signal }).catch(() => {});
    }
  }
  private async startMedia() {
    const state = this.state!, storage = this.storage!;
    try { await this.docker(["image", "inspect", "zoomclone-media-feasibility:3.32.2"], undefined, this.controllerAbort.signal); }
    catch (error) {
      if (!/no such/i.test(String(error))) throw error;
      await this.docker(["build", "--file", "services/media/Dockerfile", "--tag", "zoomclone-media-feasibility:3.32.2", "."], undefined, this.controllerAbort.signal);
    }
    // A leftover SFU from an interrupted supervisor is replaced only after its
    // exact ownership label matches this durable cluster. Never touch strangers.
    let prior: any;
    try { prior = JSON.parse(await this.docker(["inspect", this.mediaName], undefined, this.controllerAbort.signal))[0]; }
    catch (error) { if (!/no such/i.test(String(error))) throw error; }
    if (prior) {
      if (prior.Config?.Labels?.["org.zoomclone.demo"] !== state.clusterId) throw new Error("MEDIA_CONTAINER_NOT_OWNED");
      await this.docker(["rm", "--force", this.mediaName], undefined, this.controllerAbort.signal);
    }
    const port = await localPort(true), controlPort = new URL(this.mediaAddress).port;
    this.mediaOwned = true;
    await this.docker(["run", "--detach", "--name", this.mediaName, "--label", `org.zoomclone.demo=${state.clusterId}`,
      "--publish", `127.0.0.1:${controlPort}:8080/tcp`, "--publish", `127.0.0.1:${port}:${port}/udp`, "--publish", `127.0.0.1:${port}:${port}/tcp`,
      ...["MEDIA_CLUSTER_ID", "MEDIA_NODE_ID", "MEDIA_MEETING_ID", "MEDIA_CALLERS", "MEDIA_TOKEN", "MEDIA_PORT"].flatMap(key => ["--env", key]), "zoomclone-media-feasibility:3.32.2"],
    { MEDIA_CLUSTER_ID: state.clusterId, MEDIA_NODE_ID: state.mediaNodeId, MEDIA_MEETING_ID: state.meetingId, MEDIA_TOKEN: state.mediaToken, MEDIA_PORT: String(port),
      MEDIA_CALLERS: JSON.stringify(this.runtimes.map(r => ({ nodeId: r.route.runtimeId, incarnation: r.route.incarnation }))) }, this.controllerAbort.signal);
    await until("SFU control listener", async () => await this.mediaRunning() ? true : undefined, 15000);
  }
  private async mediaRunning() {
    try { const response = await fetch(this.mediaAddress + "/v1/control", { signal: AbortSignal.timeout(1200), redirect: "error" }); await response.body?.cancel(); return response.status === 403; } catch { return false; }
  }
  private async startParticipant(name: string) {
    const state = this.state!;
    const sessionPath = join(this.root, `${name}-${state.participantRevisions[name]}.sqlite`);
    const participantId = prepareDemoJournal(sessionPath, { clusterId: state.clusterId, meetingId: state.meetingId, name }, state.participantIds[name]);
    if (!state.participantIds[name]) { state.participantIds[name] = participantId; await this.save(); }
    const process = this.spawn("participant-" + name, "scripts/participant-agent.ts", "ZOOM_PARTICIPANT_CONFIG", {
      sessionPath, target: { clusterId: state.clusterId, meetingId: state.meetingId, name },
      helpers: state.helpers.map(h => ({ helperId: h.id, address: h.address })), helperToken: state.helperToken, discovery: this.discoveryOptions(),
      routes: this.runtimes.map(r => r.route), helperTimeoutMs: 800, timeoutMs: 5000, intervalMs: 200,
      browser: { address: "127.0.0.1:0" }, media: { bundlePath: join(projectRoot, ".local", "media-lab.js") } });
    const participant = { process, url: "" }; this.participants.set(name, participant);
    participant.url = (await process.event("participant.started")).browser.url;
  }
  private async participantView(name: string, process: DemoChild) {
    if (process.alive) return process.request("view", { limit: 1 });
    const state = this.state!, path = join(this.root, `${name}-${state.participantRevisions[name]}.sqlite`);
    await stat(path); // Missing state must never create a replacement identity.
    verifyDemoJournal(path, state.participantIds[name]!);
    const journal = SessionJournal.open(path, { clusterId: state.clusterId, meetingId: state.meetingId, name });
    try { return { ...journal.view(0, 1), connection: journal.left ? "left" : "unavailable" }; }
    finally { journal.close(); }
  }
  async status() {
    const state = this.state;
    const participants = await Promise.all([...this.participants].map(async ([name, p]) => {
      try { const view = await this.participantView(name, p.process); return { name, participantId: view.participantId, connection: view.connection, cursor: view.cursor.seq, url: p.url, left: view.left }; }
      catch { return { name, participantId: null, connection: "unavailable", url: p.url, left: false }; }
    }));
    let generation = 0, owner: string | null = null, active = false, dependencyError: string | null = null;
    if (state && this.store && this.helpers.length) {
      try {
        const metadata = await new LeaderRoute(this.helpers.map(h => h.client)).call<MetadataState>("read"), meeting = metadata.meetings[state.meetingId];
        generation = meeting?.generation ?? 0; owner = meeting?.assignment?.runtimeId ?? null;
        const sql = await this.store.observe(state.meetingId);
        active = meeting?.assignment?.phase === "READY" && sql.phase === "ACTIVE" && matches(sql, ownerFor(state.clusterId, meeting));
      } catch (error) { dependencyError = error instanceof Error ? error.message : "DEPENDENCY_UNAVAILABLE"; }
    }
    const media = this.mediaAddress ? await this.mediaRunning() : false;
    const ready = this.phase === "running" && active && media && participants.length === 4 && participants.every(p => p.connection === "connected" || p.left);
    return { phase: this.phase, ready, runId: this.runId, clusterId: state?.clusterId, meetingId: state?.meetingId, generation, owner,
      helpers: this.helpers.filter(h => h.process.alive).length, discoveryPeers: this.discovery.filter(d => d.process.alive).length,
      runtimes: this.runtimes.filter(r => r.process.alive).length, media: media ? "listening" : "unavailable", participants,
      dependencyError, cleanupErrors: this.cleanup, recoveredCrashes: this.recoveredCrashes, startupError: this.phase === "failed" ? this.failure : null, observedAt: new Date().toISOString(), root: this.root };
  }
  async waitReady() { return until("demo readiness (see status/logs)", async () => { this.check(); const status = await this.status(); return status.ready ? status : undefined; }, 30000); }
  async failRuntime() {
    const before = await this.status(); if (!before.owner) throw new Error("NO_ACTIVE_RUNTIME");
    const runtime = this.runtimes.find(r => r.route?.runtimeId === before.owner); if (!runtime?.process.alive) throw new Error("ACTIVE_RUNTIME_UNAVAILABLE");
    if (this.runtimes.filter(r => r.process.alive).length < 2) throw new Error("NO_SPARE_RUNTIME_RESTART_DEMO_FIRST");
    await runtime.process.stop(false);
    return until("takeover after runtime crash", async () => { const status = await this.status(); return status.ready && status.generation > before.generation ? status : undefined; }, 30000);
  }
  async restartParticipant(name: string, fresh = false) {
    if (!(people as readonly string[]).includes(name)) throw new Error("UNKNOWN_DEMO_PARTICIPANT");
    const previous = this.participants.get(name);
    if (fresh) {
      const view = previous ? await this.participantView(name, previous.process) : undefined;
      if (!view?.left) throw new Error("PARTICIPANT_MUST_HAVE_LEFT_BEFORE_NEW_IDENTITY");
      this.state!.participantRevisions[name]++; this.state!.participantIds[name] = null; await this.save();
    }
    if (previous) {
      if (!previous.process.alive) this.recoveredCrashes.push(name + ": recovered after prior process exit; see logs");
      const forced = await previous.process.stop(true, true); if (forced) throw new Error("PARTICIPANT_DRAIN_FORCED_SEE_LOG");
    }
    await this.startParticipant(name); return this.waitReady();
  }
  async failParticipant(name: string) {
    const participant = this.participants.get(name); if (!participant?.process.alive) throw new Error("PARTICIPANT_UNAVAILABLE");
    participant.process.child.kill("SIGKILL"); await participant.process.closed;
    return this.status();
  }
  stop(): Promise<string[]> {
    return this.stopped ??= (async () => {
      this.phase = "stopping"; this.controllerAbort.abort(); await this.controllerDone?.catch(() => {});
      const stop = async (name: string, child: DemoChild, graceful = true) => {
        try { const forced = await child.stop(graceful); if (forced && graceful) this.cleanup.push(name + ": forced shutdown; external media drain unconfirmed"); }
        catch { this.cleanup.push(name + ": shutdown failed; see logs"); }
      };
      await Promise.all([...this.participants].map(([name, p]) => stop(name, p.process)));
      await Promise.all(this.runtimes.map((r, i) => stop("runtime-" + i, r.process)));
      await Promise.all(this.discovery.map((d, i) => stop("discovery-" + i, d.process)));
      await Promise.all(this.helpers.map((h, i) => stop("helper-" + i, h.process, false)));
      if (this.mediaOwned) {
        try {
          const inspect = JSON.parse(await this.docker(["inspect", this.mediaName]))[0];
          if (inspect.Config?.Labels?.["org.zoomclone.demo"] !== this.state?.clusterId) throw new Error("MEDIA_CONTAINER_NOT_OWNED");
          await this.docker(["rm", "--force", this.mediaName]);
        } catch { this.cleanup.push("media: owned cleanup failed"); }
      }
      await this.pool?.end().catch(() => { this.cleanup.push("runtime pool close failed"); });
      await this.db?.close().catch(() => { this.cleanup.push("admin pool close failed"); });
      try { await this.storage?.stopAsync((args, env) => this.docker(args, env)); } catch { this.cleanup.push("storage stop failed; volume retained"); }
      this.phase = this.cleanup.length ? "cleanup-incomplete" : "stopped";
      await writeJSON(join(this.root, "last-stop.json"), { phase: this.phase, runId: this.runId, cleanupErrors: this.cleanup, observedAt: new Date().toISOString() });
      return this.cleanup;
    })();
  }
}
