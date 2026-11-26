import type { PoolClient } from "pg";
import { evaluateGroup, type GroupOperation, type GroupState } from "./group-engine.ts";
import type { MeetingState } from "./engine.ts";
import { StoreError, type MeetingCommand, type Outcome, type Owner } from "./types.ts";

/** Called only after authentication/original-outcome lookup, under the meeting
 * FOR UPDATE fence. Private state never enters the meeting snapshot/replay. */
export async function executeGroup(client: PoolClient, owner: Owner, meeting: MeetingState, command: MeetingCommand): Promise<Pick<Outcome, "code" | "groupId" | "groupSeq">> {
  const operation = command.operation as GroupOperation;
  const groupId = operation.type === "group-create" ? command.id : operation.groupId;
  const args = [owner.meetingId, groupId];
  const row = (await client.query("SELECT name,seq FROM zoom.groups WHERE meeting_id=$1 AND group_id=$2", args)).rows[0];
  let state: GroupState | null = null;
  if (row) {
    const members = await client.query("SELECT participant_id FROM zoom.group_members WHERE meeting_id=$1 AND group_id=$2", args);
    const invites = await client.query("SELECT participant_id,invitation_id FROM zoom.group_invitations WHERE meeting_id=$1 AND group_id=$2", args);
    state = { id: groupId, name: row.name, members: members.rows.map(r => r.participant_id), invitations: Object.fromEntries(invites.rows.map(r => [r.participant_id, r.invitation_id])) };
  }
  const result = evaluateGroup(state, meeting, command.participantId, command.id, operation);
  if (result.code !== "OK") return { code: result.code };
  let seq = Number(row?.seq ?? 0);
  if (result.event) {
    if (seq >= Number.MAX_SAFE_INTEGER - 5) throw new StoreError("SEQUENCE_EXHAUSTED");
    seq++;
    await client.query("INSERT INTO zoom.groups VALUES($1,$2,$3,$4) ON CONFLICT(meeting_id,group_id) DO UPDATE SET seq=excluded.seq", [...args, result.state!.name, seq]);
    await client.query("DELETE FROM zoom.group_members WHERE meeting_id=$1 AND group_id=$2", args);
    await client.query("DELETE FROM zoom.group_invitations WHERE meeting_id=$1 AND group_id=$2", args);
    await client.query("INSERT INTO zoom.group_members SELECT $1,$2,unnest($3::uuid[])", [...args, result.state!.members]);
    const invitations = Object.entries(result.state!.invitations);
    await client.query("INSERT INTO zoom.group_invitations SELECT $1,$2,unnest($3::uuid[]),unnest($4::uuid[])", [...args, invitations.map(([id]) => id), invitations.map(([, id]) => id)]);
    await client.query("INSERT INTO zoom.group_events VALUES($1,$2,$3,$4,$5,$6,$7)", [...args, seq, owner.generation, command.lamport, result.event.kind, result.event.payload]);
  }
  return { code: result.code, groupId, groupSeq: seq };
}
