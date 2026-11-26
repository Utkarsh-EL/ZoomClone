import { UUID_PATTERN } from "../coordination/wire.ts";
import { validateOperation, type MeetingState } from "./engine.ts";

export type GroupOperation =
  | { type: "group-create"; name: string }
  | { type: "group-invite"; groupId: string; participantId: string }
  | { type: "group-join"; groupId: string; invitationId: string }
  | { type: "group-chat"; groupId: string; content: string }
  | { type: "group-leave"; groupId: string };

/** Private state for one group, separate from the public meeting snapshot.
 * Membership and invitation IDs are durable participant/command identities. */
export interface GroupState {
  id: string;
  name: string;
  members: string[];
  invitations: Record<string, string>;
}
export interface GroupEvaluation {
  code: string;
  state: GroupState | null;
  event?: {
    groupId: string;
    kind: "group-created" | "group-invited" | "group-joined" | "group-chat" | "group-left";
    payload: Record<string, unknown>;
  };
}

function uuid(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function validateGroupOperation(operation: GroupOperation): void {
  if (!operation || typeof operation !== "object" || Array.isArray(operation))
    throw new Error("Invalid group operation");
  const fields: Record<string, string[]> = {
    "group-create": ["type", "name"],
    "group-invite": ["type", "groupId", "participantId"],
    "group-join": ["type", "groupId", "invitationId"],
    "group-chat": ["type", "groupId", "content"],
    "group-leave": ["type", "groupId"],
  };
  if (typeof operation.type !== "string" || !Object.hasOwn(fields, operation.type))
    throw new Error("Invalid group operation");
  const allowed = fields[operation.type];
  if (Object.keys(operation).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(operation, key)))
    throw new Error("Invalid group operation fields");
  if (operation.type === "group-create") {
    validateOperation({ type: "join", name: operation.name });
    return;
  }
  if (!uuid(operation.groupId)) throw new Error("Invalid group ID");
  switch (operation.type) {
    case "group-invite":
      if (!uuid(operation.participantId)) throw new Error("Invalid invited participant ID");
      break;
    case "group-join":
      if (!uuid(operation.invitationId)) throw new Error("Invalid invitation ID");
      break;
    case "group-chat":
      validateOperation({ type: "chat", content: operation.content });
      break;
  }
}

/** Pure internal decisions, not a participant DTO or an authorization token.
 * The store must authenticate and resolve original outcomes before evaluation,
 * persist decisions under the meeting fence, and authorize every history read.
 * Events belong only in group history, never in revision-zero meeting replay.
 * Meeting departure must remove group memberships/invitations transactionally.
 */
export function evaluateGroup(
  input: GroupState | null,
  meeting: Pick<MeetingState, "members">,
  participantId: string,
  commandId: string,
  operation: GroupOperation,
): GroupEvaluation {
  validateGroupOperation(operation);
  if (!uuid(participantId) || !uuid(commandId)) throw new Error("Invalid command identity");
  const state = structuredClone(input);
  const result: GroupEvaluation = { code: "OK", state };
  const reject = (code: string): GroupEvaluation => ({ ...result, code });
  const event = (kind: NonNullable<GroupEvaluation["event"]>["kind"], payload: Record<string, unknown>) => {
    result.event = { groupId: result.state!.id, kind, payload };
  };

  if (!meeting.members[participantId]?.joined) return reject("NOT_MEMBER");
  if (operation.type === "group-create") {
    if (state) return reject("GROUP_EXISTS");
    result.state = { id: commandId, name: operation.name, members: [participantId], invitations: {} };
    event("group-created", { participantId, name: operation.name });
    return result;
  }
  if (!state || state.id !== operation.groupId) return reject("GROUP_ACCESS_DENIED");
  const member = state.members.includes(participantId);
  if (operation.type === "group-join") {
    if (member) return result;
    if (state.invitations[participantId] !== operation.invitationId) return reject("GROUP_ACCESS_DENIED");
    delete state.invitations[participantId];
    state.members.push(participantId);
    event("group-joined", { participantId });
    return result;
  }
  if (!member) return reject("GROUP_ACCESS_DENIED");
  switch (operation.type) {
    case "group-invite":
      if (!meeting.members[operation.participantId]?.joined) return reject("INVITEE_NOT_MEMBER");
      if (state.members.includes(operation.participantId) || state.invitations[operation.participantId]) return result;
      state.invitations[operation.participantId] = commandId;
      event("group-invited", { participantId, invitedParticipantId: operation.participantId, invitationId: commandId });
      break;
    case "group-chat":
      event("group-chat", { participantId, content: operation.content });
      break;
    case "group-leave":
      state.members = state.members.filter(id => id !== participantId);
      event("group-left", { participantId });
      break;
  }
  return result;
}
