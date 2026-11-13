/** Peer node of a Chord-style ring overlay that discovers meetings through its peers. */

import { createHash } from "node:crypto";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  configureLogging, FrameReader, intOption, message, NetworkError, quietLogger, receive, send, usageError,
  type Body, type Logger, type Packet,
} from "./protocol.ts";
import { IDENTIFIER_RE, MeetingServer } from "./server.ts";

export const ID_BITS = 16;
export const RING_SIZE = 1 << ID_BITS;
export const SUCCESSOR_LIST_SIZE = 3;
export const MAX_HOPS = 32;
export const RPC_TIMEOUT = 1.0;
export const STABILIZE_INTERVAL = 0.5;
export const RECORD_TTL = 9.0;
export const MAX_RECORD_TTL = 3600.0;
const COMMANDS = "Commands: status | lookup NAME | host MEETING | leave | crash";

export type Address = [host: string, port: number];

export interface PeerRef {
  id: number;
  name: string;
  host: string;
  port: number;
}

export interface Route {
  owner: PeerRef;
  path: string[];
}

export interface LookupResult {
  name: string;
  key: number;
  found: boolean;
  value: any;
  owner: string;
  path: string[];
}

interface StoredRecord {
  value: unknown;
  expires: number;  // Seconds on the monotonic clock.
}

interface Published {
  value: unknown;
  owner: string | null;
}

/** A live peer answered a request with an error. */
export class RemoteError extends Error {
  override name = "RemoteError";
}

/** Seconds on a clock that wall-clock changes cannot move. */
function monotonic(): number {
  return performance.now() / 1000;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a peer or resource name to its position on the ring. */
export function ringId(text: string): number {
  const digest = createHash("sha1").update(text, "utf8").digest("hex");
  return Number(BigInt(`0x${digest}`) % BigInt(RING_SIZE));
}

/** Return whether x lies in the ring interval (a, b); a == b is every ID except a. */
export function inOpen(x: number, a: number, b: number): boolean {
  if (a === b) {
    return x !== a;
  }
  return a < b ? a < x && x < b : x > a || x < b;
}

/** Return whether x lies in the ring interval (a, b]; a == b is the whole ring. */
export function inHalfOpen(x: number, a: number, b: number): boolean {
  return x === b || inOpen(x, a, b);
}

export function parseAddress(text: string): Address {
  const split = text.lastIndexOf(":");
  const host = split === -1 ? "" : text.slice(0, split);
  const port = text.slice(split + 1);
  if (!host || !/^\d+$/.test(port) || !(Number(port) > 0 && Number(port) < 65536)) {
    throw new Error(`Expected HOST:PORT, got '${text}'`);
  }
  return [host, Number(port)];
}

/** Validate a peer reference received from the network. */
export function checkRef(ref: unknown): PeerRef {
  const candidate = ref as Partial<PeerRef> | null;
  const valid = typeof candidate === "object" && candidate !== null
    && Number.isInteger(candidate.id) && candidate.id! >= 0 && candidate.id! < RING_SIZE
    && typeof candidate.name === "string" && IDENTIFIER_RE.test(candidate.name)
    && typeof candidate.host === "string"
    && Number.isInteger(candidate.port) && candidate.port! > 0 && candidate.port! < 65536;
  if (!valid) {
    throw new Error("Invalid peer reference");
  }
  return candidate as PeerRef;
}

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) {
    throw new Error("Invalid name (1-32: letters, digits, . _ -)");
  }
  return name;
}

