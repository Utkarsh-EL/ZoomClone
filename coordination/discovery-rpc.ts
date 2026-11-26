import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { addressUrl, type Namespace } from "./discovery-id.ts";
import { DiscoveryNode, object, type DiscoveryTransport } from "./discovery.ts";
import { ControlWire, boundedReply, type Identity } from "./wire.ts";

const MAX_FRAME = 65536;
function tokenRequired(token: string): void {
  if (typeof token !== "string" || Buffer.byteLength(token) < 32 || /[\r\n]/.test(token)) throw new Error("INVALID_DISCOVERY_TOKEN");
}
function publicIdentity(identity: Identity): Identity {
  return { clusterId: identity.clusterId, nodeId: identity.nodeId, incarnation: identity.incarnation };
}
export function discoveryTransport(identity: Identity, token: string, wire = new ControlWire(publicIdentity(identity))): DiscoveryTransport {
  tokenRequired(token);
  if (wire.identity.clusterId !== identity.clusterId || wire.identity.nodeId !== identity.nodeId || wire.identity.incarnation !== identity.incarnation) throw new Error("DISCOVERY_WIRE_IDENTITY_MISMATCH");
  return async (address, body, signal, expected) => {
    const packet = wire.request(body), data = JSON.stringify(packet) + "\n";
    if (Buffer.byteLength(data) > MAX_FRAME) throw new Error("DISCOVERY_FRAME_TOO_LARGE");
    const response = await fetch(addressUrl(address), { method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: data });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`DISCOVERY_HTTP_${response.status}`); }
    const value = await boundedReply(response);
    if (!object(value) || typeof value.nodeId !== "string") throw new Error("INVALID_DISCOVERY_REPLY");
    const reply = wire.receive(value, packet.requestId, expected?.nodeId ?? value.nodeId);
    if (expected && reply.incarnation !== expected.incarnation) throw new Error("DISCOVERY_INCARNATION_MISMATCH");
    if (reply.error) throw new Error(reply.error.code);
    return reply.body;
  };
}

function readFrame(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const clean = () => { request.removeListener("data", data); request.removeListener("end", end); request.removeListener("error", fail); request.removeListener("aborted", aborted); };
    const fail = (error: Error) => { clean(); reject(error); };
    const aborted = () => fail(new Error("ABORTED"));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME) { fail(new Error("TOO_LARGE")); request.resume(); }
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try {
        const buffer = Buffer.concat(chunks);
        if (buffer.at(-1) !== 10 || buffer.indexOf(10) !== buffer.length - 1) throw new Error("INVALID_FRAME");
        resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)));
      } catch (error) { reject(error); }
    };
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", aborted);
  });
}

export interface DiscoveryConfig extends Identity {
  address: string;
  token: string;
  initialize?: boolean;
  bootstraps?: readonly string[];
  intervalMs?: number;
  timeoutMs?: number;
  announcements?: { namespace: Exclude<Namespace, "peer">; name: string; generation: number; value: unknown }[];
}

/** Explicit overlay initialization does not bootstrap Raft or change voters. */
export async function serveDiscovery(config: DiscoveryConfig): Promise<{
  address: string; node: DiscoveryNode; readonly logicalTime: number; close(): Promise<void>;
}> {
  const url = addressUrl(config.address, true);
  tokenRequired(config.token);
  const wire = new ControlWire(publicIdentity(config)), transport = discoveryTransport(config, config.token, wire);
  const intervalMs = config.intervalMs ?? 500, timeoutMs = config.timeoutMs ?? 1500;
  if ((config.initialize !== undefined && typeof config.initialize !== "boolean")
    || !Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 60_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || (config.initialize === true) === Boolean(config.bootstraps?.length)) throw new Error("EXPLICIT_DISCOVERY_BOOTSTRAP_REQUIRED");
  const announcements = structuredClone(config.announcements ?? []);
  if (!Array.isArray(announcements) || announcements.length > 16 || (announcements.length && intervalMs > 10000)) throw new Error("INVALID_DISCOVERY_ANNOUNCEMENTS");
  let node: DiscoveryNode | undefined, active = 0, stopping = false;
  const pending = new Set<Promise<void>>();
  const expected = Buffer.from(`Bearer ${config.token}`);
  const server = createServer((request, response) => {
    response.setHeader("Connection", "close");
    if (request.method !== "POST" || request.url !== "/v1/discovery") { response.writeHead(404).end(); request.resume(); return; }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); request.resume(); return; }
    if (stopping || !node || active >= 16) { response.writeHead(503).end(); request.resume(); return; }
    active++;
    const work = (async () => {
      try {
        const packet = wire.accept(await readFrame(request));
        const body = packet.body;
        const result = object(body) && body.operation === "lookup"
          ? await node!.lookup(body.namespace as Exclude<Namespace, "peer">, body.name as string) : node!.handle(body);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(wire.reply(packet, result)) + "\n");
      } catch (error) {
        if (!response.destroyed) response.writeHead(error instanceof Error && error.message === "TOO_LARGE" ? 413 : 400).end();
      } finally { active--; }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
  });
  server.on("connection", socket => {
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once("close", () => clearTimeout(timer));
  });
  server.maxConnections = 64;
  let interval: ReturnType<typeof setInterval> | undefined;
  let maintenance: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    stopping = true;
    clearInterval(interval);
    server.closeAllConnections();
    await Promise.all([maintenance, ...pending, new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ""), () => { server.removeListener("error", reject); resolve(); });
    });
    const bound = server.address() as AddressInfo, address = `${bound.family === "IPv6" ? `[${bound.address}]` : bound.address}:${bound.port}`;
    node = new DiscoveryNode({ ...config, address, transport });
    if (config.initialize) node.initialize(); else await node.join(config.bootstraps!);
    const announce = async () => {
      for (const hint of announcements) await node!.publish(hint.namespace, hint.name,
        { generation: hint.generation, value: hint.value, expiresAt: Date.now() + 30000 });
    };
    await announce();
    let busy = false;
    interval = setInterval(() => {
      if (busy) return;
      busy = true;
      maintenance = node!.maintain().then(announce).catch(() => {}).finally(() => { busy = false; });
    }, intervalMs);
    return { address, node, get logicalTime() { return wire.logicalTime; }, close };
  } catch (error) {
    if (server.listening) await close();
    throw error;
  }
}
