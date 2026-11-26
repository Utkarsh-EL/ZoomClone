import WebSocket from "ws";
import type { HelperAccess, MetadataState } from "../coordination/helper-client.ts";
import { ControlWire, MAX_ENVELOPE_BYTES, type Identity } from "../coordination/wire.ts";
import { record, validParticipantOwner, sameOwner, participantURL, participantTimeout, participantToken, PARTICIPANT_PROTOCOL } from "../coordination/participant-protocol.ts";
import type { MeetingCommand, Outcome, Owner, ParticipantCredential, Replay } from "../storage/types.ts";
import { validOutcome } from "./session-journal.ts";
import type { ParticipantTransport } from "./types.ts";

export interface ParticipantRoute { runtimeId: string; incarnation: string; address: string; token: string }
interface Options { owner: Owner; address: string; token: string; identity: Identity; timeoutMs?: number }

/** One bounded request in flight. Disconnects are uncertain; only ClientSession
 * may retry, using a command already committed to its journal. */
export class ParticipantConnection implements ParticipantTransport {
  private readonly socket: WebSocket;
  private readonly wire: ControlWire;
  private readonly owner: Owner;
  private readonly timeoutMs: number;
  private pending?: { requestId: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private constructor(socket: WebSocket, wire: ControlWire, owner: Owner, timeoutMs: number) {
    this.socket = socket; this.wire = wire; this.owner = { ...owner }; this.timeoutMs = timeoutMs;
    socket.on("error", () => this.fail(new Error("PARTICIPANT_UNAVAILABLE")));
    socket.on("close", () => this.fail(new Error("PARTICIPANT_CLOSED")));
    socket.on("message", (data, binary) => {
      const pending = this.pending;
      try {
        if (!pending || binary) throw new Error("INVALID_PARTICIPANT_REPLY");
        const packet = wire.receive(JSON.parse(data.toString()), pending.requestId, owner.runtimeId);
        if (packet.incarnation !== owner.incarnation) throw new Error("INCARNATION_MISMATCH");
        if (packet.error) { this.fail(new Error(packet.error.code)); return; }
        if (!record(packet.body) || !validParticipantOwner(packet.body.owner) || !sameOwner(packet.body.owner, owner)) throw new Error("FENCED_REPLY");
        clearTimeout(pending.timer); this.pending = undefined; pending.resolve(packet.body.result);
      } catch (error) { this.fail(error instanceof Error ? error : new Error("INVALID_PARTICIPANT_REPLY")); socket.terminate(); }
    });
  }
  static async connect(options: Options, sharedWire?: ControlWire): Promise<ParticipantConnection> {
    const url = participantURL(options.address); participantToken(options.token);
    if (!validParticipantOwner(options.owner) || options.owner.clusterId !== options.identity.clusterId) throw new Error("INVALID_PARTICIPANT_OWNER");
    const wire = sharedWire ?? new ControlWire(options.identity), timeoutMs = participantTimeout(options.timeoutMs);
    if (wire.identity.clusterId !== options.identity.clusterId || wire.identity.nodeId !== options.identity.nodeId || wire.identity.incarnation !== options.identity.incarnation) throw new Error("PARTICIPANT_WIRE_MISMATCH");
    const socket = new WebSocket(url, PARTICIPANT_PROTOCOL, { headers: { Authorization: `Bearer ${options.token}` }, handshakeTimeout: timeoutMs,
      maxPayload: MAX_ENVELOPE_BYTES, perMessageDeflate: false, followRedirects: false });
    const connection = new ParticipantConnection(socket, wire, options.owner, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const opened = () => { clean(); resolve(); };
      const failed = () => { clean(); socket.terminate(); reject(new Error("PARTICIPANT_UNAVAILABLE")); };
      const clean = () => { socket.removeListener("open", opened); socket.removeListener("error", failed); socket.removeListener("close", failed); };
      socket.once("open", opened); socket.once("error", failed); socket.once("close", failed);
    });
    return connection;
  }
  private fail(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); const { reject } = this.pending; this.pending = undefined; reject(error);
  }
  close(): void { this.fail(new Error("PARTICIPANT_CLOSED")); this.socket.terminate(); }
  private call(body: object): Promise<unknown> {
    if (this.pending) return Promise.reject(new Error("PARTICIPANT_BUSY"));
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("PARTICIPANT_CLOSED"));
    const packet = this.wire.request({ version: 1, owner: this.owner, ...body });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error("PARTICIPANT_TIMEOUT")); this.socket.terminate(); }, this.timeoutMs);
      this.pending = { requestId: packet.requestId, resolve, reject, timer };
      this.socket.send(JSON.stringify(packet), error => { if (error) { this.fail(new Error("PARTICIPANT_UNAVAILABLE")); this.socket.terminate(); } });
    });
  }
  async execute(command: MeetingCommand): Promise<Outcome> {
    const value = await this.call({ operation: "execute", command });
    if (!validOutcome(value)) throw new Error("INVALID_OUTCOME"); return value;
  }
  async read(credential: ParticipantCredential, after: number, limit: number): Promise<Replay> {
    const value = await this.call({ operation: "read", credential: { participantId: credential.participantId, secret: credential.secret }, after, limit, subscriptionRevision: 0 });
    if (!record(value) || value.meetingId !== this.owner.meetingId || value.generation !== this.owner.generation
      || value.runtimeId !== this.owner.runtimeId || value.incarnation !== this.owner.incarnation || value.attemptId !== this.owner.attemptId) throw new Error("FENCED_REPLY");
    return value as unknown as Replay;
  }
}

/** READY metadata is a routing observation. The gateway validates readiness and
 * SQL ownership afresh; no participant receives PostgreSQL credentials. */
export function participantResolver(options: Identity & { meetingId: string; helper: HelperAccess; routes: readonly ParticipantRoute[]; timeoutMs?: number }, sharedWire?: ControlWire): () => Promise<ParticipantTransport> {
  const identity = { clusterId: options.clusterId, nodeId: options.nodeId, incarnation: options.incarnation };
  const wire = sharedWire ?? new ControlWire(identity), routes = structuredClone(options.routes);
  if (!routes.length || routes.length > 128) throw new Error("INVALID_PARTICIPANT_ROUTES");
  return async () => {
    let state: MetadataState;
    try { state = await options.helper.call<MetadataState>("read"); }
    catch { throw new Error("AUTHORITY_UNAVAILABLE"); }
    const meeting = state.meetings[options.meetingId], assignment = meeting?.assignment;
    if (state.cluster !== identity.clusterId || !assignment || assignment.phase !== "READY") throw new Error("AUTHORITY_UNAVAILABLE");
    const route = routes.find(r => r.runtimeId === assignment.runtimeId && r.incarnation === assignment.incarnation);
    if (!route) throw new Error("AUTHORITY_UNAVAILABLE");
    const owner: Owner = { clusterId: identity.clusterId, meetingId: meeting.id, generation: meeting.generation,
      runtimeId: assignment.runtimeId, incarnation: assignment.incarnation, attemptId: assignment.attemptId };
    return ParticipantConnection.connect({ owner, ...route, identity, timeoutMs: options.timeoutMs }, wire);
  };
}