/** Send one packet over a short-lived TCP connection and return the reply body. */
export async function exchange(address: Address, packet: Packet & { id: string }, timeout = RPC_TIMEOUT): Promise<Body> {
  const [host, port] = address;
  const socket = createConnection({ host, port });
  const reader = new FrameReader(socket);
  // One deadline covers connecting, sending and the reply, so a peer that accepts but never answers still fails.
  const timer = setTimeout(() => socket.destroy(new Error(`Timed out after ${timeout}s talking to ${host}:${port}`)),
                           timeout * 1000);
  let answer: Packet | null;
  try {
    send(socket, packet);
    try {
      answer = await receive(reader);
    } catch (error) {
      if (error instanceof NetworkError) {
        throw error;
      }
      throw new NetworkError(`Malformed reply from ${host}:${port}`);
    }
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
  if (answer === null || answer.request_id !== packet.id) {
    throw new NetworkError(`No matching reply from ${host}:${port}`);
  }
  if (answer.type === "error") {
    throw new RemoteError(answer.body?.error ?? "Unknown error");
  }
  return answer.body ?? {};
}

/** Call a peer from outside the overlay. */
export function rpc(address: Address, kind: string, body: Body = {}, timeout = RPC_TIMEOUT, quiet = false): Promise<Body> {
  return exchange(address, message(kind, { quiet, body }), timeout);
}

/** Ask any peer where a meeting is hosted; return its [host, port]. */
export async function discover(meeting: string, via: Address): Promise<Address> {
  const answer = await rpc(via, "lookup", { name: meeting }, RPC_TIMEOUT * MAX_HOPS);
  if (!answer.found) {
    throw new Error(`No peer knows meeting '${meeting}'`);
  }
  const { host, port } = answer.value ?? {};
  if (typeof host !== "string" || typeof port !== "number") {
    throw new Error(`Record for '${meeting}' holds no address`);
  }
  return [host, port];
}

export interface PeerOptions {
  host?: string;
  port?: number;
  logger?: Logger;
  interval?: number;
  recordTtl?: number;
  verbose?: boolean;
}

interface CallOptions {
  timeout?: number;
  quiet?: boolean;
}

type Handler = (body: Body) => Body | Promise<Body>;

export class Peer {
  log: Logger;
  interval: number;
  recordTtl: number;
  verbose: boolean;
  me: PeerRef;
  address: Address;
  predecessor: PeerRef | null = null;
  successors: PeerRef[];
  records = new Map<string, StoredRecord>();     // Keys this peer owns.
  published = new Map<string, Published>();      // Resources this peer provides.
  meetings = new Map<string, MeetingServer>();   // Meetings hosted by this peer.
  readonly stopping = new AbortController();
  stopped = false;
  private stoppedSignal = Promise.withResolvers<void>();
  private server: Server;
  private serving = false;
  private handlers: Map<string, Handler>;

  constructor(name: string, options: PeerOptions = {}) {
    checkName(name);
    const { host = "127.0.0.1", port = 0 } = options;
    this.log = options.logger ?? quietLogger;
    this.interval = options.interval ?? STABILIZE_INTERVAL;
    this.recordTtl = options.recordTtl ?? RECORD_TTL;
    this.verbose = options.verbose ?? false;
    this.me = { id: ringId(name), name, host, port };
    this.address = [host, port];
    this.successors = [this.me];
    this.server = createServer((socket) => this.accept(socket));
    this.handlers = new Map<string, Handler>([
      ["ping", () => ({ status: "ok" })],
      ["neighbors", () => this.onNeighbors()],
      ["notify", (body) => this.onNotify(body)],
      ["peer_left", (body) => this.onPeerLeft(body)],
      ["find_owner", (body) => this.onFindOwner(body)],
      ["store", (body) => this.onStore(body)],
      ["get", (body) => this.onGet(body)],
      ["delete", (body) => this.onDelete(body)],
      ["lookup", (body) => this.lookup(body.name)],
      ["host", (body) => this.hostMeeting(body.meeting)],
      ["leave", () => this.onLeave()],
      ["status", () => this.onStatus()],
    ]);
  }

  /** Resolves once this peer has stopped serving. */
  get whenStopped(): Promise<void> {
    return this.stoppedSignal.promise;
  }

  // ---- lifecycle ----

  /** Join through a bootstrap peer, or create a new ring when there is none. */
  async start(bootstrap?: Address | null): Promise<void> {
    await this.listen();
    let route: Body | null = null;
    let owner: PeerRef | null = null;
    try {
      if (bootstrap) {
        // Connections are refused until routing is done: when this peer restarts on its old address, the
        // ring's stale entry for it fails the hop check instead of answering for its ID.
        route = await rpc(bootstrap, "find_owner", { key: this.me.id, path: [], ttl: MAX_HOPS }, RPC_TIMEOUT * MAX_HOPS);
        owner = checkRef(route.owner);
        if (owner.id === this.me.id) {
          throw new Error(`Ring ID ${this.me.id} is already taken by ${owner.name}`);
        }
        this.successors = [owner];
      }
    } catch (error) {
      this.server.close();
      throw error;
    }
    this.serving = true;
    this.log.info(`PEER_START name=${this.me.name} id=${this.me.id} address=${this.me.host}:${this.me.port}`);
    if (owner && route && bootstrap) {
      this.log.info(`JOIN via=${bootstrap[0]}:${bootstrap[1]} successor=${owner.name} path=${route.path.join(">")}`);
      await this.call(owner, "notify", { peer: this.me });
    } else {
      this.log.info(`RING_CREATED first peer is ${this.me.name}`);
    }
    void this.maintain();
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: this.me.host, port: this.me.port, backlog: 64 }, () => {
        this.server.off("error", reject);
        this.server.on("error", (error) => this.log.warning(`SERVER_ERROR ${error.message}`));
        this.me.port = (this.server.address() as AddressInfo).port;
        this.address = [this.me.host, this.me.port];
        resolve();
      });
    });
  }

  /** Hand off keys, unlink from both neighbors, and stop serving. */
  async leave(): Promise<void> {
    if (this.stopping.signal.aborted) {
      return;
    }
    this.stopping.abort();
    this.log.info(`LEAVE_START name=${this.me.name}`);
    const published = [...this.published.keys()];
    this.published.clear();
    for (const name of published) {
      try {
        await this.call((await this.findOwner(ringId(name))).owner, "delete", { name });
      } catch (error) {
        this.log.warning(`UNREGISTER_FAILED name=${name} error=${errorText(error)}`);
      }
    }
    this.stopMeetings();
    const predecessor = this.predecessor;
    const successors = [...this.successors];
    const records = this.records;
    this.records = new Map();
    const successor = successors[0];
    if (successor.id !== this.me.id) {
      await this.sendRecords(successor, records);
      await this.tellLeft(successor, { peer: this.me, predecessor });
      if (predecessor && predecessor.id !== this.me.id) {
        await this.tellLeft(predecessor, { peer: this.me, successors });
      }
    }
    this.log.info(`LEAVE_DONE name=${this.me.name} successor=${successor.name} predecessor=${predecessor?.name ?? null}`);
    this.halt();
  }

  /** Stop at once with no handoff or notice, as a killed process would. */
  halt(): void {
    if (this.stopped) {
      return;
    }
    this.stopping.abort();
    this.stopMeetings();
    this.server.close();
    this.stopped = true;
    this.stoppedSignal.resolve();
  }

  private async tellLeft(peer: PeerRef, body: Body): Promise<void> {
    try {
      await this.call(peer, "peer_left", body);
    } catch (error) {
      this.log.warning(`LEAVE_NOTICE_FAILED peer=${peer.name} error=${errorText(error)}`);
    }
  }

  private stopMeetings(): void {
    const meetings = [...this.meetings.values()];
    this.meetings.clear();
    for (const server of meetings) {
      server.close();
    }
  }

  // ---- messaging ----

  private note(quiet: boolean, text: string): void {
    if (this.verbose || !quiet) {
      this.log.info(text);
    }
  }

  /** Send one request to a peer; a call addressed to this peer stays in-process. */
  async call(peer: PeerRef, kind: string, body: Body = {}, options: CallOptions = {}): Promise<Body> {
    const { timeout = RPC_TIMEOUT, quiet = false } = options;
    if (peer.id === this.me.id) {
      return this.dispatch(kind, body);
    }
    const packet = message(kind, { sender: this.me.name, quiet, body });
    this.note(quiet, `SEND to=${peer.name} type=${kind} id=${packet.id} body=${JSON.stringify(body)}`);
    return exchange([peer.host, peer.port], packet, timeout);
  }

  private accept(socket: Socket): void {
    if (!this.serving) {
      socket.destroy();
      return;
    }
    void this.answer(socket);
  }

  /** Read one request from a connection and write its reply. */
  private async answer(socket: Socket): Promise<void> {
    const reader = new FrameReader(socket);
    const timer = setTimeout(() => socket.destroy(new Error("Timed out waiting for a request")), RPC_TIMEOUT * 1000);
    try {
      let packet: Packet | null;
      try {
        packet = await receive(reader);
      } catch (error) {
        if (error instanceof NetworkError) {
          throw error;
        }
        send(socket, message("error", { body: { error: errorText(error) } }));
        return;
      }
      clearTimeout(timer);
      if (packet !== null) {
        send(socket, await this.serve(packet));
      }
    } catch (error) {
      this.log.warning(`RPC_FAILED remote=${socket.remoteAddress}:${socket.remotePort} error=${errorText(error)}`);
    } finally {
      clearTimeout(timer);
      socket.destroySoon();
    }
  }

  /** Answer one request received from the network. */
  async serve(packet: Packet): Promise<Packet> {
    const kind = packet.type;
    this.note(Boolean(packet.quiet),
              `RECV from=${packet.sender ?? "client"} type=${kind} id=${packet.id} body=${JSON.stringify(packet.body)}`);
    try {
      const body = await this.dispatch(kind, packet.body === undefined ? {} : packet.body);
      return message("reply", { request_id: packet.id ?? null, sender: this.me.name, body });
    } catch (error) {
      this.log.warning(`RPC_ERROR type=${kind} error=${String(error)}`);
      return message("error", { request_id: packet.id ?? null, body: { error: errorText(error) } });
    }
  }

  async dispatch(kind: string, body: unknown): Promise<Body> {
    const handler = this.handlers.get(kind);
    if (handler === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error(`Unknown request '${kind}' or invalid body`);
    }
    return handler(body as Body);
  }

  // ---- overlay maintenance ----

  private async maintain(): Promise<void> {
    let nextRefresh = 0;
    for (;;) {
      try {
        // Each round waits for the previous one, so a slow round can never overlap the next.
        await sleep(this.interval * 1000, undefined, { signal: this.stopping.signal });
      } catch {
        return;
      }
      try {
        await this.checkPredecessor();
        await this.stabilize();
        this.expireRecords();
        if (monotonic() >= nextRefresh) {
          nextRefresh = monotonic() + this.recordTtl / 3;
          await this.refreshPublished();
        }
      } catch (error) {  // A bad reply must not end this peer's repair loop.
        this.log.warning(`MAINTENANCE_ERROR ${String(error)}`);
      }
    }
  }

  private async checkPredecessor(): Promise<void> {
    const predecessor = this.predecessor;
    if (predecessor === null) {
      return;
    }
    try {
      await this.call(predecessor, "ping", {}, { quiet: true });
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }
      if (this.predecessor === predecessor) {
        this.predecessor = null;
      }
      this.log.warning(`PREDECESSOR_FAILED peer=${predecessor.name} error=${error.message}`);
    }
  }

  /** Confirm the successor, adopt any peer now between us, and announce this peer to it. */
  private async stabilize(): Promise<void> {
    let successor = this.successors[0];
    let info: Body;
    for (;;) {
      successor = this.successors[0];
      try {
        info = await this.call(successor, "neighbors", {}, { quiet: true });
        break;
      } catch (error) {
        if (!(error instanceof NetworkError)) {
          throw error;
        }
        this.dropSuccessor(successor, error);
      }
    }
    const candidate = info.predecessor;
    if (candidate && inOpen(checkRef(candidate).id, this.me.id, successor.id)) {
      try {
        info = await this.call(candidate, "neighbors", {}, { quiet: true });
        successor = candidate;
      } catch (error) {
        if (!(error instanceof NetworkError)) {
          throw error;
        }
        // A stale predecessor pointer; the successor clears it on its own check.
      }
    }
    if (!Array.isArray(info.successors)) {
      throw new Error("Invalid successor list");
    }
    this.setSuccessors([successor, ...info.successors.map(checkRef)]);
    if (successor.id !== this.me.id) {
      await this.call(successor, "notify", { peer: this.me }, { quiet: true });
    }
  }

  private setSuccessors(peers: PeerRef[]): void {
    const fresh: PeerRef[] = [];
    const seen = new Set<number>();
    for (const peer of peers) {
      if (peer.id === this.me.id) {
        break;  // The list has wrapped around the ring.
      }
      if (!seen.has(peer.id)) {
        seen.add(peer.id);
        fresh.push(peer);
      }
    }
    const next = fresh.length ? fresh.slice(0, SUCCESSOR_LIST_SIZE) : [this.me];
    const previous = this.successors[0];
    this.successors = next;
    if (previous.id !== next[0].id) {
      this.log.info(`SUCCESSOR_CHANGED ${previous.name} -> ${next[0].name}`);
    }
  }

  private dropSuccessor(peer: PeerRef, reason: Error): void {
    this.log.warning(`SUCCESSOR_FAILED peer=${peer.name} error=${reason.message}`);
    const remaining = this.successors.filter((item) => item.id !== peer.id);
    if (this.predecessor && this.predecessor.id === peer.id) {
      this.predecessor = null;
    }
    this.setSuccessors(remaining);
  }

  // ---- soft-state records ----

  private expireRecords(): void {
    const now = monotonic();
    const expired = [...this.records].filter(([, record]) => record.expires <= now).map(([name]) => name);
    for (const name of expired) {
      this.records.delete(name);
      this.log.info(`RECORD_EXPIRED name=${name}`);
    }
  }

  private async refreshPublished(): Promise<void> {
    for (const name of [...this.published.keys()]) {
      try {
        await this.register(name, true);
      } catch (error) {
        this.log.warning(`REGISTER_FAILED name=${name} error=${errorText(error)}`);
      }
    }
  }

  private async register(name: string, quiet = false): Promise<void> {
    const key = ringId(name);
    const route = await this.findOwner(key, quiet);
    const owner = route.owner;
    const entry = this.published.get(name);
    if (entry === undefined) {
      return;
    }
    await this.call(owner, "store", { records: [{ name, value: entry.value, ttl: this.recordTtl }] }, { quiet });
    if (entry.owner !== owner.name) {
      this.log.info(`REGISTER name=${name} key=${key} owner=${owner.name} previous_owner=${entry.owner ?? "None"} `
                    + `path=${route.path.join(">")}`);
      entry.owner = owner.name;
    }
  }

  /** Move records to the peer now responsible; the provider's refresh covers a failure. */
  private async sendRecords(peer: PeerRef, records: Map<string, StoredRecord>): Promise<void> {
    if (!records.size) {
      return;
    }
    const now = monotonic();
    // shortcut: one frame per transfer caps a move at about 400 records, chunk if that grows.
    const wire = [...records].map(([name, record]) => ({
      name, value: record.value, ttl: Math.max(record.expires - now, 0.001),
    }));
    try {
      await this.call(peer, "store", { records: wire });
      this.log.info(`KEYS_TRANSFER to=${peer.name} names=${JSON.stringify([...records.keys()].sort())}`);
    } catch (error) {
      this.log.warning(`KEYS_TRANSFER_FAILED to=${peer.name} error=${errorText(error)}`);
    }
  }

  // ---- routing and discovery ----

  /** Route through the ring to the peer responsible for a key. */
  async findOwner(key: number, quiet = false): Promise<Route> {
    const route = await this.onFindOwner({ key, path: [], ttl: MAX_HOPS, quiet });
    return { owner: checkRef(route.owner), path: route.path };
  }

  /** Resolve a resource name through the overlay. */
  async lookup(name: unknown): Promise<LookupResult> {
    checkName(name);
    const key = ringId(name as string);
    const route = await this.findOwner(key);
    const owner = route.owner;
    const record = (await this.call(owner, "get", { name })).record;
    const found = record !== null && record !== undefined;
    this.log.info(`LOOKUP name=${name} key=${key} owner=${owner.name} hops=${route.path.length - 1} `
                  + `path=${route.path.join(">")} found=${found}`);
    return { name: name as string, key, found, value: found ? record.value : null, owner: owner.name, path: route.path };
  }

  /** Make a resource discoverable and keep it alive for as long as this peer runs. */
  async publish(name: string, value: unknown): Promise<void> {
    checkName(name);
    this.published.set(name, { value, owner: null });
    await this.register(name);
  }

  /** Start a meeting coordinator on this peer and advertise it through the overlay. */
  async hostMeeting(meeting: unknown): Promise<Body> {
    checkName(meeting);
    const name = meeting as string;
    const found = await this.lookup(name);
    if (found.found) {
      throw new Error(`Meeting '${name}' is already hosted by ${found.value?.peer}`);
    }
    const server = new MeetingServer(this.log);
    const address = await server.listen(this.me.host, 0);
    this.meetings.set(name, server);
    const value = { host: this.me.host, port: address.port, peer: this.me.name };
    this.log.info(`HOST_MEETING meeting=${name} address=${value.host}:${value.port}`);
    await this.publish(name, value);
    return value;
  }

  // ---- request handlers ----

  private onNeighbors(): Body {
    return { predecessor: this.predecessor, successors: [...this.successors] };
  }

  private async onNotify(body: Body): Promise<Body> {
    const peer = checkRef(body.peer);
    const previous = this.predecessor;
    if (peer.id === this.me.id || !(previous === null || inOpen(peer.id, previous.id, this.me.id))) {
      return { status: "ignored" };
    }
    this.predecessor = peer;
    const moving = new Map([...this.records].filter(([name]) => !inHalfOpen(ringId(name), peer.id, this.me.id)));
    for (const name of moving.keys()) {
      this.records.delete(name);
    }
    this.log.info(`PREDECESSOR_CHANGED ${previous?.name ?? null} -> ${peer.name}`);
    await this.sendRecords(peer, moving);
    return { status: "accepted" };
  }

  private onPeerLeft(body: Body): Body {
    const peer = checkRef(body.peer);
    this.log.info(`PEER_LEFT name=${peer.name}`);
    if ("predecessor" in body) {
      const replacement = body.predecessor ? checkRef(body.predecessor) : null;
      if (this.predecessor && this.predecessor.id === peer.id) {
        this.predecessor = replacement && replacement.id !== this.me.id ? replacement : null;
        this.log.info(`PREDECESSOR_CHANGED ${peer.name} -> ${this.predecessor?.name ?? null}`);
      }
    }
    if ("successors" in body) {
      if (!Array.isArray(body.successors)) {
        throw new Error("Invalid successor list");
      }
      if (this.successors[0].id === peer.id) {
        this.setSuccessors(body.successors.map(checkRef).filter((ref: PeerRef) => ref.id !== peer.id));
      }
    }
    return { status: "ok" };
  }

  private async onFindOwner(body: Body): Promise<Body> {
    const { key, ttl } = body;
    if (!Number.isInteger(key) || key < 0 || key >= RING_SIZE || !Number.isInteger(ttl)) {
      throw new Error("Invalid key or hop limit");
    }
    if (!Array.isArray(body.path)) {
      throw new Error("Invalid path");
    }
    const quiet = Boolean(body.quiet);
    const path: string[] = [...body.path, this.me.name];
    if (path.length > MAX_HOPS + 1) {
      throw new Error("Path is longer than the hop limit");
    }
    const predecessor = this.predecessor;
    if (body.final || (predecessor && inHalfOpen(key, predecessor.id, this.me.id))) {
      return { owner: this.me, path };
    }
    for (;;) {
      const successor = this.successors[0];
      if (successor.id === this.me.id) {
        return { owner: this.me, path };
      }
      if (ttl <= 0) {
        throw new Error(`Hop limit reached routing key ${key}`);
      }
      const final = inHalfOpen(key, this.me.id, successor.id);
      this.note(quiet, `FORWARD key=${key} next=${successor.name} final=${final} path=${path.join(">")}`);
      try {
        // The forwarded call waits for the whole remaining route, so a dead or frozen
        // hop has to be caught here, under the short timeout.
        await this.call(successor, "ping", {}, { quiet: true });
        const forwarded: Body = { key, path, ttl: ttl - 1, final };
        if (quiet) {
          forwarded.quiet = true;
        }
        return await this.call(successor, "find_owner", forwarded, { timeout: RPC_TIMEOUT * Math.max(ttl, 1), quiet });
      } catch (error) {
        if (!(error instanceof NetworkError)) {
          throw error;
        }
        this.dropSuccessor(successor, error);
      }
    }
  }

  private onStore(body: Body): Body {
    const records = body.records;
    if (!Array.isArray(records)) {
      throw new Error("Invalid records");
    }
    for (const record of records) {
      const name = checkName(record?.name);
      const ttl = record.ttl;
      if (typeof ttl !== "number" || !(ttl > 0 && ttl <= MAX_RECORD_TTL)) {
        throw new Error("Invalid record TTL");
      }
      const known = this.records.has(name);
      this.records.set(name, { value: record.value, expires: monotonic() + ttl });
      if (!known) {
        this.log.info(`STORE name=${name} key=${ringId(name)} ttl=${ttl.toFixed(1)}`);
      }
    }
    return { status: "stored", count: records.length };
  }

  private onGet(body: Body): Body {
    const name = checkName(body.name);
    const record = this.records.get(name);
    const now = monotonic();
    if (record === undefined || record.expires <= now) {
      return { record: null };
    }
    return { record: { name, value: record.value, ttl: record.expires - now } };
  }

  private onDelete(body: Body): Body {
    const name = checkName(body.name);
    const removed = this.records.delete(name);
    if (removed) {
      this.log.info(`UNREGISTER name=${name}`);
    }
    return { status: removed ? "deleted" : "absent" };
  }

  private onLeave(): Body {
    // The reply goes out first; leave() ends with this peer's listener closed.
    setImmediate(() => void this.leave());
    return { status: "leaving" };
  }

  onStatus(): Body {
    const now = monotonic();
    return {
      me: this.me,
      predecessor: this.predecessor,
      successors: [...this.successors],
      records: Object.fromEntries([...this.records].map(([name, record]) => [name, {
        key: ringId(name), value: record.value, ttl: Math.round((record.expires - now) * 10) / 10,
      }])),
      published: [...this.published.keys()].sort(),
    };
  }
}

