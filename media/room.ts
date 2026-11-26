/** Bounded single-meeting adapter. The supplied authorization callback must
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
const actions = new Set(["open", "connect", "produce", "list", "consume", "resume", "closeProducer", "closePeer"]);
interface PeerWork { revision: number; touched?: boolean; epoch?: string; owner?: object; cleanup?: { revision: number; work: Promise<void> } }
export class MediaRoom {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly peers = new Map<string, PeerWork>();
  private readonly effect: (request: MediaRequest) => Promise<unknown>;
  private closing?: Promise<void>;
  constructor(effect: (request: MediaRequest) => Promise<unknown>) { this.effect = effect; }
  private enqueue<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    // Revocation must never be dropped because ordinary work filled admission.
    if (!cleanup && this.waiting >= 16) return Promise.reject(new Error("MEDIA_BUSY"));
    this.waiting++;
    const result = this.tail.then(work).finally(() => { this.waiting--; });
    this.tail = result.catch(() => {}); return result;
  }
  handle(context: MediaContext, request: MediaRequest): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("MEDIA_CLOSED"));
    request = structuredClone(request);
    if (!request || !actions.has(request.action)) return Promise.reject(new Error("INVALID_MEDIA_ACTION"));
    if (this.waiting >= 16) return Promise.reject(new Error("MEDIA_BUSY"));
    let peer = this.peers.get(context.peerId);
    if (!peer) {
      if (this.peers.size >= 8) return Promise.reject(new Error("MEDIA_FULL"));
      peer = { revision: 0 }; this.peers.set(context.peerId, peer);
    }
    // Reserve at admission, including queued controls, so cleanup is both
    // bounded by eight known peers and ordered after the last admitted work.
    peer.revision++;
    const revision = peer.revision;
    return this.enqueue(async () => {
      // Negotiate BEFORE the read. An authorization from the previous worker
      // must never initialize a restarted, empty SFU with a historical owner.
      const hello = await this.effect({ action: "hello" }) as { epoch: string };
      if (!hello || typeof hello.epoch !== "string") throw new Error("INVALID_MEDIA_REPLY");
      const epoch = hello.epoch;
      if (!["open", "closePeer"].includes(request.action) && request.epoch !== epoch) throw new Error("SFU_RESTARTED");
      let current: MediaSnapshot;
      try { current = await context.authorize(); }
      catch (error) {
        // MeetingStore reports NOT_MEMBER only after current ACTIVE fencing and
        // credential authentication. Departure cannot publish, but may retire
        // this previously admitted peer under its exact installed owner/epoch.
        if (request.action !== 'closePeer' || !(error instanceof Error) || error.message !== 'NOT_MEMBER') throw error;
        if (peer.touched && peer.epoch === epoch) await this.effect({ action: 'closePeer', epoch: peer.epoch, owner: peer.owner, peerId: context.peerId });
        peer.touched = false;
        return { epoch, value: {} };
      }
      if (current.phase !== "ACTIVE" || !current.runtimeId || !current.incarnation || !current.attemptId) throw new Error("FENCED");
      if (!current.state.members[context.participantId]?.joined) throw new Error("NOT_MEMBER");
      if (request.action === "produce") {
        if (!context.ownsCapture()) throw new Error("NOT_CAPTURE_OWNER");
        if (!["mic", "camera", "screen"].includes(request.source as string)) throw new Error("INVALID_MEDIA_SOURCE");
        if (request.source === "screen" && (current.state.holder?.participantId !== context.participantId
          || current.state.holder.requestId !== request.requestId || current.state.grantVersion !== request.grantVersion)) throw new Error("STALE_GRANT");
      }
      const owner = { meetingId: current.meetingId, generation: current.generation, runtimeId: current.runtimeId, incarnation: current.incarnation, attemptId: current.attemptId };
      peer.epoch = epoch; peer.owner = owner;
      await this.effect({ action: "sync", epoch, owner, holder: current.state.holder, grantVersion: current.state.grantVersion, members: Object.keys(current.state.members).filter(id => current.state.members[id].joined) });
      // A lease may change while the remote reconciliation is outstanding.
      if (request.action === "produce" && !context.ownsCapture()) throw new Error("NOT_CAPTURE_OWNER");
      // Reserve uncertain effects too: a lost reply can still have allocated
      // resources. Definitive pre-effect rejections need no retained slot.
      peer.touched = true;
      const result = await this.effect({ ...request, epoch, owner, peerId: context.peerId, participantId: context.participantId });
      if (request.action === "closePeer") {
        peer.touched = false;
        if (peer.revision === revision) this.peers.delete(context.peerId);
      }
      return result;
    }).finally(() => {
      if (!peer.touched && peer.revision === revision && this.peers.get(context.peerId) === peer) this.peers.delete(context.peerId);
    });
  }
  revoke(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return Promise.resolve(); // An unused attachment has no SFU state.
    const revision = peer.revision;
    if (peer.cleanup?.revision === revision) return peer.cleanup.work;
    const work = this.enqueue(async () => {
      try { if (peer.epoch) await this.effect({ action: "closePeer", epoch: peer.epoch, owner: peer.owner, peerId }); }
      catch (error) { if (!(error instanceof Error) || error.message !== "SFU_RESTARTED") throw error; }
      // Uncertain teardown must retain its reservation for a later drain.
      if (peer.revision === revision) this.peers.delete(peerId);
    }, true).finally(() => { if (peer.cleanup?.work === work) peer.cleanup = undefined; });
    peer.cleanup = { revision, work }; return work;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.peers.keys()].map(id => this.revoke(id)));
      await this.tail;
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
  }
}
