import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { until } from "./coordinator-lab.ts";
import { projectRoot } from "./coordinator-build.ts";

/** Owns exact child handles, never kills a PID recovered from a manifest. */
export class DemoChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: any[] = [];
  readonly closed: Promise<void>;
  private failure?: Error;
  private expectedStop = false;
  readonly logPath: string;
  constructor(executable: string, args: string[], env: Record<string, string>, logPath: string) {
    this.logPath = logPath;
    const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
    const logDone = finished(log); void logDone.catch(() => {});
    this.child = spawn(executable, args, { cwd: projectRoot, windowsHide: true, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.pipe(log, { end: false }); this.child.stderr.pipe(log, { end: false });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => { try { this.messages.push(JSON.parse(line)); if (this.messages.length > 256) this.messages.shift(); } catch {} });
    this.child.on("error", error => { this.failure = error; });
    this.child.stdin.on("error", () => {});
    this.closed = new Promise<void>(resolve => this.child.once("close", () => resolve())).then(async () => { lines.close(); log.end(); await logDone; });
    void this.closed.catch(error => { this.failure = error; });
  }
  get alive() { return !this.failure && this.child.exitCode === null && this.child.signalCode === null; }
  async event(name: string) {
    return until(name, async () => { const event = this.messages.find(m => m.event === name); if (event) return event; if (!this.alive) throw new Error("CHILD_EXITED_SEE_LOG: " + this.logPath); return undefined; }, 15000);
  }
  async request(action: string, body: object = {}) {
    if (!this.alive) throw new Error("CHILD_UNAVAILABLE");
    const id = randomUUID(); this.child.stdin.write(JSON.stringify({ id, action, ...body }) + "\n");
    return until(action, async () => { const reply = this.messages.find(m => m.id === id); if (!reply) { if (!this.alive) throw new Error("CHILD_UNAVAILABLE"); return undefined; } if (reply.error) throw new Error(reply.error); return reply.result; }, 4000);
  }
  async stop(graceful = true, acknowledgePriorCrash = false): Promise<boolean> {
    if (!this.alive) {
      await this.closed;
      if (!acknowledgePriorCrash && (this.failure || (!this.expectedStop && this.child.exitCode !== 0))) throw new Error("CHILD_EXITED_UNEXPECTEDLY_SEE_LOG");
      if (acknowledgePriorCrash) this.expectedStop = true;
      return false;
    }
    this.expectedStop = true;
    let forced = !graceful;
    if (graceful) {
      this.child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      const ended = await Promise.race([this.closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
      clearTimeout(timer); forced = !ended;
    }
    if (forced && this.alive) this.child.kill("SIGKILL");
    let killTimer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.closed, new Promise<never>((_, reject) => { killTimer = setTimeout(() => reject(new Error("CHILD_SHUTDOWN_TIMEOUT")), 5000); })]); }
    finally { clearTimeout(killTimer); }
    if (!forced && this.child.exitCode !== 0) throw new Error("CHILD_DRAIN_FAILED_SEE_LOG");
    return forced;
  }
}
