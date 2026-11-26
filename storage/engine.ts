import { UUID_PATTERN } from "../coordination/wire.ts";
import { validateGroupOperation, type GroupOperation } from "./group-engine.ts";

export interface ShareRequest {
  participantId: string;
  requestId: string;
}
export interface MeetingState {
  members: Record<string, { name: string; joined: boolean }>;
  holder: ShareRequest | null;
  queue: ShareRequest[];
  grantVersion: number;
}
export type MeetingOperation =
  | { type: "join"; name: string }
  | { type: "chat"; content: string }
  | { type: "request-share" }
  | { type: "release-share"; requestId: string }
  | { type: "leave" };
export type Operation = MeetingOperation | GroupOperation;
export interface Evaluation {
  code: string;
  state: MeetingState;
  event?: { kind: string; payload: Record<string, unknown> };
  mediaChanged: boolean;
}

export function emptyState(): MeetingState {
  return { members: {}, holder: null, queue: [], grantVersion: 0 };
}

export function validateOperation(operation: Operation): void {
  if (!operation || typeof operation !== "object" || Array.isArray(operation))
    throw new Error("Invalid operation");
  if (typeof operation.type === "string" && operation.type.startsWith("group-")) {
    validateGroupOperation(operation as GroupOperation); return;
  }
  const fields: Record<string, string[]> = {
    join: ["type", "name"],
    chat: ["type", "content"],
    "request-share": ["type"],
    "release-share": ["type", "requestId"],
    leave: ["type"],
  };
  const allowed = typeof operation.type === "string" && Object.hasOwn(fields, operation.type) ? fields[operation.type] : undefined;
  if (!allowed || Object.keys(operation).some((key) => !allowed.includes(key)))
    throw new Error("Invalid operation fields");
  if (
    operation.type === "join" &&
    (typeof operation.name !== "string" ||
      !operation.name.trim() ||
      Buffer.byteLength(operation.name) > 200 ||
      /[\u0000-\u001f]/.test(operation.name))
  )
    throw new Error("Invalid display name");
  if (
    operation.type === "chat" &&
    (typeof operation.content !== "string" ||
      !operation.content.trim() ||
      Buffer.byteLength(operation.content) > 8192 ||
      operation.content.includes("\0"))
  )
    throw new Error("Invalid chat content");
  if (
    operation.type === "release-share" &&
    (typeof operation.requestId !== "string" ||
      !UUID_PATTERN.test(operation.requestId))
  )
    throw new Error("Invalid share request ID");
}

/** Pure evaluation: callers can roll back without changing their input state. */
export function evaluate(
  input: MeetingState,
  participantId: string,
  commandId: string,
  operation: MeetingOperation,
): Evaluation {
  validateOperation(operation);
  if (!UUID_PATTERN.test(participantId) || !UUID_PATTERN.test(commandId))
    throw new Error("Invalid command identity");
  const state = structuredClone(input);
  const result: Evaluation = { code: "OK", state, mediaChanged: false };
  const member = state.members[participantId];
  const event = (kind: string, payload: Record<string, unknown>) => {
    result.event = { kind, payload };
  };
  const handoff = () => {
    if (state.grantVersion >= Number.MAX_SAFE_INTEGER - 1)
      throw new Error("Grant version exhausted");
    state.holder = state.queue.shift() ?? null;
    state.grantVersion++;
    result.mediaChanged = true;
  };
  if (operation.type === "join") {
    if (member?.name && member.name !== operation.name) {
      result.code = "NAME_MISMATCH";
      return result;
    }
    if (member?.joined) return result;
    if (
      Object.values(state.members).filter((entry) => entry.joined).length >= 128
    ) {
      result.code = "MEETING_FULL";
      return result;
    }
    state.members[participantId] = { name: operation.name, joined: true };
    event("joined", { participantId, name: operation.name });
    return result;
  }
  if (!member?.joined) {
    result.code = "NOT_MEMBER";
    return result;
  }
  switch (operation.type) {
    case "chat":
      event("chat", { participantId, content: operation.content });
      break;
    case "request-share": {
      if (
        state.holder?.participantId === participantId ||
        state.queue.some((r) => r.participantId === participantId)
      )
        return result;
      state.queue.push({ participantId, requestId: commandId });
      if (!state.holder) handoff();
      event("share-changed", {
        holder: state.holder,
        queue: state.queue,
        grantVersion: state.grantVersion,
      });
      break;
    }
    case "release-share": {
      const holder = state.holder;
      if (
        holder?.participantId === participantId &&
        holder.requestId === operation.requestId
      )
        handoff();
      else {
        const index = state.queue.findIndex(
          (r) =>
            r.participantId === participantId &&
            r.requestId === operation.requestId,
        );
        if (index < 0) {
          result.code = "STALE_REQUEST";
          return result;
        }
        state.queue.splice(index, 1);
      }
      event("share-changed", {
        holder: state.holder,
        queue: state.queue,
        grantVersion: state.grantVersion,
      });
      break;
    }
    case "leave":
      member.joined = false;
      state.queue = state.queue.filter(
        (r) => r.participantId !== participantId,
      );
      if (state.holder?.participantId === participantId) handoff();
      event("left", {
        participantId,
        holder: state.holder,
        queue: state.queue,
        grantVersion: state.grantVersion,
      });
      break;
  }
  return result;
}
