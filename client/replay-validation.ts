import { UUID_PATTERN } from "../coordination/wire.ts";
import { fields, record } from "../coordination/participant-protocol.ts";
import { validateOperation } from "../storage/engine.ts";
import type { Replay } from "../storage/types.ts";

export const counter = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < Number.MAX_SAFE_INTEGER - 4;
const uuid = (id: unknown): id is string => typeof id === "string" && UUID_PATTERN.test(id);
function name(value: unknown): boolean {
  try { validateOperation({ type: "join", name: value as string }); return true; } catch { return false; }
}
function content(value: unknown): boolean {
  try { validateOperation({ type: "chat", content: value as string }); return true; } catch { return false; }
}
function share(value: unknown): boolean {
  return record(value) && fields(value, ["participantId", "requestId"]) && uuid(value.participantId) && uuid(value.requestId);
}
function sharing(value: Record<string, unknown>): boolean {
  return (value.holder === null || share(value.holder)) && Array.isArray(value.queue) && value.queue.length <= 128
    && value.queue.every(share) && counter(value.grantVersion);
}
function state(value: unknown): boolean {
  return record(value) && fields(value, ["members", "holder", "queue", "grantVersion"]) && record(value.members)
    && Object.keys(value.members).length <= 128 && Object.entries(value.members).every(([id, member]) => uuid(id)
      && record(member) && fields(member, ["name", "joined"]) && name(member.name) && typeof member.joined === "boolean") && sharing(value);
}
function event(value: unknown): boolean {
  if (!record(value) || !fields(value, ["seq", "generation", "lamport", "kind", "payload"]) || !counter(value.seq) || value.seq < 1
    || !counter(value.generation) || value.generation < 1 || !counter(value.lamport) || value.lamport < 1 || !record(value.payload)) return false;
  const p = value.payload;
  switch (value.kind) {
    case "joined": return fields(p, ["participantId", "name"]) && uuid(p.participantId) && name(p.name);
    case "chat": return fields(p, ["participantId", "content"]) && uuid(p.participantId) && content(p.content);
    case "share-changed": return fields(p, ["holder", "queue", "grantVersion"]) && sharing(p);
    case "left": return fields(p, ["participantId", "holder", "queue", "grantVersion"]) && uuid(p.participantId) && sharing(p);
    default: return false;
  }
}

/** Validate the current unfiltered participant DTO before any durable cursor
 * change. Protocol extensions must explicitly extend this revision's schema. */
export function validReplay(value: unknown): value is Replay {
  if (!record(value) || !fields(value, ["meetingId", "code", "generation", "runtimeId", "incarnation", "attemptId", "phase", "watermark", "state", "observedAt", "events", "scannedWatermark"])) return false;
  return uuid(value.meetingId) && typeof value.code === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value.code)
    && counter(value.generation) && value.generation > 0 && uuid(value.runtimeId) && uuid(value.incarnation) && uuid(value.attemptId)
    && value.phase === "ACTIVE" && counter(value.watermark) && counter(value.scannedWatermark) && value.scannedWatermark <= value.watermark
    && typeof value.observedAt === "string" && value.observedAt.length <= 30 && Number.isFinite(Date.parse(value.observedAt))
    && state(value.state) && Array.isArray(value.events) && value.events.length <= 200 && value.events.every(e => event(e) && e.generation <= value.generation!);
}
