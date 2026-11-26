import { UUID_PATTERN } from "../coordination/wire.ts";
import { fields, record } from "../coordination/participant-protocol.ts";
import { validateGroupOperation } from "../storage/group-engine.ts";
import type { GroupCatalog, GroupReplay } from "../storage/types.ts";
import { counter } from "./replay-validation.ts";

export const groupUUID = (id: unknown): id is string => typeof id === "string" && UUID_PATTERN.test(id);
export function validCatalog(page: unknown, after: string): page is GroupCatalog {
  if (!record(page) || !fields(page, ["groups", "nextAfter"]) || !Array.isArray(page.groups) || page.groups.length > 16) return false;
  let previous = after;
  for (const g of page.groups) {
    if (!record(g) || !fields(g, ["groupId", "name", "membership", "invitationId"]) || !groupUUID(g.groupId) || g.groupId <= previous) return false;
    try { validateGroupOperation({ type: "group-create", name: g.name as string }); } catch { return false; }
    if (g.membership === "member" ? g.invitationId !== undefined : g.membership !== "invited" || !groupUUID(g.invitationId)) return false;
    previous = g.groupId;
  }
  return page.nextAfter === null || (page.groups.length > 0 && page.nextAfter === previous);
}
export function validGroupReplay(page: unknown, groupId: string, after: number): page is GroupReplay {
  if (!record(page) || !fields(page, ["groupId", "watermark", "scannedWatermark", "events"]) || page.groupId !== groupId
    || !counter(page.watermark) || !counter(page.scannedWatermark) || page.scannedWatermark < after || page.scannedWatermark > page.watermark
    || !Array.isArray(page.events) || page.events.length > 16 || page.events.length !== page.scannedWatermark - after
    || (page.events.length === 0 && page.watermark !== after)) return false;
  return page.events.every((e, i) => {
    if (!record(e) || !fields(e, ["seq", "generation", "lamport", "kind", "payload"]) || e.seq !== after + i + 1
      || !counter(e.generation) || e.generation < 1 || !counter(e.lamport) || e.lamport < 1 || !record(e.payload)) return false;
    const p = e.payload;
    if (!groupUUID(p.participantId)) return false;
    switch (e.kind) {
      case "group-created":
        try { validateGroupOperation({ type: "group-create", name: p.name as string }); return fields(p, ["participantId", "name"]); } catch { return false; }
      case "group-chat":
        try { validateGroupOperation({ type: "group-chat", groupId, content: p.content as string }); return fields(p, ["participantId", "content"]); } catch { return false; }
      case "group-invited": return fields(p, ["participantId", "invitedParticipantId", "invitationId"]) && groupUUID(p.invitedParticipantId) && groupUUID(p.invitationId);
      case "group-joined": case "group-left": return fields(p, ["participantId"]);
      default: return false;
    }
  });
}
