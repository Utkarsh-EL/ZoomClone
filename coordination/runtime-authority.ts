import type { Authority, MeetingStore, Owner } from "../storage/meeting-store.ts";
import type { HelperAccess, MetadataState } from "./helper-client.ts";
import { commandFor, commit, matches } from "./recovery-controller.ts";

/** Local readiness is a bounded observation; every domain transaction still
 * validates the SQL fence. Restart creates an unready gate. */
export class RuntimeAuthority implements Authority {
  readonly owner: Readonly<Owner>;
  private readonly helper: HelperAccess;
  private readonly store: Pick<MeetingStore, "observe">;
  private readonly now: () => number;
  private readonly readinessMs: number;
  private until = -Infinity;
  private busy = false;
  private revision = 0;
  constructor(helper: HelperAccess, store: Pick<MeetingStore, "observe">, owner: Owner, options: { readinessMs?: number; now?: () => number } = {}) {
    this.helper = helper; this.store = store; this.owner = Object.freeze({ ...owner });
    this.now = options.now ?? (() => performance.now()); this.readinessMs = options.readinessMs ?? 2000;
    if (!Number.isFinite(this.readinessMs) || this.readinessMs <= 0) throw new Error("Invalid readiness interval");
  }
  ready(): boolean { return this.now() < this.until; }
  stop(): void { this.until = -Infinity; this.revision++; }
  async renew(): Promise<void> {
    if (this.busy) throw new Error("Renewal already running");
    this.busy = true; this.stop();
    const revision = this.revision;
    const started = this.now();
    try {
      const state = await this.helper.call<MetadataState>("read");
      const meeting = state.meetings[this.owner.meetingId];
      if (state.cluster !== this.owner.clusterId || !meeting || !meeting.assignment || !matches({ generation: meeting.generation, ...meeting.assignment }, this.owner)) throw new Error("ASSIGNMENT_CONFLICT");
      if (meeting.assignment.phase !== "READY") throw new Error("NOT_READY");
      await commit(this.helper, commandFor(this.owner, "renew", meeting.assignment.renewalRevision));
      const sql = await this.store.observe(this.owner.meetingId);
      if (!matches(sql, this.owner) || sql.phase !== "ACTIVE") throw new Error("FENCED");
      if (revision !== this.revision) return;
      this.until = started + this.readinessMs;
      if (!this.ready()) { this.stop(); throw new Error("READINESS_EXPIRED"); }
    } finally { this.busy = false; }
  }
}
