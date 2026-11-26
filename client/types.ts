import type { MeetingCommand, Outcome, ParticipantCredential, Replay } from "../storage/types.ts";

export interface SessionTarget { clusterId: string; meetingId: string; name: string }
export interface ReplayCursor { meetingId: string; subscriptionRevision: number; seq: number }
export interface ParticipantTransport {
  execute(command: MeetingCommand): Promise<Outcome>;
  read(credential: ParticipantCredential, after: number, limit: number): Promise<Replay>;
  close(): void;
}
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "authority unavailable" | "left";
