import type { MeetingState, Operation } from "./engine.ts";

export interface Owner {
  clusterId: string;
  meetingId: string;
  generation: number;
  runtimeId: string;
  incarnation: string;
  attemptId: string;
}
export interface Authority {
  owner: Owner;
  ready(): boolean;
}
export interface ParticipantCredential {
  participantId: string;
  secret: string;
}
export interface MeetingCommand extends ParticipantCredential {
  id: string;
  lamport: number;
  operation: Operation;
}
export interface Outcome {
  code: string;
  seq: number;
  generation: number;
  grantVersion: number;
  groupId?: string;
  groupSeq?: number;
}
export interface GroupSummary {
  groupId: string;
  name: string;
  membership: "member" | "invited";
  invitationId?: string;
}
export interface GroupCatalog { groups: GroupSummary[]; nextAfter: string | null }
export interface GroupReplay { groupId: string; watermark: number; scannedWatermark: number; events: MeetingEvent[] }
export interface MeetingEvent {
  seq: number;
  generation: number;
  lamport: number;
  kind: string;
  payload: Record<string, unknown>;
}
export interface Observation {
  meetingId: string;
  code: string;
  generation: number;
  runtimeId: string | null;
  incarnation: string | null;
  attemptId: string | null;
  phase: "INITIALIZING" | "RECOVERING" | "ACTIVE" | "CLOSED";
  watermark: number;
  state: MeetingState;
  observedAt: string;
}
export interface Replay extends Observation {
  events: MeetingEvent[];
  scannedWatermark: number;
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "StoreError";
    this.code = code;
  }
}
