/** Experimental single-meeting adapter. The supplied authorization callback must
 * perform a fresh RuntimeAuthority/SQL read, never an administrative observation
 * or a retained ClientSession snapshot. Effects run after that transaction ends. */
export interface MediaSnapshot {
  meetingId: string; generation: number; runtimeId: string | null;
  incarnation: string | null; attemptId: string | null; phase: string;
  state: { members: Record<string, { joined: boolean }>; holder: { participantId: string; requestId: string } | null; grantVersion: number };
}
export interface MediaContext {
  peerId: string; participantId: string;
  ownsCapture(): boolean;
  authorize(): Promise<MediaSnapshot>;
}
export interface MediaRequest { action: string; [key: string]: unknown }
const actions = new Set(["open", "connect", "produce", "list", "consume", "resume", "closeProducer"]);
export class MediaRoom {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly peers = new Set<string>();
  private readonly effect: (request: MediaRequest) => Promise<unknown>;
  constructor(effect: (request: MediaRequest) => Promise<unknown>) { this.effect = effect; }
  private enqueue<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    // Revocation must never be dropped because ordinary work filled admission.
    if (!cleanup && this.waiting >= 16) return Promise.reject(new Error("MEDIA_BUSY"));
    this.waiting++;
    const result = this.tail.then(work).finally(() => { this.waiting--; });
    this.tail = result.catch(() => {}); return result;
  }
  handle(context: MediaContext, request: MediaRequest): Promise<unknown> {
    request = structuredClone(request);
    if (!request || !actions.has(request.action)) return Promise.reject(new Error("INVALID_MEDIA_ACTION"));
    return this.enqueue(async () => {
      const current = await context.authorize();
      if (current.phase !== "ACTIVE" || !current.runtimeId || !current.incarnation || !current.attemptId) throw new Error("FENCED");
      if (!current.state.members[context.participantId]?.joined) throw new Error("NOT_MEMBER");
      if (request.action === "produce") {
        if (!context.ownsCapture()) throw new Error("NOT_CAPTURE_OWNER");
        if (!["mic", "camera", "screen"].includes(request.source as string)) throw new Error("INVALID_MEDIA_SOURCE");
        if (request.source === "screen" && (current.state.holder?.participantId !== context.participantId
          || current.state.holder.requestId !== request.requestId || current.state.grantVersion !== request.grantVersion)) throw new Error("STALE_GRANT");
      }
      if (!this.peers.has(context.peerId) && this.peers.size >= 8) throw new Error("MEDIA_FULL");
      const owner = { meetingId: current.meetingId, generation: current.generation, runtimeId: current.runtimeId, incarnation: current.incarnation, attemptId: current.attemptId };
      await this.effect({ action: "sync", owner, holder: current.state.holder, grantVersion: current.state.grantVersion, members: Object.keys(current.state.members).filter(id => current.state.members[id].joined) });
      // A lease may change while the remote reconciliation is outstanding.
      if (request.action === "produce" && !context.ownsCapture()) throw new Error("NOT_CAPTURE_OWNER");
      this.peers.add(context.peerId);
      return this.effect({ ...request, owner, peerId: context.peerId, participantId: context.participantId });
    });
  }
  revoke(peerId: string): Promise<void> {
    return this.enqueue(async () => { try { await this.effect({ action: "closePeer", peerId }); } finally { this.peers.delete(peerId); } }, true);
  }
}
