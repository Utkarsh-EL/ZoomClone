/**
 * Peer node of a Chord-style ring overlay that discovers meetings through its peers, and coordinates access to
 * shared meeting minutes: Lamport clocks on every message, ring leader election, and a lock run by the leader.
 */

import { createHash } from "node:crypto";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import {
  configureLogging, FrameReader, intOption, LamportClock, parseCli, message, NetworkError, quietLogger, receive, send,
  usageError, type Body, type Logger, type Packet,
} from "./protocol.ts";
import { writeMinute } from "./minutes.ts";
import { IDENTIFIER_RE, MeetingServer } from "./server.ts";

export const ID_BITS = 16;
export const RING_SIZE = 1 << ID_BITS;
export const SUCCESSOR_LIST_SIZE = 3;
export const MAX_HOPS = 32;
export const RPC_TIMEOUT = 1.0;
export const STABILIZE_INTERVAL = 0.5;
export const RECORD_TTL = 9.0;
export const MAX_RECORD_TTL = 3600.0;
export const ELECTION_TIMEOUT = 3.0;  // Seconds before an election or a lock recovery that never returned is retried.
export const LOCK_RETRY = 2.0;        // Seconds between re-sends of a lock request that is still waiting.
const MAX_APPEND = 100;
const COMMANDS = "Commands: status | lookup NAME | host MEETING | elect | append COUNT [unsafe] | leave | crash";

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

export const MINUTES = "minutes";  // The lock that protects the shared minutes; other resources have their own locks.

export interface LockRequest {
  peer: PeerRef;
  requested_at: number;  // Lamport time of the request event.
  resource: string;
}

export type LockState = "idle" | "waiting" | "held";

interface Holder {
  peer: PeerRef;
  resource: string;
}

/** The leader's view of one named lock. */
interface Grant {
  holder: PeerRef | null;
  queue: LockRequest[];
  seq: number;             // Counts grants, so a stale holder check cannot free a newer grant.
  pending: number | null;  // Ring ID of the peer whose grant is in flight.
}

/** This peer's own use of one named lock. */
interface Claim {
  state: LockState;
  request: LockRequest | null;
  granted: PromiseWithResolvers<void> | null;
  sent: number;            // Monotonic seconds when the request was last sent.
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

function checkTerm(term: unknown): number {
  if (!Number.isSafeInteger(term) || (term as number) < 0) {
    throw new Error("Invalid term");
  }
  return term as number;
}

function checkRequest(value: unknown): LockRequest {
  const candidate = value as Partial<LockRequest> | null;
  if (typeof candidate !== "object" || candidate === null || !Number.isSafeInteger(candidate.requested_at)
      || candidate.requested_at! < 0) {
    throw new Error("Invalid lock request");
  }
  return { peer: checkRef(candidate.peer), requested_at: candidate.requested_at!, resource: checkName(candidate.resource) };
}

function checkHolder(value: unknown): Holder {
  const candidate = value as Partial<Holder> | null;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Invalid lock holder");
  }
  return { peer: checkRef(candidate.peer), resource: checkName(candidate.resource) };
}

/** Order lock requests by Lamport time, then ring ID, so every peer agrees on one total order. */
export function requestOrder(a: LockRequest, b: LockRequest): number {
  return a.requested_at - b.requested_at || a.peer.id - b.peer.id;
}

function describeQueue(queue: LockRequest[]): string {
  return `[${queue.map((request) => `${request.peer.name}@${request.requested_at}`).join(",")}]`;
}

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) {
    throw new Error("Invalid name (1-32: letters, digits, . _ -)");
  }
  return name;
}

/** Send one packet over a short-lived TCP connection and return the reply packet, which may be an error. */
export async function request(address: Address, packet: Packet & { id: string }, timeout = RPC_TIMEOUT): Promise<Packet> {
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
  return answer;
}

