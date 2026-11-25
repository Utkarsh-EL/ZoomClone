import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ControlWire, ProtocolError, UUID_PATTERN, boundedReply, type Identity } from "./wire.ts";
import type { Candidate } from "./recovery-controller.ts";
import type { RuntimeAgent } from "./runtime-agent.ts";
import type { Owner } from "../storage/meeting-store.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
function loopback(address: string): URL {
  const url = new URL(`http://${address}/v1/runtime`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!((isIP(host) === 4 && host.startsWith("127.")) || host === "::1") || !url.port
    || url.username || url.password || url.pathname !== "/v1/runtime" || url.search || url.hash) throw new ProtocolError("Only literal loopback runtime addresses are enabled");
  return url;
}
function tokenRequired(token: string): void {
  if (Buffer.byteLength(token) < 32 || /[\r\n]/.test(token)) throw new ProtocolError("Runtime token must contain at least 32 bytes");
}
function timeout(value = 4000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw new ProtocolError("Invalid runtime timeout");
  return value;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fields(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function validOwner(value: unknown): value is Owner {
  return object(value) && fields(value, ["clusterId", "runtimeId", "incarnation", "meetingId", "attemptId", "generation"])
    && [value.clusterId, value.runtimeId, value.incarnation, value.meetingId, value.attemptId].every(id => typeof id === "string" && UUID_PATTERN.test(id))
    && Number.isSafeInteger(value.generation) && (value.generation as number) > 0;
}

export interface RemoteRuntimeOptions {
  clusterId: string;
  runtimeId: string;
  incarnation: string;
  address: string;
  token: string;
  identity: Identity;
  timeoutMs?: number;
}

/** A provisioned control-plane route, never a participant-facing gateway. */
export class RemoteRuntime implements Candidate {
  readonly runtimeId: string;
  readonly incarnation: string;
  private readonly options: Readonly<RemoteRuntimeOptions>;
  private readonly wire: ControlWire;
  private readonly url: string;
  constructor(options: RemoteRuntimeOptions, wire?: ControlWire) {
    this.url = loopback(options.address).href;
    tokenRequired(options.token);
    if (![options.clusterId, options.runtimeId, options.incarnation].every(id => UUID_PATTERN.test(id))
      || options.clusterId !== options.identity.clusterId) throw new ProtocolError("Runtime UUID identity mismatch");
    if (wire && (wire.identity.clusterId !== options.identity.clusterId || wire.identity.nodeId !== options.identity.nodeId
      || wire.identity.incarnation !== options.identity.incarnation)) throw new ProtocolError("Shared runtime wire identity mismatch");
    this.wire = wire ?? new ControlWire(options.identity);
    this.options = Object.freeze({ ...options, timeoutMs: timeout(options.timeoutMs) });
    this.runtimeId = options.runtimeId; this.incarnation = options.incarnation;
  }
  get logicalTime(): number { return this.wire.logicalTime; }
  private async call(operation: "status" | "prepare", owner?: Owner): Promise<unknown> {
    const packet = this.wire.request({ operation, runtimeId: this.runtimeId, incarnation: this.incarnation, ...(owner ? { owner } : {}) });
    let response: Response;
    try {
      response = await fetch(this.url, { method: "POST", redirect: "error", headers: {
        Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json",
      }, body: JSON.stringify(packet) + "\n", signal: AbortSignal.timeout(this.options.timeoutMs!) });
    } catch (error) { throw new Error("Runtime unavailable; preparation outcome may be unknown", { cause: error }); }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`HTTP_${response.status}`); }
    const reply = this.wire.receive(await boundedReply(response), packet.requestId, this.runtimeId);
    if (reply.incarnation !== this.incarnation) throw new ProtocolError("Runtime INCARNATION_MISMATCH");
    if (reply.error) throw new Error(reply.error.code);
    return reply.body;
  }
  async available(): Promise<boolean> {
    try { const result = await this.call("status"); return object(result) && result.registered === true; }
    catch { return false; }
  }
  async prepare(input: Owner): Promise<void> {
    const owner = { ...input };
    if (!validOwner(owner) || owner.clusterId !== this.options.clusterId || owner.runtimeId !== this.runtimeId || owner.incarnation !== this.incarnation) throw new ProtocolError("RUNTIME_MISMATCH");
    const result = await this.call("prepare", owner);
    if (!object(result) || result.prepared !== true) throw new ProtocolError("Invalid preparation reply");
  }
}

/** Bounded probing of provisioned routes; reachability never changes voters. */
export async function availableRuntimes(routes: readonly RemoteRuntime[]): Promise<RemoteRuntime[]> {
  if (routes.length > 128) throw new Error("Too many provisioned runtime routes");
  const available: RemoteRuntime[] = [];
  for (let start = 0; start < routes.length; start += 8) {
    const batch = routes.slice(start, start + 8);
    const results = await Promise.allSettled(batch.map(route => route.available()));
    results.forEach((result, index) => { if (result.status === "fulfilled" && result.value) available.push(batch[index]); });
  }
  return available;
}

