import { setTimeout as delay } from "node:timers/promises";
import { randomInt } from "node:crypto";
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
  step(signal?: AbortSignal): Promise<void> {
    const work = this.queue.then(() => this.synchronize(signal));
    this.queue = work.catch(() => {});
    return work;
  }
  private async synchronize(signal?: AbortSignal): Promise<void> {
    if (this.journal.left) { this.state = "left"; return; }
    try {
      signal?.throwIfAborted();
      this.transport = await this.resolve();
      signal?.throwIfAborted();
      for (const command of this.journal.pending()) {
        signal?.throwIfAborted();
        const outcome = await this.transport.execute(command);
        this.journal.complete(command.id, outcome);
        if (this.journal.left) { this.state = "left"; return; }
      }
      // One meeting page and one catalog page leave six slots for fair scoped
      // recovery. Every pass advances the meeting even with busy private groups.
      for (let pages = 0; pages < 1; pages++) {
        signal?.throwIfAborted();
        const cursor = this.journal.cursor();
        const page = await this.transport.read(this.journal.credential(), cursor.seq, 100);
        this.journal.recordReplay(cursor, page);
        if (page.scannedWatermark === page.watermark) break;
      }
      const catalogAfter = this.journal.catalogAfter();
      this.journal.recordCatalog(catalogAfter, await this.transport.listGroups(this.journal.credential(), catalogAfter, 16));
      const visited = new Set<string>();
      for (let pages = 0; pages < 6; pages++) {
        signal?.throwIfAborted();
        const groupId = this.journal.nextGroup();
        if (!groupId || visited.has(groupId)) break;
        visited.add(groupId);
        const after = this.journal.groupCursor(groupId);
        try { this.journal.recordGroupReplay(groupId, after, await this.transport.readGroup(this.journal.credential(), groupId, after, 16)); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "GROUP_ACCESS_DENIED") throw error;
          this.journal.groupUnavailable(groupId);
        }
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
      let failed = false;
      while (!signal.aborted && this.state !== "left") {
        try { await this.step(signal); failed = false; report(); }
        catch (error) { failed = true; report(error instanceof Error ? error : new Error("SESSION_FAILED")); }
        if (signal.aborted || this.journal.left) break;
        // Avoid repeatedly arriving at the same phase of runtime renewal.
        const retryMs = failed ? intervalMs + randomInt(1, intervalMs + 1) : intervalMs;
        await delay(retryMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      }
    } finally { signal.removeEventListener("abort", stop); stop(); this.running = false; }
  }
}