function replyBody(answer: Packet): Body {
  if (answer.type === "error") {
    throw new RemoteError(answer.body?.error ?? "Unknown error");
  }
  return answer.body ?? {};
}

/** Send one packet over a short-lived TCP connection and return the reply body. */
export async function exchange(address: Address, packet: Packet & { id: string }, timeout = RPC_TIMEOUT): Promise<Body> {
  return replyBody(await request(address, packet, timeout));
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
  minutes?: string;  // Path of the shared minutes file.
}

interface CallOptions {
  timeout?: number;
  quiet?: boolean;
}

export type Handler = (body: Body) => Body | Promise<Body>;

export class Peer {
  log: Logger;
  interval: number;
  recordTtl: number;
  verbose: boolean;
  me: PeerRef;
  address: Address;
  clock = new LamportClock();
  predecessor: PeerRef | null = null;
  successors: PeerRef[];
  records = new Map<string, StoredRecord>();     // Keys this peer owns.
  published = new Map<string, Published>();      // Resources this peer provides.
  meetings = new Map<string, MeetingServer>();   // Meetings hosted by this peer.
  minutes: string;
  leader: PeerRef | null = null;
  term = 0;                                      // Election round that chose the leader; a higher term wins.
  private electionStarted = 0;                   // Monotonic seconds; 0 while no election is pending here.
  // Lock coordinator state, used while this peer is the leader. One recovery covers every resource.
  private lockReady = false;                     // False until the coordinator message has gone around the ring.
  private recoveryStarted = 0;
  private grants = new Map<string, Grant>();
  private earlyReleases = new Set<string>();     // "resource id" of releases that arrived before recovery finished.
  // This peer's own lock use, per resource.
  private claims = new Map<string, Claim>();
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
    this.minutes = options.minutes ?? join("logs", "minutes.jsonl");
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
      ["elect", async () => { await this.startElection(true); return { status: "started" }; }],
      ["election", (body) => this.onElection(body)],
      ["elected", (body) => this.onElected(body)],
      ["coordinator", (body) => this.onCoordinator(body)],
      ["lock_request", (body) => this.onLockRequest(body)],
      ["lock_grant", (body) => this.onLockGrant(body)],
      ["lock_release", (body) => this.onLockRelease(body)],
      ["lock_held", (body) => ({ held: this.lockState(checkName(body.resource)) === "held" })],
      ["append", (body) => this.onAppend(body)],
    ]);
  }

  /** Add a request type, as the video layer does for its own requests. */
  on(kind: string, handler: Handler): void {
    this.handlers.set(kind, handler);
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
    for (const claim of this.claims.values()) {
      claim.granted?.reject(new Error("Peer stopped"));
    }
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

  /** Log a coordination event as one tick of the Lamport clock. */
  private event(name: string, details = "", warning = false): void {
    const line = `${name} lamport=${this.clock.tick()} ${details}`.trimEnd();
    if (warning) {
      this.log.warning(line);
    } else {
      this.log.info(line);
    }
  }

  /** Run a task without waiting for it; a failure is logged, since an unhandled rejection would end the process. */
  private background(task: Promise<unknown>, what: string): void {
    task.catch((error) => this.log.warning(`${what}_FAILED error=${errorText(error)}`));
  }

  /** Send one request to a peer; a call addressed to this peer stays in-process. */
  async call(peer: PeerRef, kind: string, body: Body = {}, options: CallOptions = {}): Promise<Body> {
    const { timeout = RPC_TIMEOUT, quiet = false } = options;
    if (peer.id === this.me.id) {
      return this.dispatch(kind, body);
    }
    const packet = message(kind, { sender: this.me.name, quiet, lamport: this.clock.tick(), body });
    this.note(quiet, `SEND to=${peer.name} type=${kind} id=${packet.id} lamport=${packet.lamport} `
                     + `body=${JSON.stringify(body)}`);
    const answer = await request([peer.host, peer.port], packet, timeout);
    this.clock.receive(answer.lamport);
    return replyBody(answer);
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
    try {
      const lamport = this.clock.receive(packet.lamport);
      this.note(Boolean(packet.quiet), `RECV from=${packet.sender ?? "client"} type=${kind} id=${packet.id} `
                                       + `lamport=${lamport} body=${JSON.stringify(packet.body)}`);
      const body = await this.dispatch(kind, packet.body === undefined ? {} : packet.body);
      return message("reply", { request_id: packet.id ?? null, sender: this.me.name, lamport: this.clock.tick(), body });
    } catch (error) {
      this.log.warning(`RPC_ERROR type=${kind} error=${String(error)}`);
      return message("error", { request_id: packet.id ?? null, lamport: this.clock.tick(),
                                body: { error: errorText(error) } });
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
        await this.checkLeader();
        await this.checkLock();
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
    this.learnLeader(info.leader, info.term);
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

  // ---- leader election (ring algorithm) ----

  /** Watch the leader and elect a new one when there is none; a new leader retries a recovery that never returned. */
  private async checkLeader(): Promise<void> {
    const leader = this.leader;
    if (leader === null) {
      await this.startElection();
    } else if (leader.id === this.me.id) {
      if (!this.lockReady && monotonic() - this.recoveryStarted >= ELECTION_TIMEOUT) {
        await this.startRecovery();
      }
    } else {
      try {
        await this.call(leader, "ping", {}, { quiet: true });
      } catch (error) {
        if (!(error instanceof NetworkError)) {
          throw error;
        }
        if (this.leader?.id === leader.id) {
          this.leader = null;
          this.event("LEADER_FAILED", `leader=${leader.name} term=${this.term} error=${error.message}`, true);
          await this.startElection();
        }
      }
    }
  }

  /** Send an election message clockwise; every live peer adds itself before passing it on. */
  async startElection(force = false): Promise<void> {
    if (!force && this.electionStarted && monotonic() - this.electionStarted < ELECTION_TIMEOUT) {
      return;
    }
    this.electionStarted = monotonic();
    this.event("ELECTION_START", `term=${this.term}`);
    await this.forwardRing("election", { initiator: this.me, candidates: [this.me], term: this.term });
  }

  /** Pass a message to the next live peer clockwise, dropping successors that do not answer. */
  private async forwardRing(kind: string, body: Body): Promise<void> {
    for (;;) {
      const successor = this.successors[0];
      try {
        await this.call(successor, kind, body);
        return;
      } catch (error) {
        if (!(error instanceof NetworkError) || successor.id === this.me.id) {
          throw error;
        }
        this.dropSuccessor(successor, error);
      }
    }
  }

  /** Adopt the leader of a newer term that a neighbor knows; this is how a joining peer finds the leader. */
  private learnLeader(leader: unknown, term: unknown): void {
    if (leader && Number.isSafeInteger(term) && (term as number) > this.term) {
      this.acceptLeader(checkRef(leader), term as number, "LEADER_LEARNED");
    }
  }

  private acceptLeader(leader: PeerRef, term: number, how: string, details = ""): void {
    const changed = this.leader?.id !== leader.id || this.term !== term;
    if (this.leader?.id === this.me.id && leader.id !== this.me.id) {
      this.event("LEADER_STEPPED_DOWN", `term=${this.term} new_leader=${leader.name}`);
      this.lockReady = false;
      this.grants.clear();
      this.earlyReleases.clear();
    }
    this.leader = leader;
    this.term = term;
    this.electionStarted = 0;
    if (changed) {
      this.event(how, `leader=${leader.name} term=${term}${details}`);
    }
  }

  private onElection(body: Body): Body {
    const initiator = checkRef(body.initiator);
    const term = checkTerm(body.term);
    if (!Array.isArray(body.candidates) || body.candidates.length > MAX_HOPS) {
      throw new Error("Invalid candidate list");
    }
    const candidates: PeerRef[] = body.candidates.map(checkRef);
    if (initiator.id === this.me.id) {
      // Back at the start: the list holds every live peer, and the highest ring ID wins.
      const winner = candidates.reduce((best, peer) => (peer.id > best.id ? peer : best));
      const members = candidates.map((peer) => peer.name);
      if (!this.electionStarted) {
        // A leader was accepted while this message went around, as when several peers start at once.
        this.event("ELECTION_SUPERSEDED", `winner=${winner.name} leader=${this.leader?.name ?? null}`);
        return { status: "done" };
      }
      this.event("ELECTION_RESULT", `winner=${winner.name} candidates=${members.join(",")}`);
      this.background(this.call(winner, "elected", { term, members }), "ELECTED_NOTICE");
      return { status: "done" };
    }
    if (candidates.some((peer) => peer.id === this.me.id)) {
      // The ring changed under the message; its initiator starts over after ELECTION_TIMEOUT.
      this.event("ELECTION_DROPPED", `initiator=${initiator.name}`);
      return { status: "dropped" };
    }
    if (this.leader === null && !this.electionStarted) {
      this.electionStarted = monotonic();  // One election in flight is enough; hold off starting another.
    }
    const forward = { initiator, candidates: [...candidates, this.me], term: Math.max(term, this.term) };
    this.background(this.forwardRing("election", forward), "ELECTION_FORWARD");
    return { status: "ok" };
  }

  private onElected(body: Body): Body {
    const term = checkTerm(body.term);
    if (term < this.term) {
      // Started before the current term, as when several peers noticed the same failure; they hear of this term.
      return { status: "stale" };
    }
    const members = Array.isArray(body.members) ? body.members.filter((name) => typeof name === "string") : [];
    this.acceptLeader(this.me, term + 1, "LEADER_ELECTED", ` members=${members.join(",")}`);
    this.background(this.startRecovery(), "COORDINATOR");
    return { status: "leader", term: this.term };
  }

  /**
  /**
   * Send the coordinator message around the ring. It announces this leader and term, and collects every peer's
   * lock state; no grant goes out until it returns, so a lock held under the old leader is never given twice.
   */
  private async startRecovery(): Promise<void> {
    this.lockReady = false;
    this.grants.clear();
    this.earlyReleases.clear();
    this.recoveryStarted = monotonic();
    await this.forwardRing("coordinator", this.reportLock({
      leader: this.me, term: this.term, visited: [this.me.name], waiting: [], holders: [],
    }));
  }

  /** Add this peer's own lock state, for every resource, to a coordinator message. */
  private reportLock(body: Body): Body {
    for (const [resource, claim] of this.claims) {
      if (claim.state === "held") {
        body.holders = [...body.holders, { peer: this.me, resource }];
      } else if (claim.state === "waiting" && claim.request) {
        body.waiting = [...body.waiting, claim.request];
      }
    }
    return body;
  }

  private onCoordinator(body: Body): Body {
    const leader = checkRef(body.leader);
    const term = checkTerm(body.term);
    if (!Array.isArray(body.visited) || body.visited.length > MAX_HOPS + 1 || !Array.isArray(body.waiting)
        || !Array.isArray(body.holders)) {
      throw new Error("Invalid coordinator message");
    }
    const visited: string[] = body.visited.map(checkName);
    const waiting = body.waiting.map(checkRequest);
    const holders = body.holders.map(checkHolder);
    if (leader.id === this.me.id) {
      if (term === this.term && this.leader?.id === this.me.id && !this.lockReady) {
        this.finishRecovery(holders, waiting, visited);
      }
      return { status: "ok" };
    }
    if (term < this.term || (term === this.term && this.leader !== null && leader.id < this.leader.id)) {
      this.event("COORDINATOR_REJECTED", `leader=${leader.name} term=${term} current=${this.leader?.name ?? null}`);
      return { status: "stale" };
    }
    if (visited.includes(this.me.name)) {
      return { status: "dropped" };  // A loop in a changing ring; the leader resends after ELECTION_TIMEOUT.
    }
    this.acceptLeader(leader, term, "LEADER_ACCEPTED");
    const forward = this.reportLock({ leader, term, visited: [...visited, this.me.name], waiting, holders });
    this.background(this.forwardRing("coordinator", forward), "COORDINATOR_FORWARD");
    return { status: "ok" };
  }

  private finishRecovery(holders: Holder[], waiting: LockRequest[], visited: string[]): void {
    // Requests that reached this leader while the message was going around join the collected ones.
    const arrived = [...this.grants.values()].flatMap((grant) => grant.queue);
    this.grants.clear();
    for (const { peer, resource } of holders) {
      if (this.earlyReleases.has(`${resource} ${peer.id}`)) {
        continue;
      }
      const grant = this.grantFor(resource);
      if (grant.holder) {
        this.log.error(`MUTEX_VIOLATION resource=${resource} holders=${grant.holder.name},${peer.name}`);
      } else {
        grant.holder = peer;
      }
    }
    for (const request of [...waiting, ...arrived]) {
      const grant = this.grantFor(request.resource);
      if (request.peer.id !== grant.holder?.id && !grant.queue.some((queued) => queued.peer.id === request.peer.id)) {
        grant.queue.push(request);
      }
    }
    this.lockReady = true;
    this.earlyReleases.clear();
    const prefix = `term=${this.term} members=${visited.join(",")}`;
    if (!this.grants.size) {
      this.event("LOCK_STATE_RECOVERED", `${prefix} holder=null queue=[]`);
    }
    for (const [resource, grant] of this.grants) {
      grant.queue.sort(requestOrder);
      this.event("LOCK_STATE_RECOVERED", `${prefix} holder=${grant.holder?.name ?? null} `
                                         + `queue=${describeQueue(grant.queue)} resource=${resource}`);
      this.background(this.grantNext(resource), "LOCK_GRANT");
    }
  }

  // ---- mutual exclusion (centralized locks run by the leader, one per named resource) ----

  private grantFor(resource: string): Grant {
    let grant = this.grants.get(resource);
    if (grant === undefined) {
      grant = { holder: null, queue: [], seq: 0, pending: null };
      this.grants.set(resource, grant);
    }
    return grant;
  }

  /** This peer's state for one lock. */
  lockState(resource = MINUTES): LockState {
    return this.claims.get(resource)?.state ?? "idle";
  }

  /** Ask the leader for a lock and wait for its grant. */
  async acquire(resource = MINUTES): Promise<void> {
    checkName(resource);
    if (this.lockState(resource) !== "idle") {
      throw new Error(`This peer already wants the ${resource} lock`);
    }
    if (this.stopping.signal.aborted) {
      throw new Error("Peer stopped");
    }
    const granted = Promise.withResolvers<void>();
    granted.promise.catch(() => {});  // halt() may reject it before the await below is reached.
    const claim: Claim = {
      state: "waiting", request: { peer: this.me, requested_at: this.clock.tick(), resource }, granted, sent: 0,
    };
    this.claims.set(resource, claim);
    this.log.info(`LOCK_REQUEST lamport=${claim.request!.requested_at} leader=${this.leader?.name ?? null} `
                  + `resource=${resource}`);
    await this.sendLockRequest(claim);
    await granted.promise;
  }

  private async sendLockRequest(claim: Claim, quiet = false): Promise<void> {
    claim.sent = monotonic();
    const leader = this.leader;
    const request = claim.request;
    if (leader === null || request === null) {
      return;  // The next leader's coordinator message collects the request.
    }
    try {
      await this.call(leader, "lock_request", { ...request }, { quiet });
    } catch (error) {
      // A replacement leader collects the request when it takes over; the periodic resend covers the rest.
      this.event("LOCK_REQUEST_FAILED", `leader=${leader.name} error=${errorText(error)} resource=${request.resource}`, true);
    }
  }

  /** Leave the critical section and tell the leader. */
  async release(resource = MINUTES): Promise<void> {
    const claim = this.claims.get(resource);
    if (claim?.state !== "held") {
      return;
    }
    this.claims.delete(resource);
    const leader = this.leader;
    this.event("LOCK_RELEASE", `leader=${leader?.name ?? null} resource=${resource}`);
    if (leader === null) {
      return;
    }
    try {
      await this.call(leader, "lock_release", { peer: this.me, resource });
    } catch (error) {
      // This peer holds nothing either way; the leader's holder check or a new leader's recovery sees that.
      this.event("LOCK_RELEASE_FAILED", `leader=${leader.name} error=${errorText(error)} resource=${resource}`, true);
    }
  }

  /**
   * Withdraw a request that has not been granted, or release the lock if it has. A grant that arrives later finds no
   * request, is refused, and the leader moves on to the next one.
   */
  async cancel(resource = MINUTES): Promise<void> {
    const claim = this.claims.get(resource);
    if (claim?.state === "held") {
      await this.release(resource);
      return;
    }
    if (claim?.state !== "waiting") {
      return;
    }
    this.claims.delete(resource);
    this.event("LOCK_CANCEL", `leader=${this.leader?.name ?? null} resource=${resource}`);
    claim.granted?.reject(new Error(`The request for the ${resource} lock was withdrawn`));
  }

  /** Resend waiting requests; as leader, take locks back from holders that died or whose release was lost. */
  private async checkLock(): Promise<void> {
    for (const claim of [...this.claims.values()]) {
      if (claim.state === "waiting" && monotonic() - claim.sent >= LOCK_RETRY) {
        await this.sendLockRequest(claim, true);
      }
    }
    if (this.leader?.id !== this.me.id || !this.lockReady) {
      return;
    }
    for (const [resource, grant] of [...this.grants]) {
      await this.checkHolder(resource, grant);
    }
  }

  private async checkHolder(resource: string, grant: Grant): Promise<void> {
    const holder = grant.holder;
    if (holder === null || holder.id === this.me.id || grant.pending !== null) {
      return;
    }
    const seq = grant.seq;
    let reason = "released";
    try {
      if ((await this.call(holder, "lock_held", { resource }, { quiet: true })).held) {
        return;
      }
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }
      reason = error.message;
    }
    // Only act on the grant that was asked about; a newer grant may have gone out while waiting for the answer.
    if (this.grants.get(resource) === grant && grant.holder?.id === holder.id && grant.seq === seq
        && grant.pending === null) {
      grant.holder = null;
      this.event("LOCK_HOLDER_LOST", `peer=${holder.name} reason=${reason} resource=${resource}`, true);
      await this.grantNext(resource);
    }
  }

  private onLockRequest(body: Body): Body {
    const request = checkRequest(body);
    if (this.leader?.id !== this.me.id) {
      throw new Error(`Not the leader; the leader is ${this.leader?.name ?? "unknown"}`);
    }
    const grant = this.grantFor(request.resource);
    if (grant.holder?.id === request.peer.id) {
      if (this.lockReady && grant.pending === null) {
        this.background(this.sendGrant(request.resource, request.peer), "LOCK_GRANT");  // The first grant was lost.
      }
      return { status: "holder" };
    }
    if (!grant.queue.some((queued) => queued.peer.id === request.peer.id)) {
      grant.queue.push(request);
      grant.queue.sort(requestOrder);
      this.event("LOCK_QUEUED", `peer=${request.peer.name} requested_at=${request.requested_at} `
                                + `queue=${describeQueue(grant.queue)} resource=${request.resource}`);
    }
    this.background(this.grantNext(request.resource), "LOCK_GRANT");
    return { status: "queued" };
  }

  private onLockRelease(body: Body): Body {
    const peer = checkRef(body.peer);
    const resource = checkName(body.resource);
    if (this.leader?.id !== this.me.id) {
      return { status: "ignored" };
    }
    if (!this.lockReady) {
      this.earlyReleases.add(`${resource} ${peer.id}`);
      return { status: "noted" };
    }
    const grant = this.grants.get(resource);
    if (grant?.holder?.id !== peer.id) {
      return { status: "ignored" };
    }
    grant.holder = null;
    this.event("LOCK_RELEASED", `peer=${peer.name} queue=${describeQueue(grant.queue)} resource=${resource}`);
    this.background(this.grantNext(resource), "LOCK_GRANT");
    return { status: "released" };
  }

  /** Give a free lock to its queued request with the smallest Lamport time. */
  private async grantNext(resource: string): Promise<void> {
    const grant = this.grants.get(resource);
    if (this.leader?.id !== this.me.id || !this.lockReady || grant === undefined || grant.holder !== null) {
      return;
    }
    const next = grant.queue.shift();
    if (next === undefined) {
      return;
    }
    grant.holder = next.peer;
    grant.seq += 1;
    this.event("LOCK_GRANT", `to=${next.peer.name} requested_at=${next.requested_at} queue=${describeQueue(grant.queue)} `
                             + `resource=${resource}`);
    await this.sendGrant(resource, next.peer);
  }

  private async sendGrant(resource: string, peer: PeerRef): Promise<void> {
    const grant = this.grantFor(resource);
    const term = this.term;
    grant.pending = peer.id;
    try {
      await this.call(peer, "lock_grant", { leader: this.me, term, resource });
    } catch (error) {
      if (error instanceof NetworkError) {
        // The grant may still have arrived, so the lock stays reserved until the holder check asks the peer.
        this.event("LOCK_GRANT_FAILED", `peer=${peer.name} error=${error.message} resource=${resource}`, true);
      } else if (grant.holder?.id === peer.id && this.term === term) {
        // The peer refused: it is not waiting under this term, so it is not using the resource.
        grant.holder = null;
        this.event("LOCK_GRANT_REFUSED", `peer=${peer.name} error=${errorText(error)} resource=${resource}`, true);
        grant.pending = null;
        await this.grantNext(resource);
      }
    } finally {
      if (grant.pending === peer.id) {
        grant.pending = null;
      }
    }
  }

  private onLockGrant(body: Body): Body {
    const leader = checkRef(body.leader);
    const resource = checkName(body.resource);
    if (leader.id !== this.leader?.id || body.term !== this.term) {
      throw new Error(`Grant from ${leader.name} in term ${body.term}, but the leader is `
                      + `${this.leader?.name ?? "unknown"} in term ${this.term}`);
    }
    const claim = this.claims.get(resource);
    if (claim?.state === "held") {
      return { status: "held" };  // A resent grant.
    }
    if (claim?.state !== "waiting") {
      throw new Error(`Not waiting for the ${resource} lock`);
    }
    claim.state = "held";
    this.event("LOCK_ACQUIRED", `from=${leader.name} requested_at=${claim.request?.requested_at} resource=${resource}`);
    claim.granted?.resolve();
    return { status: "held" };
  }

  /** Write entries into the shared minutes, each inside the critical section unless `locked` is false. */
  async appendMinutes(count: number, locked = true): Promise<number[]> {
    const written: number[] = [];
    for (let i = 1; i <= count; i++) {
      if (locked) {
        await this.acquire();
      }
      try {
        const lamport = this.clock.tick();
        this.log.info(`CS_ENTER lamport=${lamport} locked=${locked}`);
        const entry = await writeMinute(this.minutes, this.me.name, lamport, `minute ${i} of ${count} from ${this.me.name}`);
        this.event("CS_EXIT", `entry=${entry.n}`);
        written.push(entry.n);
      } finally {
        if (locked) {
          await this.release();
        }
      }
    }
    return written;
  }

  private async onAppend(body: Body): Promise<Body> {
    const { count, locked = true } = body;
    if (!Number.isInteger(count) || count < 1 || count > MAX_APPEND || typeof locked !== "boolean") {
      throw new Error(`Invalid append request (count 1-${MAX_APPEND}, locked true or false)`);
    }
    return { written: await this.appendMinutes(count, locked) };
  }

  // ---- request handlers ----

  private onNeighbors(): Body {
    return { predecessor: this.predecessor, successors: [...this.successors], leader: this.leader, term: this.term };
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
      leader: this.leader,
      term: this.term,
      lamport: this.clock.time,
      lock: {
        ready: this.lockReady,
        mine: Object.fromEntries([...this.claims].map(([resource, claim]) => [resource, claim.state])),
        grants: Object.fromEntries([...this.grants].map(([resource, grant]) => [resource, {
          holder: grant.holder?.name ?? null, queue: grant.queue.map((request) => request.peer.name),
        }])),
      },
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
    console.log(`leader=${status.leader?.name ?? null} term=${status.term} lamport=${status.lamport} `
                + `lock=${JSON.stringify(status.lock)}`);
  } else if (command === "lookup" && argument) {
    console.log(await peer.lookup(argument));
  } else if (command === "host" && argument) {
    console.log(await peer.hostMeeting(argument));
  } else if (command === "elect") {
    await peer.startElection(true);
  } else if (command === "append" && /^\d+( unsafe)?$/.test(argument)) {
    const [count, mode] = argument.split(" ");
    console.log("written", await peer.appendMinutes(Number(count), mode !== "unsafe"));
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
  const values = parseCli({
    options: {
      name: { type: "string" },  // Ring position comes from a hash of this name.
      host: { type: "string", default: "127.0.0.1" },  // IP to bind and advertise to other peers.
      port: { type: "string" },
      bootstrap: { type: "string" },  // HOST:PORT of any peer in the ring.
      "record-ttl": { type: "string", default: String(RECORD_TTL) },
      "log-dir": { type: "string", default: "logs" },
      minutes: { type: "string" },  // Shared minutes file; peers that should coordinate name the same file.
      http: { type: "string" },     // Port for the meeting page on 127.0.0.1: watch and share video.
      verbose: { type: "boolean", default: false },  // Also log periodic maintenance traffic.
    },
  });
  const name = values.name ?? usageError("the following argument is required: --name");
  const port = intOption("port", values.port);
  const recordTtl = Number(values["record-ttl"]);
  if (!(recordTtl > 0)) {
    usageError(`argument --record-ttl: invalid positive number: '${values["record-ttl"]}'`);
  }
  const http = values.http === undefined ? null : intOption("http", values.http);
  let bootstrap: Address | null = null;
  try {
    bootstrap = values.bootstrap ? parseAddress(values.bootstrap) : null;
  } catch (error) {
    usageError(`argument --bootstrap: ${errorText(error)}`);
  }
  const log = configureLogging(name, values["log-dir"]);
  const minutes = values.minutes ?? join(values["log-dir"], "minutes.jsonl");
  const peer = new Peer(name, { host: values.host, port, logger: log, recordTtl, verbose: values.verbose, minutes });
  try {
    await peer.start(bootstrap);
  } catch (error) {
    console.error(`Could not start ${name}: ${errorText(error)}`);
    process.exit(1);
  }
  // Loaded here rather than at the top: video.ts reaches back to peer.ts through client.ts.
  const { attachVideo, startWebUi } = await import("./video.ts");
  const video = attachVideo(peer);
  if (http !== null) {
    try {
      await startWebUi(video, http);
    } catch (error) {
      console.error(`Could not serve the meeting page on port ${http}: ${errorText(error)}`);
    }
  }
  process.on("SIGINT", () => void peer.leave());
  void readCommands(peer);
  await peer.whenStopped;
  process.exit(0);
}

if (import.meta.main) {
  // Not awaited: main() imports video.ts, which reaches back to this module through client.ts, and that import
  // cannot finish while this module's evaluation is still waiting on main().
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
