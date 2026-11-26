import { UUID_PATTERN } from "./wire.ts";
import { isDeepStrictEqual } from "node:util";
import { addressUrl, between, discoveryId, distance, fromHex, ID_BITS, RING_SIZE, toHex, type Namespace } from "./discovery-id.ts";

export interface DiscoveryPeer { id: bigint; nodeId: string; incarnation: string; address: string }
export interface DiscoveryHint { generation: number; expiresAt: number; value: unknown }
export type DiscoveryTransport = (address: string, body: unknown, signal: AbortSignal, expected?: DiscoveryPeer) => Promise<unknown>;
export const SUCCESSORS = 4;
const MAX_HINTS = 1024, MAX_TTL = 60_000;
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function wire(peer: DiscoveryPeer): unknown { return { ...peer, id: toHex(peer.id) }; }
function unique(peers: DiscoveryPeer[]): DiscoveryPeer[] {
  return peers.filter((peer, index) => peers.findIndex(p => p.nodeId === peer.nodeId) === index);
}
class Budget {
  readonly signal: AbortSignal;
  private readonly attemptMs: number;
  remaining = 64;
  constructor(timeoutMs: number, attemptMs = Math.floor(timeoutMs / 4)) {
    this.signal = AbortSignal.timeout(timeoutMs);
    this.attemptMs = Math.max(1, Math.min(250, attemptMs));
  }
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (--this.remaining < 0 || this.signal.aborted) throw new Error("DISCOVERY_UNAVAILABLE");
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.attemptMs)]);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("DISCOVERY_UNAVAILABLE"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => work(signal)).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}

/** Volatile discovery only. No coordinator or SQL mutation interface exists here. */
export class DiscoveryNode {
  readonly self: Readonly<DiscoveryPeer>;
  readonly clusterId: string;
  private readonly transport: DiscoveryTransport;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private joined = false;
  private singleton = true;
  private readonly contacts = new Set<string>();
  private previous: DiscoveryPeer | null = null;
  private next: DiscoveryPeer[] = [];
  private table: (DiscoveryPeer | null)[] = Array.from({ length: ID_BITS }, () => null);
  private fingerIndex = 0;
  private maintaining = false;
  private readonly hints = new Map<string, DiscoveryHint>();