function readRequest(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const clean = () => { request.removeListener("data", data); request.removeListener("end", end); request.removeListener("error", fail); request.removeListener("aborted", aborted); };
    const fail = (error: Error) => { clean(); reject(error); };
    const aborted = () => fail(new ProtocolError("Aborted runtime frame"));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) { fail(new Error("TOO_LARGE")); request.resume(); }
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try {
        const value = Buffer.concat(chunks);
        if (value.at(-1) !== 10 || value.indexOf(10) !== value.length - 1) throw new ProtocolError("Invalid runtime frame");
        resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
      } catch (error) { reject(error); }
    };
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", aborted);
  });
}

type RuntimeEndpoint = Pick<RuntimeAgent, "prepare" | "registered"> & { identity: Pick<RuntimeAgent["identity"], "clusterId" | "runtimeId" | "incarnation"> };

export async function serveRuntime(agent: RuntimeEndpoint, options: {
  address: string; token: string; callers: readonly string[]; timeoutMs?: number; maxConcurrent?: number; wire?: ControlWire;
}): Promise<{ address: string; close(): Promise<void> }> {
  const url = loopback(options.address);
  tokenRequired(options.token);
  const deadline = timeout(options.timeoutMs), maxConcurrent = options.maxConcurrent ?? 8;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128
    || !options.callers.length || options.callers.length > 64 || !options.callers.every(id => UUID_PATTERN.test(id))) throw new ProtocolError("Invalid runtime admission bounds");
  const callers = new Set(options.callers), expectedToken = Buffer.from(`Bearer ${options.token}`);
  const wire = options.wire ?? new ControlWire({ clusterId: agent.identity.clusterId, nodeId: agent.identity.runtimeId, incarnation: agent.identity.incarnation });
  if (wire.identity.clusterId !== agent.identity.clusterId || wire.identity.nodeId !== agent.identity.runtimeId || wire.identity.incarnation !== agent.identity.incarnation) throw new ProtocolError("Runtime wire identity mismatch");
  let active = 0;
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    response.setHeader("Connection", "close");
    if (request.method !== "POST" || request.url !== "/v1/runtime") { response.writeHead(404).end(); request.resume(); return; }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) { response.writeHead(401).end(); request.resume(); return; }
    if (active >= maxConcurrent) { response.writeHead(503).end(); request.resume(); return; }
    active++;
    const timer = setTimeout(() => request.destroy(), deadline);
    const work = (async () => {
      try {
        const packet = wire.accept(await readRequest(request));
        if (!callers.has(packet.nodeId)) { response.writeHead(403).end(); return; }
        const body = packet.body;
        if (!object(body) || !fields(body, ["operation", "runtimeId", "incarnation", "owner"])
          || !["status", "prepare"].includes(body.operation as string)
          || (body.operation === "prepare" && !validOwner(body.owner))
          || (body.operation === "status" && body.owner !== undefined)) { response.writeHead(400).end(); return; }
        let result: unknown, error: { code: string; message: string } | undefined;
        try {
          if (body.runtimeId !== agent.identity.runtimeId || body.incarnation !== agent.identity.incarnation) throw new Error("RUNTIME_MISMATCH");
          if (body.operation === "status") result = { registered: agent.registered };
          else {
            const owner = body.owner as unknown as Owner;
            if (owner.clusterId !== agent.identity.clusterId || owner.runtimeId !== agent.identity.runtimeId || owner.incarnation !== agent.identity.incarnation) throw new Error("RUNTIME_MISMATCH");
            await agent.prepare(owner); result = { prepared: true };
          }
        } catch (cause) {
          const code = cause instanceof Error && /^[A-Z][A-Z_]{0,63}$/.test(cause.message) ? cause.message : "RUNTIME_FAILED";
          error = { code, message: code }; result = null;
        }
        if (!response.destroyed) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(wire.reply(packet, result, error)) + "\n");
      } catch (error) {
        if (!response.destroyed) response.writeHead(error instanceof Error && error.message === "TOO_LARGE" ? 413 : 400).end();
      } finally { clearTimeout(timer); active--; }
    })();
    pending.add(work); void work.finally(() => pending.delete(work));
  });
  // Header/request timeout properties are enforced by Node's periodic sweep.
  // Bound every accepted socket immediately, including incomplete headers.
  server.on("connection", socket => {
    const timer = setTimeout(() => socket.destroy(), deadline);
    socket.once("close", () => clearTimeout(timer));
  });
  server.maxConnections = 64;
  server.headersTimeout = deadline; server.requestTimeout = deadline; server.keepAliveTimeout = 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""), () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime listener unavailable");
  let closing: Promise<void> | undefined;
  return { address: `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    close() {
      closing ??= (async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await Promise.allSettled([...pending]);
      })();
      return closing;
    } };
}
