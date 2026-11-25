import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HelperClient, type CommandResult, type HelperStatus, type MeetingMetadata, type MetadataCommand, type MetadataState } from "./helper-client.ts";
import type { MeetingStore, Owner } from "../storage/meeting-store.ts";

/** Trusted runtime adapter. Network authentication/routing belongs to the later gateway. */
export interface Candidate {
  runtimeId: string;
  incarnation: string;
  prepare(owner: Owner): Promise<void>;
}

export function ownerFor(clusterId: string, meeting: MeetingMetadata): Owner {
  if (!meeting.assignment) throw new Error("NO_ASSIGNMENT");
  const { runtimeId, incarnation, attemptId } = meeting.assignment;
  return { clusterId, meetingId: meeting.id, generation: meeting.generation, runtimeId, incarnation, attemptId };
}
export function matches(observed: { generation: number; runtimeId: string | null; incarnation: string | null; attemptId: string | null }, owner: Owner): boolean {
  return observed.generation === owner.generation && observed.runtimeId === owner.runtimeId && observed.incarnation === owner.incarnation && observed.attemptId === owner.attemptId;
}
export function commandFor(owner: Owner, kind: MetadataCommand["kind"], revision: number): MetadataCommand {
  return { id: randomUUID(), kind, meetingId: owner.meetingId, runtimeId: owner.runtimeId,
    incarnation: owner.incarnation, attemptId: owner.attemptId, expectedGeneration: owner.generation, expectedRevision: revision };
}
export async function commit(helper: HelperClient, command: MetadataCommand): Promise<CommandResult> {
  const result = await helper.call<CommandResult>("apply", { command });
  if (result.code !== "OK") throw new Error(result.code);
  return result;
}

/** One helper's leader-local worker; a follower cannot pass the read barrier.
 * Each tick advances at most one durable stage. Retry from a fresh read after
 * any uncertainty. No SQL lock spans a coordinator or runtime call.
 */
export class RecoveryController {
  private readonly helper: HelperClient;
  private readonly store: MeetingStore;
  private readonly clusterId: string;
  private readonly suspicionMs: number;
  private readonly now: () => number;
  private epoch = "";
  private observations = new Map<string, { key: string; since: number }>();
  private busy = false;

  constructor(helper: HelperClient, store: MeetingStore, options: { clusterId: string; suspicionMs?: number; now?: () => number }) {
    this.helper = helper; this.store = store; this.clusterId = options.clusterId;
    this.suspicionMs = options.suspicionMs ?? 5000; this.now = options.now ?? (() => performance.now());
    if (!Number.isFinite(this.suspicionMs) || this.suspicionMs <= 0) throw new Error("Invalid suspicion interval");
  }

  async tick(meetingId: string, candidates: readonly Candidate[]): Promise<string> {
    if (this.busy) throw new Error("Reconciliation already running");
    this.busy = true;
    let authoritative = false;
    try {
      const before = await this.helper.call<HelperStatus>("status");
      const state = await this.helper.call<MetadataState>("read");
      const after = await this.helper.call<HelperStatus>("status");
      if (state.cluster !== this.clusterId || before.role !== "Leader" || after.role !== "Leader"
        || before.term !== after.term || before.incarnation !== after.incarnation) throw new Error("LEADERSHIP_UNCERTAIN");
      authoritative = true;
      const epoch = `${after.id}:${after.incarnation}:${after.term}`;
      if (epoch !== this.epoch) { this.epoch = epoch; this.observations.clear(); }
      const meeting = state.meetings[meetingId];
      if (!meeting) throw new Error("UNKNOWN_MEETING");
      const a = meeting.assignment;
      const key = `${meeting.generation}:${a?.phase}:${a?.renewalRevision}`;
      let observation = this.observations.get(meetingId);
      if (!observation || observation.key !== key) {
        observation = { key, since: this.now() }; this.observations.set(meetingId, observation);
      }
      const eligible = candidates.filter(c => state.runtimes[c.runtimeId]?.incarnation === c.incarnation);
      if (!a || this.now() - observation.since >= this.suspicionMs) {
        const candidate = eligible.find(c => !a || c.runtimeId !== a.runtimeId || c.incarnation !== a.incarnation);
        if (!candidate) return "UNAVAILABLE";
        await commit(this.helper, { id: randomUUID(), kind: "assign", meetingId, runtimeId: candidate.runtimeId,
          incarnation: candidate.incarnation, attemptId: randomUUID(), expectedGeneration: meeting.generation, expectedRevision: a?.renewalRevision ?? 0 });
        return "ASSIGNED";
      }
      const owner = ownerFor(this.clusterId, meeting);
      let sql;
      try { sql = await this.store.observe(meetingId); }
      catch (error) {
        if (error instanceof Error && error.message === "MISSING_MEETING" && meeting.generation === 1 && a.phase === "CANDIDATE") {
          await this.store.create(meetingId, meeting.code); return "CREATED";
        }
        throw error;
      }
      if (a.phase === "READY") {
        if (!matches(sql, owner) || sql.phase !== "ACTIVE") throw new Error("SQL_AUTHORITY_MISMATCH");
        return "READY";
      }
      const candidate = eligible.find(c => c.runtimeId === a.runtimeId && c.incarnation === a.incarnation);
      if (!candidate) return "UNAVAILABLE";
      if (a.phase === "CANDIDATE") {
        if (!matches(sql, owner)) { await this.store.install(owner); return "FENCED"; }
        if (sql.phase !== "RECOVERING") throw new Error("SQL_PHASE_CONFLICT");
        await candidate.prepare(Object.freeze({ ...owner }));
        await commit(this.helper, commandFor(owner, "activation-intent", a.renewalRevision));
        return "INTENT";
      }
      await candidate.prepare(Object.freeze({ ...owner }));
      if (!matches(sql, owner)) throw new Error("SQL_AUTHORITY_MISMATCH");
      if (sql.phase === "RECOVERING") { await this.store.activate(owner); return "ACTIVE"; }
      if (sql.phase !== "ACTIVE") throw new Error("SQL_PHASE_CONFLICT");
      await commit(this.helper, commandFor(owner, "confirm-ready", a.renewalRevision));
      return "READY";
    } catch (error) {
      // Uncertain leadership gets a fresh suspicion grace on the next success.
      if (!authoritative) this.epoch = "";
      throw error;
    } finally { this.busy = false; }
  }

  /** Headless bounded loop. Errors remain observations; they never bypass a stage. */
  async run(meetings: () => Promise<string[]>, candidates: () => Promise<readonly Candidate[]>, options: {
    signal: AbortSignal; intervalMs?: number; report(meetingId: string, result: string | Error): void;
  }): Promise<void> {
    while (!options.signal.aborted) {
      try {
        const available = await candidates();
        for (const id of await meetings()) {
          if (options.signal.aborted) break;
          try { options.report(id, await this.tick(id, available)); }
          catch (error) { options.report(id, error instanceof Error ? error : new Error(String(error))); }
        }
      } catch (error) { options.report("", error instanceof Error ? error : new Error(String(error))); }
      try { await delay(options.intervalMs ?? 100, undefined, { signal: options.signal }); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  }
}
