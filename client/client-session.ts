import { setTimeout as delay } from "node:timers/promises";
import type { Operation } from "../storage/engine.ts";
import type { SessionJournal } from "./session-journal.ts";
import type { ConnectionState, ParticipantTransport } from "./types.ts";

/** GUI, CLI and automation attach to this one session and its durable inbox. */
export class ClientSession {
  readonly journal: SessionJournal;
  private readonly resolve: () => Promise<ParticipantTransport>;
  private queue: Promise<void> = Promise.resolve();
  private running = false;
  private transport?: ParticipantTransport;
  state: ConnectionState = "connecting";
  constructor(journal: SessionJournal, resolve: () => Promise<ParticipantTransport>) { this.journal = journal; this.resolve = resolve; }
  submit(operation: Operation): string { return this.journal.enqueue(operation); }
  view(after = 0, limit = 200) { return { ...this.journal.view(after, limit), connection: this.state }; }
  step(): Promise<void> {
    const work = this.queue.then(() => this.synchronize());
    this.queue = work.catch(() => {});
    return work;
  }
  private async synchronize(): Promise<void> {
    if (this.journal.left) { this.state = "left"; return; }
    try {
      this.transport = await this.resolve();
      for (const command of this.journal.pending()) {
        const outcome = await this.transport.execute(command);
        this.journal.complete(command.id, outcome);
        if (this.journal.left) { this.state = "left"; return; }
      }
      for (let pages = 0; pages < 8; pages++) {
        const cursor = this.journal.cursor();
        const page = await this.transport.read(this.journal.credential(), cursor.seq, 100);
        this.journal.recordReplay(cursor, page);
        if (page.scannedWatermark === page.watermark) break;
      }
      this.state = "connected";
    } catch (error) {
      this.state = error instanceof Error && /NOT_READY|FENCED|AUTHORITY_UNAVAILABLE/.test(error.message) ? "authority unavailable" : "reconnecting";
      throw error;
    } finally { this.transport?.close(); this.transport = undefined; }
  }
  async run(signal: AbortSignal, report: (error?: Error) => void = () => {}, intervalMs = 200): Promise<void> {
    if (this.running) throw new Error("SESSION_ALREADY_RUNNING");
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000) throw new Error("INVALID_INTERVAL");
    this.running = true;
    const stop = () => this.transport?.close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      while (!signal.aborted && this.state !== "left") {
        try { await this.step(); report(); } catch (error) { report(error instanceof Error ? error : new Error("SESSION_FAILED")); }
        if (signal.aborted || this.journal.left) break;
        await delay(intervalMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      }
    } finally { signal.removeEventListener("abort", stop); stop(); this.running = false; }
  }
}