/** Execute one interactive command; return false once the terminal should stop reading. */
export async function runCommand(peer: Peer, line: string): Promise<boolean> {
  const text = line.trim();
  const space = text.indexOf(" ");
  const command = space === -1 ? text : text.slice(0, space);
  const argument = space === -1 ? "" : text.slice(space + 1);
  if (command === "status") {
    const status = peer.onStatus();
    console.log(`me=${status.me.name} id=${status.me.id} predecessor=${status.predecessor?.name ?? null}`
                + ` successors=${JSON.stringify(status.successors.map((item: PeerRef) => item.name))}`);
    console.log(`records=${JSON.stringify(status.records)} published=${JSON.stringify(status.published)}`);
  } else if (command === "lookup" && argument) {
    console.log(await peer.lookup(argument));
  } else if (command === "host" && argument) {
    console.log(await peer.hostMeeting(argument));
  } else if (command === "leave") {
    await peer.leave();
    return false;
  } else if (command === "crash") {
    process.exit(1);
  } else if (command) {
    console.log(COMMANDS);
  }
  return true;
}

async function readCommands(peer: Peer): Promise<void> {
  console.log(COMMANDS);
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      if (!(await runCommand(peer, line))) {
        return;
      }
    } catch (error) {
      console.log("Error:", errorText(error));
    }
  }
  // No terminal attached: the peer keeps serving until told to leave.
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },  // Ring position comes from a hash of this name.
      host: { type: "string", default: "127.0.0.1" },  // IP to bind and advertise to other peers.
      port: { type: "string" },
      bootstrap: { type: "string" },  // HOST:PORT of any peer in the ring.
      "record-ttl": { type: "string", default: String(RECORD_TTL) },
      "log-dir": { type: "string", default: "logs" },
      verbose: { type: "boolean", default: false },  // Also log periodic maintenance traffic.
    },
  });
  const name = values.name ?? usageError("the following argument is required: --name");
  const port = intOption("port", values.port);
  const recordTtl = Number(values["record-ttl"]);
  if (!(recordTtl > 0)) {
    usageError(`argument --record-ttl: invalid positive number: '${values["record-ttl"]}'`);
  }
  let bootstrap: Address | null = null;
  try {
    bootstrap = values.bootstrap ? parseAddress(values.bootstrap) : null;
  } catch (error) {
    usageError(`argument --bootstrap: ${errorText(error)}`);
  }
  const log = configureLogging(name, values["log-dir"]);
  const peer = new Peer(name, { host: values.host, port, logger: log, recordTtl, verbose: values.verbose });
  try {
    await peer.start(bootstrap);
  } catch (error) {
    console.error(`Could not start ${name}: ${errorText(error)}`);
    process.exit(1);
  }
  process.on("SIGINT", () => void peer.leave());
  void readCommands(peer);
  await peer.whenStopped;
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
