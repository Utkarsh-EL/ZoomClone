import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HelperAccess, MetadataCommand, MetadataState } from "./helper-client.ts";
import { matches, ownerFor } from "./recovery-controller.ts";
import { RuntimeAuthority } from "./runtime-authority.ts";
import { UUID_PATTERN } from "./wire.ts";
import type { MeetingStore, Owner } from "../storage/meeting-store.ts";

export interface RuntimeOptions {
  clusterId: string;
  runtimeId: string;
  incarnation: string;
  /** Provisioned once per process start; never updated to fight a replacement. */
  expectedRevision: number;
  intervalMs?: number;
  readinessMs?: number;
  maxMeetings?: number;
}
type RuntimeStore = Pick<MeetingStore, "prepare" | "observe">;

/** Headless runtime lifecycle. Only fresh READY assignments get authority;
 * preparation itself grants none. Uncertain registration retries the same ID. */
export class RuntimeAgent {
  readonly identity: Readonly<RuntimeOptions>;
  private readonly helper: HelperAccess;
  private readonly store: RuntimeStore;
  private readonly registration: MetadataCommand;
  private readonly gates = new Map<string, RuntimeAuthority>();
  private stopped = false;
  private busy = false;
  private admitted = false;
  private running = false;
  private terminal?: Error;

  constructor(helper: HelperAccess, store: RuntimeStore, options: RuntimeOptions) {
    for (const id of [options.clusterId, options.runtimeId, options.incarnation]) {
      if (!UUID_PATTERN.test(id)) throw new Error("Runtime UUID identities required");
    }
    const intervalMs = options.intervalMs ?? 500, readinessMs = options.readinessMs ?? 2000;
    const maxMeetings = options.maxMeetings ?? 128;
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || options.expectedRevision >= Number.MAX_SAFE_INTEGER - 1
      || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs >= readinessMs
      || !Number.isSafeInteger(readinessMs) || readinessMs > 60000
      || !Number.isSafeInteger(maxMeetings) || maxMeetings < 1 || maxMeetings > 1024) throw new Error("Invalid runtime scheduling options");
    this.identity = Object.freeze({ ...options, intervalMs, readinessMs, maxMeetings });
    this.helper = helper; this.store = store;
    this.registration = Object.freeze({ id: randomUUID(), kind: "register", runtimeId: options.runtimeId,
      incarnation: options.incarnation, expectedRevision: options.expectedRevision });
  }

  get registered(): boolean { return this.admitted && !this.stopped; }
  authority(meetingId: string): RuntimeAuthority | undefined { return this.gates.get(meetingId); }
  private check(): void { if (this.stopped) throw new Error("RUNTIME_STOPPED"); }
  private clear(): void { for (const gate of this.gates.values()) gate.stop(); }
  stop(): void { this.stopped = true; this.admitted = false; this.clear(); this.gates.clear(); }
  private revoke(message: string): never {
    this.terminal = new Error(message); this.stop(); throw this.terminal;
  }

  private validate(state: MetadataState): void {
    if (state.cluster !== this.identity.clusterId) throw new Error("CLUSTER_MISMATCH");
    const registration = state.runtimes[this.identity.runtimeId];
    if (!registration || registration.incarnation !== this.identity.incarnation || registration.revision !== this.identity.expectedRevision + 1) {
      this.revoke("REGISTRATION_REVOKED");
    }
  }

  async prepare(input: Owner): Promise<void> {
    this.check();
    const owner = Object.freeze({ ...input });
    if (owner.clusterId !== this.identity.clusterId || owner.runtimeId !== this.identity.runtimeId || owner.incarnation !== this.identity.incarnation) throw new Error("RUNTIME_MISMATCH");
    const state = await this.helper.call<MetadataState>("read");
    this.check(); this.validate(state);
    const meeting = state.meetings[owner.meetingId];
    if (!meeting?.assignment || !matches({ generation: meeting.generation, ...meeting.assignment }, owner)) throw new Error("ASSIGNMENT_CONFLICT");
    await this.store.prepare(owner);
    this.check();
  }

  async tick(report: (meetingId: string, error?: Error) => void = () => {}): Promise<void> {
    this.check();
    if (this.busy) throw new Error("Runtime refresh already running");
    this.busy = true;
    try {
      let state = await this.helper.call<MetadataState>("read");
      this.check();
      if (state.cluster !== this.identity.clusterId) throw new Error("CLUSTER_MISMATCH");
      if (!this.admitted) {
        const result = await this.helper.call<{ code: string }>("apply", { command: this.registration });
        this.check();
        if (result.code !== "OK") this.revoke(`REGISTRATION_${result.code}`);
        this.admitted = true;
        state = await this.helper.call<MetadataState>("read");
        this.check();
      }
      this.validate(state);
      const owners = Object.values(state.meetings).filter(m => m.assignment?.phase === "READY"
        && m.assignment.runtimeId === this.identity.runtimeId && m.assignment.incarnation === this.identity.incarnation)
        .map(m => ownerFor(this.identity.clusterId, m));
      if (owners.length > this.identity.maxMeetings!) throw new Error("RUNTIME_CAPACITY");
      for (const [id, gate] of this.gates) {
        if (!owners.some(owner => owner.meetingId === id && matches(gate.owner, owner))) { gate.stop(); this.gates.delete(id); }
      }
      for (const owner of owners) {
        this.check();
        try {
          let gate = this.gates.get(owner.meetingId);
          if (!gate) {
            await this.store.prepare(owner);
            this.check();
            gate = new RuntimeAuthority(this.helper, this.store, owner, { readinessMs: this.identity.readinessMs });
            this.gates.set(owner.meetingId, gate);
          }
          await gate.renew(); this.check();
          report(owner.meetingId);
        } catch (error) {
          this.gates.get(owner.meetingId)?.stop();
          this.check();
          report(owner.meetingId, error instanceof Error ? error : new Error(String(error)));
        }
      }
    } catch (error) { this.clear(); throw error; }
    finally { this.busy = false; }
  }

  async run(options: { signal: AbortSignal; report(meetingId: string, error?: Error): void }): Promise<void> {
    if (this.running) throw new Error("Runtime scheduler already running");
    this.check(); this.running = true;
    const stop = () => this.stop();
    options.signal.addEventListener("abort", stop, { once: true });
    try {
      if (options.signal.aborted) this.stop();
      while (!this.stopped) {
        try { await this.tick(options.report); }
        catch (error) { if (!this.stopped) options.report("", error instanceof Error ? error : new Error(String(error))); }
        if (this.stopped) break;
        try { await delay(this.identity.intervalMs, undefined, { signal: options.signal }); }
        catch (error) { if (!options.signal.aborted) throw error; }
      }
      if (this.terminal) { options.report("", this.terminal); throw this.terminal; }
    } finally { options.signal.removeEventListener("abort", stop); this.stop(); this.running = false; }
  }
}
