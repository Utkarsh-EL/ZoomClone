import type { HelperAccess, MetadataState } from "./helper-client.ts";
import { matches } from "./recovery-controller.ts";
import type { MeetingStore } from "../storage/meeting-store.ts";
import type { Owner } from "../storage/types.ts";

export type MeetingResolution = { status: "unknown" | "unavailable" } | { status: "ready"; owner: Owner };

/** A bounded observation of authority. Runtime readiness and every SQL fence
 * are still checked at service time. Never accepts a discovery hint as input. */
export async function resolveMeeting(clusterId: string, code: string, helper: HelperAccess,
  store: Pick<MeetingStore, "observe">): Promise<MeetingResolution> {
  try {
    const state = await helper.call<MetadataState>("read");
    if (state.cluster !== clusterId) return { status: "unavailable" };
    const meeting = Object.values(state.meetings).find(m => m.code === code);
    if (!meeting) return { status: "unknown" };
    const assignment = meeting.assignment;
    if (!assignment || assignment.phase !== "READY") return { status: "unavailable" };
    const owner: Owner = { clusterId, meetingId: meeting.id, generation: meeting.generation,
      runtimeId: assignment.runtimeId, incarnation: assignment.incarnation, attemptId: assignment.attemptId };
    const sql = await store.observe(meeting.id);
    if (sql.phase !== "ACTIVE" || !matches(sql, owner)) return { status: "unavailable" };
    return { status: "ready", owner };
  } catch { return { status: "unavailable" }; }
}