  constructor(options: { clusterId: string; nodeId: string; incarnation: string; address: string;
    transport: DiscoveryTransport; now?: () => number; timeoutMs?: number }) {
    if (![options.nodeId, options.incarnation].every(id => UUID_PATTERN.test(id))) throw new Error("INVALID_DISCOVERY_PEER");
    addressUrl(options.address);
    this.clusterId = options.clusterId;
    this.self = Object.freeze({ id: discoveryId(options.clusterId, "peer", options.nodeId), nodeId: options.nodeId,
      incarnation: options.incarnation, address: options.address });
    this.transport = options.transport; this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 1500;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error("INVALID_DISCOVERY_TIMEOUT");
  }
  get predecessor(): Readonly<DiscoveryPeer> | null { return this.previous && { ...this.previous }; }
  get successors(): readonly DiscoveryPeer[] { return this.next.map(p => ({ ...p })); }
  get fingers(): readonly (DiscoveryPeer | null)[] { return this.table.map(p => p && { ...p }); }
  private peer(value: unknown): DiscoveryPeer {
    if (!object(value) || typeof value.nodeId !== "string" || !UUID_PATTERN.test(value.nodeId)
      || typeof value.incarnation !== "string" || !UUID_PATTERN.test(value.incarnation) || typeof value.address !== "string") throw new Error("INVALID_DISCOVERY_PEER");
    const id = fromHex(value.id);
    if (id !== discoveryId(this.clusterId, "peer", value.nodeId)) throw new Error("INVALID_DISCOVERY_PEER");
    addressUrl(value.address);
    return { id, nodeId: value.nodeId, incarnation: value.incarnation, address: value.address };
  }
  private peers(value: unknown, limit = SUCCESSORS): DiscoveryPeer[] {
    if (!Array.isArray(value) || value.length > limit) throw new Error("INVALID_DISCOVERY_PEERS");
    return value.map(v => this.peer(v));
  }
  private setSuccessors(peers: DiscoveryPeer[]): void {
    this.next = unique(peers).filter(p => p.nodeId !== this.self.nodeId)
      .sort((a, b) => distance(this.self.id, a.id) < distance(this.self.id, b.id) ? -1 : 1).slice(0, SUCCESSORS);
  }
  private forget(peer: DiscoveryPeer): void {
    this.next = this.next.filter(p => p.nodeId !== peer.nodeId);
    this.table = this.table.map(p => p?.nodeId === peer.nodeId ? null : p);
    if (this.previous?.nodeId === peer.nodeId) this.previous = null;
  }
  private remember(address: string): void {
    if (address === this.self.address) return;
    this.contacts.delete(address); this.contacts.add(address);
    if (this.contacts.size > 32) this.contacts.delete(this.contacts.values().next().value!);
  }
  initialize(): void {
    if (this.joined) throw new Error("ALREADY_JOINED");
    this.joined = true;
  }
  private async call(peer: DiscoveryPeer, body: unknown, budget: Budget): Promise<unknown> {
    if (peer.nodeId === this.self.nodeId) return this.handle(body);
    const result = await budget.run(signal => this.transport(peer.address, body, signal, peer));
    this.remember(peer.address);
    return result;
  }
  async join(addresses: readonly string[]): Promise<void> {
    if (this.joined) throw new Error("ALREADY_JOINED");
    if (!addresses.length || addresses.length > 16) throw new Error("INVALID_BOOTSTRAPS");
    addresses.forEach(a => addressUrl(a));
    addresses.forEach(a => this.remember(a));
    const budget = new Budget(this.timeoutMs, Math.floor(this.timeoutMs / (addresses.length + 1)));
    for (const address of new Set(addresses)) {
      try {
        const status = await budget.run(signal => this.transport(address, { operation: "status" }, signal));
        if (!object(status)) throw new Error("INVALID_DISCOVERY_REPLY");
        const bootstrap = this.peer(status.self);
        const result = await this.find(this.self.id, [bootstrap], budget);
        if (result.peer.nodeId === this.self.nodeId) throw new Error("DUPLICATE_DISCOVERY_IDENTITY");
        this.setSuccessors([result.peer, ...this.peers(status.successors), bootstrap]);
        await this.call(result.peer, { operation: "notify", peer: wire(this.self) }, budget);
        this.joined = true;
        this.singleton = false;
        return;
      } catch { /* Try other provisioned bootstrap routes within the same budget. */ }
    }
    this.next = []; throw new Error("DISCOVERY_UNAVAILABLE");
  }
  private async find(key: bigint, seeds: DiscoveryPeer[], budget: Budget): Promise<{ peer: DiscoveryPeer; path: string[] }> {
    toHex(key);
    const queue = [...seeds], seen = new Set<string>(), failed = new Set<string>(), path: string[] = [];
    while (queue.length && path.length < 32) {
      const peer = queue.shift()!;
      if (seen.has(peer.nodeId) || failed.has(peer.nodeId)) continue;
      seen.add(peer.nodeId);
      try {
        const reply = await this.call(peer, { operation: "route", key: toHex(key), failed: [...failed] }, budget);
        if (!object(reply)) throw new Error("INVALID_DISCOVERY_REPLY");
        const candidates = this.peers(reply.candidates, ID_BITS + SUCCESSORS);
        path.push(peer.nodeId);
        if (reply.owner !== null) {
          const owner = this.peer(reply.owner);
          try {
            const status = await this.call(owner, { operation: "status" }, budget);
            if (!object(status) || this.peer(status.self).incarnation !== owner.incarnation) throw new Error("STALE_DISCOVERY_PEER");
            return { peer: owner, path };
          } catch {
            this.forget(owner); failed.add(owner.nodeId);
            // Re-evaluate that peer's successor interval with the failed
            // owner excluded, even before background stabilization catches up.
            seen.delete(peer.nodeId); candidates.unshift(peer);
          }
        }
        queue.unshift(...candidates.filter(p => !seen.has(p.nodeId)));
        // Every reply is bounded; keep the iterative work queue bounded as well.
        queue.splice(ID_BITS + SUCCESSORS);
      } catch { this.forget(peer); failed.add(peer.nodeId); }
      if (budget.signal.aborted || budget.remaining <= 0) break;
    }
    throw new Error("DISCOVERY_UNAVAILABLE");
  }
  async locate(key: bigint): Promise<{ peer: DiscoveryPeer; path: string[] }> {
    if (!this.joined) throw new Error("NOT_JOINED");
    return this.find(key, [this.self], new Budget(this.timeoutMs));
  }
  async maintain(fingerCount = 8): Promise<void> {
    if (!this.joined) throw new Error("NOT_JOINED");
    if (!Number.isInteger(fingerCount) || fingerCount < 0 || fingerCount > ID_BITS) throw new Error("INVALID_FINGER_COUNT");
    if (this.maintaining) return;
    this.maintaining = true;
    const budget = new Budget(this.timeoutMs);
    try {
      if (this.previous) {
        try { await this.call(this.previous, { operation: "status" }, budget); } catch { this.forget(this.previous!); }
      }
      for (const candidate of unique([...this.next, ...this.table.filter(p => p !== null)])) {
        try {
          const reply = await this.call(candidate, { operation: "status" }, budget);
          if (!object(reply)) throw new Error("INVALID_DISCOVERY_REPLY");
          const predecessor = reply.predecessor === null ? null : this.peer(reply.predecessor);
          this.setSuccessors([candidate, ...this.next, ...this.peers(reply.successors),
            ...(predecessor && between(predecessor.id, this.self.id, candidate.id) ? [predecessor] : [])]);
          await this.call(this.next[0], { operation: "notify", peer: wire(this.self) }, budget);
          break;
        } catch { this.forget(candidate); }
        if (budget.signal.aborted || budget.remaining <= 0) break;
      }
      {
        const hadSuccessors = this.next.length > 0;
        // Keep bounded contacts across suspicion. A temporary partition or a
        // new process at an old address must not permanently strand this peer.
        for (const address of [...this.contacts]) {
          this.remember(address);
          try {
            const reply = await budget.run(signal => this.transport(address, { operation: "status" }, signal));
            if (!object(reply)) throw new Error("INVALID_DISCOVERY_REPLY");
            const contact = this.peer(reply.self);
            // Status is enough to seed a reachable neighbor. Both sides may
            // have empty routing state after a partition, so locate must not
            // be a prerequisite for rebuilding their topology.
            this.setSuccessors([...this.next, contact, ...this.peers(reply.successors)]);
            if (this.next.length) {
              this.singleton = false;
              await this.call(contact, { operation: "notify", peer: wire(this.self) }, budget);
              break;
            }
          } catch { /* Rotate contacts so a dead prefix cannot starve healing. */ }
          if (budget.signal.aborted || budget.remaining <= 0) break;
          // Even a healthy subring probes one retained contact per tick, so
          // two partitions can merge when their network heals.
          if (hadSuccessors) break;
        }
      }
      for (let i = 0; i < fingerCount && !budget.signal.aborted; i++) {
        // Each finger has a fresh bounded RPC count, sharing the maintenance deadline.
        budget.remaining = 64;
        const index = this.fingerIndex++ % ID_BITS;
        try { this.table[index] = (await this.find((this.self.id + (1n << BigInt(index))) % RING_SIZE, [this.self], budget)).peer; }
        catch { this.table[index] = null; }
      }
      this.prune();
    } finally { this.maintaining = false; }
  }
  private prune(): void { for (const [key, hint] of this.hints) if (hint.expiresAt <= this.now()) this.hints.delete(key); }
  private hint(value: unknown): DiscoveryHint {
    if (!object(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
      || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= this.now()
      || (value.expiresAt as number) > this.now() + MAX_TTL || !("value" in value)
      || Buffer.byteLength(JSON.stringify(value)) > 8192) throw new Error("INVALID_DISCOVERY_HINT");
    return structuredClone(value) as unknown as DiscoveryHint;
  }
  private recordKey(namespace: unknown, name: unknown): bigint {
    if ((namespace !== "meeting" && namespace !== "service") || typeof name !== "string") throw new Error("INVALID_DISCOVERY_KEY");
    return discoveryId(this.clusterId, namespace, name);
  }
  async publish(namespace: Exclude<Namespace, "peer">, name: string, input: DiscoveryHint): Promise<void> {
    const hint = this.hint(input), key = this.recordKey(namespace, name), budget = new Budget(this.timeoutMs);
    if (!this.joined) throw new Error("NOT_JOINED");
    const owner = (await this.find(key, [this.self], budget)).peer;
    await this.call(owner, { operation: "put", namespace, name, hint }, budget);
    const status = await this.call(owner, { operation: "status" }, budget);
    if (!object(status)) throw new Error("INVALID_DISCOVERY_REPLY");
    for (const peer of this.peers(status.successors)) {
      try { await this.call(peer, { operation: "put", namespace, name, hint }, budget); } catch { /* Volatile hints are republished by their producer. */ }
    }
  }
  async lookup(namespace: Exclude<Namespace, "peer">, name: string): Promise<DiscoveryHint | null> {
    if (!this.joined) throw new Error("NOT_JOINED");
    const key = this.recordKey(namespace, name), budget = new Budget(this.timeoutMs);
    const owner = (await this.find(key, [this.self], budget)).peer;
    const result = await this.call(owner, { operation: "get", namespace, name }, budget);
    return result === null ? null : this.hint(result);
  }
  handle(body: unknown): unknown {
    if (!this.joined) throw new Error("NOT_JOINED");
    if (!object(body)) throw new Error("INVALID_DISCOVERY_REQUEST");
    switch (body.operation) {
      case "status": return { self: wire(this.self), predecessor: this.previous && wire(this.previous), successors: this.next.map(wire) };
      case "notify": {
        const peer = this.peer(body.peer);
        if (peer.nodeId === this.self.nodeId) {
          if (peer.incarnation !== this.self.incarnation) throw new Error("DUPLICATE_DISCOVERY_IDENTITY");
          return null;
        }
        this.singleton = false; this.remember(peer.address);
        if (!this.previous || this.previous.nodeId === peer.nodeId || between(peer.id, this.previous.id, this.self.id)) this.previous = peer;
        if (!this.next.length || this.next.some(p => p.nodeId === peer.nodeId)) this.setSuccessors([peer, ...this.next.filter(p => p.nodeId !== peer.nodeId)]);
        return null;
      }
      case "route": {
        const excluded = body.failed ?? [];
        if (!Array.isArray(excluded) || excluded.length > 64 || !excluded.every(id => typeof id === "string" && UUID_PATTERN.test(id))) throw new Error("INVALID_DISCOVERY_ROUTE");
        const failed = new Set(excluded);
        const successors = this.next.filter(peer => !failed.has(peer.nodeId));
        const key = fromHex(body.key), successor = successors[0];
        const singleton = this.singleton && !successor && !this.previous;
        const owner = key === this.self.id || singleton ? this.self
          : successor && (key === successor.id || between(key, this.self.id, successor.id)) ? successor : null;
        const preceding = unique(this.table.filter((p): p is DiscoveryPeer => p !== null && !failed.has(p.nodeId) && between(p.id, this.self.id, key)))
          .sort((a, b) => distance(this.self.id, a.id) > distance(this.self.id, b.id) ? -1 : 1);
        return { owner: owner && wire(owner), candidates: unique([...preceding, ...successors]).map(wire) };
      }
      case "put": {
        const key = toHex(this.recordKey(body.namespace, body.name)), hint = this.hint(body.hint);
        this.prune(); const old = this.hints.get(key);
        if (old && old.generation > hint.generation) return null;
        if (old && old.generation === hint.generation && !isDeepStrictEqual(old.value, hint.value)) throw new Error("DISCOVERY_HINT_CONFLICT");
        if (old && old.generation === hint.generation) hint.expiresAt = Math.max(old.expiresAt, hint.expiresAt);
        if (!old && this.hints.size >= MAX_HINTS) throw new Error("DISCOVERY_HINT_CAPACITY");
        this.hints.set(key, hint); return null;
      }
      case "get": this.prune(); return structuredClone(this.hints.get(toHex(this.recordKey(body.namespace, body.name))) ?? null);
      default: throw new Error("INVALID_DISCOVERY_OPERATION");
    }
  }
}
