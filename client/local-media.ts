import type { MediaRequest } from "../media/room.ts";

/** One bridge per shared participant agent. Serialize local lease teardown with
 * fresh route selection, so a runtime change cannot bypass pending revocation. */
export class LocalMediaBridge {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly peers = new Map<string, { revision: number; dirty: boolean; cleanup?: { revision: number; work: Promise<void> } }>();
  private closing?: Promise<void>;
  private readonly send: (peerId: string, request: MediaRequest, owns: boolean) => Promise<unknown>;
  constructor(send: (peerId: string, request: MediaRequest, owns: boolean) => Promise<unknown>) { this.send = send; }
  private async cleanup(peerId: string): Promise<void> {
    const retryUntil = performance.now() + 4000;
    for (let attempt = 0; ; attempt++) {
      try { await this.send(peerId, { action: "closePeer" }, false); return; }
      catch (error) {
        if (!(error instanceof Error) || !["NOT_READY", "MEDIA_ROUTE_UNAVAILABLE"].includes(error.message) || attempt >= 63 || performance.now() >= retryUntil) throw error;
        await new Promise(resolve => setTimeout(resolve, 15 + Math.floor(Math.random() * 46)));
      }
    }
  }
  private async drainDirty(retain?: string): Promise<void> {
    for (const [id, pending] of this.peers) if (pending.dirty) {
      const revision = pending.revision;
      await this.cleanup(id); pending.dirty = false;
      if (id !== retain && !pending.cleanup && pending.revision === revision) this.peers.delete(id);
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(work).finally(() => { this.waiting--; });
    this.tail = result.catch(() => {}); return result;
  }
  handle(peerId: string, request: MediaRequest, ownsCapture: () => boolean): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("MEDIA_CLOSED"));
    if (this.waiting >= 16) return Promise.reject(new Error("MEDIA_BUSY"));
    request = structuredClone(request);
    let peer = this.peers.get(peerId);
    if (!peer) {
      if (this.peers.size >= 8) {
        if (![...this.peers.values()].some(p => p.dirty)) return Promise.reject(new Error("MEDIA_FULL"));
        // Admit bounded cleanup work, without reserving a ninth resource slot.
        return this.enqueue(() => this.drainDirty()).then(() => this.handle(peerId, request, ownsCapture));
      }
      peer = { revision: 0, dirty: false }; this.peers.set(peerId, peer);
    }
    peer.revision++;
    return this.enqueue(async () => {
      if (request.action === "produce" && !ownsCapture()) throw new Error("NOT_CAPTURE_OWNER");
      // Teardown failures are remembered; a successor cannot publish around an
      // unreachable old route/SFU. Cleanup is destructive and safe to repeat.
      await this.drainDirty(peerId);
      if (request.action === "produce" && !ownsCapture()) throw new Error("NOT_CAPTURE_OWNER");
      return this.send(peerId, request, ownsCapture());
    });
  }
  revoke(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId); if (!peer) return Promise.resolve();
    const revision = peer.revision;
    if (peer.cleanup?.revision === revision) return peer.cleanup.work;
    const work = this.enqueue(async () => {
      peer.dirty = true;
      await this.cleanup(peerId); peer.dirty = false;
      if (peer.revision === revision) this.peers.delete(peerId);
    }).finally(() => { if (peer.cleanup?.work === work) peer.cleanup = undefined; });
    peer.cleanup = { revision, work }; return work;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.peers.keys()].map(id => this.revoke(id))); await this.tail;
      const failed = results.find(r => r.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    })();
  }
}
