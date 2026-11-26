import { isIP } from "node:net";
import { UUID_PATTERN } from "./wire.ts";
import type { Owner } from "../storage/types.ts";

export const PARTICIPANT_PROTOCOL = "zoom.participant.v1";
export const PARTICIPANT_REQUEST_BYTES = 64 * 1024;
export function participantURL(address: string): URL {
  const url = new URL(`ws://${address}/v1/participant`), host = url.hostname.replace(/^\[|\]$/g, "");
  if (!((isIP(host) === 4 && host.startsWith("127.")) || host === "::1") || !url.port || url.username || url.password
    || url.pathname !== "/v1/participant" || url.search || url.hash) throw new Error("INVALID_PARTICIPANT_ADDRESS");
  return url;
}
export function participantTimeout(value = 4000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw new Error("INVALID_PARTICIPANT_TIMEOUT");
  return value;
}
export function participantToken(token: string): void {
  if (typeof token !== "string" || Buffer.byteLength(token) < 32 || /[\r\n]/.test(token)) throw new Error("INVALID_PARTICIPANT_TOKEN");
}
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function fields(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(k => keys.includes(k)); }
export function validParticipantOwner(value: unknown): value is Owner {
  return record(value) && fields(value, ["clusterId", "meetingId", "runtimeId", "incarnation", "attemptId", "generation"])
    && [value.clusterId, value.meetingId, value.runtimeId, value.incarnation, value.attemptId].every(id => typeof id === "string" && UUID_PATTERN.test(id))
    && Number.isSafeInteger(value.generation) && (value.generation as number) > 0;
}
export function sameOwner(a: Owner, b: Owner): boolean {
  return a.clusterId === b.clusterId && a.meetingId === b.meetingId && a.generation === b.generation
    && a.runtimeId === b.runtimeId && a.incarnation === b.incarnation && a.attemptId === b.attemptId;
}
