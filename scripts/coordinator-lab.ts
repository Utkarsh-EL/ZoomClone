import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { HelperClient, type HelperStatus } from "../coordination/helper-client.ts";
import { helperPath, projectRoot } from "./coordinator-build.ts";

export interface ManagedHelper {
  id: string;
  address: string;
  dataDir: string;
  child: ChildProcess | null;
  closed: Promise<void>;
  incarnation: string;
  starts: number;
  logPath: string;
}

export async function until<T>(description: string, observe: () => Promise<T | undefined>, timeout = 15000): Promise<T> {
  const deadline = performance.now() + timeout;
  let lastError: unknown;
  do {
    try { const value = await observe(); if (value !== undefined) return value; } catch (error) { lastError = error; }
    await delay(40);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

/** A bounded evidence runner, not the persistent supervisor in the redesign. */
export class CoordinatorLab {
  readonly clusterId = randomUUID();
  readonly token = randomBytes(32).toString("hex");
  readonly nodes: ManagedHelper[] = [];
  readonly root: string;
  private client!: HelperClient;
  private stopping?: Promise<void>;
  private readonly onSignal = () => { void this.stop().finally(() => process.exit(130)); };

  private constructor(root: string) { this.root = root; }

  static async create(count = 5): Promise<CoordinatorLab> {
    if (!Number.isInteger(count) || count < 1 || count > 9) throw new Error("Evidence lab requires 1–9 helpers");
    const lab = new CoordinatorLab(join(projectRoot, ".local", "coordinator-labs", randomUUID()));
    await mkdir(lab.root, { recursive: true });
    const reservations: ReturnType<typeof createServer>[] = [];
    process.once("SIGINT", lab.onSignal);
    process.once("SIGTERM", lab.onSignal);
    try {
      for (let i = 0; i < count; i++) {
        const reservation = createServer();
        reservations.push(reservation);
        await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
        const address = reservation.address();
        if (!address || typeof address === "string") throw new Error("No allocated TCP address");
        lab.nodes.push({ id: randomUUID(), address: `127.0.0.1:${address.port}`, dataDir: join(lab.root, `node-${i + 1}`),
          child: null, closed: Promise.resolve(), incarnation: "", starts: 0, logPath: "" });
      }
      await writeFile(join(lab.root, "bootstrap.json"), JSON.stringify(lab.nodes.map(({ id, address }) => ({ id, address }))), { flag: "wx", mode: 0o600 });
      await writeFile(join(lab.root, ".token"), lab.token, { flag: "wx", mode: 0o600 });
      await writeFile(join(lab.root, "lab.json"), JSON.stringify({ clusterId: lab.clusterId, nodes: lab.nodes.map(({ id, address, dataDir }) => ({ id, address, dataDir })) }, null, 2), { flag: "wx" });
      const first = lab.nodes[0];
      lab.client = new HelperClient({ clusterId: lab.clusterId, nodeId: randomUUID(), helperId: first.id, address: first.address, token: lab.token, timeoutMs: 4000 });
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => reservations[i].close(() => resolve()));
        await lab.start(lab.nodes[i], true);
      }
      return lab;
    } catch (error) { await lab.stop(); throw error; }
    finally { for (const server of reservations) server.close(); }
  }

  connection(node: ManagedHelper): HelperClient { return this.client.forHelper(node.id, node.address); }

  async leader(): Promise<ManagedHelper> {
    return until("a leader able to commit a fresh read barrier", async () => {
      for (const node of this.nodes) {
        if (!node.child) continue;
        try {
          const client = this.connection(node);
          const status = await client.call<HelperStatus>("status");
          if (status.role === "Leader") { await client.call("read"); return node; }
        } catch { /* Elections and unavailable helpers are expected observations. */ }
      }
      return undefined;
    });
  }

  async start(node: ManagedHelper, initialize = false): Promise<void> {
    if (node.child) throw new Error("Helper already has a managed process");
    node.starts++;
    node.logPath = join(this.root, `${node.id}-${node.starts}.jsonl`);
    const log = createWriteStream(node.logPath, { flags: "wx" });
    const logDone = finished(log);
    // Attach rejection handling immediately; errors are surfaced below too.
    void logDone.catch(() => {});
    const args = ["--cluster", this.clusterId, "--id", node.id, "--listen", node.address, "--data", node.dataDir];
    if (initialize) args.push("--new", "--bootstrap", join(this.root, "bootstrap.json"));
    const child = spawn(helperPath, args, { cwd: projectRoot, env: { ...process.env, ZOOM_CLUSTER_TOKEN: this.token },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    node.child = child;
    child.stdout!.pipe(log);
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
    node.closed = new Promise<void>((resolve) => child.once("close", () => resolve())).then(() => logDone);
    void node.closed.catch(() => {});
    const lines = createInterface({ input: child.stdout! });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Helper startup timed out: ${stderr}`)), 10000);
        const done = (error?: Error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
        child.once("error", (error) => { log.end(); done(error); });
        child.once("exit", (code) => done(new Error(`Helper exited (${code}): ${stderr}`)));
        log.once("error", (error) => done(error));
        lines.on("line", (line) => {
          try {
            const event = JSON.parse(line);
            if (event.event === "helper.started" && event.nodeId === node.id) { node.incarnation = event.incarnation; done(); }
          } catch { /* Only a matching complete startup event establishes readiness. */ }
        });
      });
    } finally {
      lines.close();
      // readline.close() pauses the shared input; the evidence pipe must keep
      // draining after startup or a full stdout pipe can block the Go helper.
      child.stdout!.resume();
    }
  }

  async crash(node: ManagedHelper): Promise<void> {
    const child = node.child;
    if (!child) throw new Error("Helper has no managed process");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await node.closed;
    node.child = null;
  }

  async stop(): Promise<void> {
    this.stopping ??= (async () => {
      await Promise.allSettled(this.nodes.filter((node) => node.child).map((node) => this.crash(node)));
      process.removeListener("SIGINT", this.onSignal);
      process.removeListener("SIGTERM", this.onSignal);
    })();
    return this.stopping;
  }
}
