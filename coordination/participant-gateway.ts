import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { MeetingStore } from "../storage/meeting-store.ts";
import { validateOperation, type Operation } from "../storage/engine.ts";
import { StoreError, type Authority, type MeetingCommand, type ParticipantCredential } from "../storage/types.ts";
import type { RuntimeAgent } from "./runtime-agent.ts";
import { ControlWire, MAX_ENVELOPE_BYTES, UUID_PATTERN } from "./wire.ts";
import { fields, record, validParticipantOwner, sameOwner, participantURL, participantTimeout, participantToken,
  PARTICIPANT_PROTOCOL, PARTICIPANT_REQUEST_BYTES } from "./participant-protocol.ts";

type Endpoint = { authority(meetingId: string): Authority | undefined; identity: Pick<RuntimeAgent["identity"], "clusterId" | "runtimeId" | "incarnation"> };
function credential(value: unknown, nodeId: string, command = false): boolean {
  return record(value) && fields(value, command ? ["participantId", "secret", "id", "lamport", "operation"] : ["participantId", "secret"])
    && value.participantId === nodeId && typeof value.secret === "string" && /^[a-f0-9]{64}$/.test(value.secret);
}

/** Trusted local participant-agent ingress. Each request still checks current
 * runtime authority and opens a fresh SQL transaction with the exact fence. */
export async function serveParticipants(agent: Endpoint, store: Pick<MeetingStore, "execute" | "read">, options: {
  address: string; token: string; wire?: ControlWire; timeoutMs?: number; maxConcurrent?: number; maxClients?: number;
}) {
  const url = participantURL(options.address); participantToken(options.token);
  const deadline = participantTimeout(options.timeoutMs), maxConcurrent = options.maxConcurrent ?? 32, maxClients = options.maxClients ?? 128;
  if (![maxConcurrent, maxClients].every(n => Number.isSafeInteger(n) && n > 0 && n <= 256)) throw new Error("INVALID_PARTICIPANT_BOUNDS");
  const wire = options.wire ?? new ControlWire({ clusterId: agent.identity.clusterId, nodeId: agent.identity.runtimeId, incarnation: agent.identity.incarnation });
  if (wire.identity.clusterId !== agent.identity.clusterId || wire.identity.nodeId !== agent.identity.runtimeId || wire.identity.incarnation !== agent.identity.incarnation) throw new Error("PARTICIPANT_WIRE_MISMATCH");
  const expected = Buffer.from(`Bearer ${options.token}`), pending = new Set<Promise<void>>();
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: PARTICIPANT_REQUEST_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(PARTICIPANT_PROTOCOL) ? PARTICIPANT_PROTOCOL : false });
  let active = 0, closing = false;
  server.maxConnections = 256; server.headersTimeout = deadline; server.requestTimeout = deadline;
  // The socket timeout covers partial headers, idle sockets and stalled SQL.
  // Underlying bounded SQL work retains admission until it actually settles.
  server.on("connection", socket => { socket.setTimeout(deadline, () => socket.destroy()); socket.on("error", () => {}); });
  server.on("upgrade", (request, socket, head) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (closing || request.url !== "/v1/participant" || request.headers.origin !== undefined
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
      || request.headers["sec-websocket-protocol"] !== PARTICIPANT_PROTOCOL) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    if (sockets.clients.size >= maxClients) { socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    sockets.handleUpgrade(request, socket, head, ws => { sockets.emit("connection", ws); });
  });
  sockets.on("connection", socket => {
    socket.on("error", () => {});
    let busy = false;
    function send(packet: unknown): void {
      const text = JSON.stringify(packet);
      if (Buffer.byteLength(text) > MAX_ENVELOPE_BYTES || socket.bufferedAmount + Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) { socket.terminate(); return; }
      if (socket.readyState === WebSocket.OPEN) socket.send(text, error => { if (error) socket.terminate(); });
    }
    socket.on("message", (data, binary) => {
      let packet;
      try { if (binary) throw new Error("BINARY"); packet = wire.accept(JSON.parse(data.toString())); }
      catch { socket.terminate(); return; }
      if (busy || active >= maxConcurrent) { send(wire.reply(packet, null, { code: "BUSY", message: "BUSY" })); return; }
      active++; busy = true;
      const timer = setTimeout(() => socket.terminate(), deadline);
      const work = (async () => {
        let result: unknown = null, error: { code: string; message: string } | undefined;
        try {
          const body = packet.body;
          if (!record(body) || body.version !== 1 || !validParticipantOwner(body.owner)
            || !fields(body, ["version", "owner", "operation", "command", "credential", "after", "limit", "subscriptionRevision"])) throw new StoreError("INVALID_REQUEST");
          const owner = body.owner;
          if (body.operation === "execute") {
            const c = body.command;
            if (!credential(c, packet.nodeId, true) || !record(c) || typeof c.id !== "string" || !UUID_PATTERN.test(c.id)
              || !Number.isSafeInteger(c.lamport) || (c.lamport as number) < 1 || (c.lamport as number) >= Number.MAX_SAFE_INTEGER - 4
              || body.credential !== undefined || body.after !== undefined || body.limit !== undefined || body.subscriptionRevision !== undefined) throw new StoreError("INVALID_REQUEST");
            try { validateOperation(c.operation as Operation); } catch { throw new StoreError("INVALID_REQUEST"); }
          } else if (body.operation === "read") {
            if (!credential(body.credential, packet.nodeId) || body.command !== undefined || body.subscriptionRevision !== 0
              || !Number.isSafeInteger(body.after) || (body.after as number) < 0 || !Number.isSafeInteger(body.limit)
              || (body.limit as number) < 1 || (body.limit as number) > 100) throw new StoreError("INVALID_REQUEST");
          } else throw new StoreError("INVALID_REQUEST");
          if (owner.clusterId !== agent.identity.clusterId || owner.runtimeId !== agent.identity.runtimeId || owner.incarnation !== agent.identity.incarnation) throw new StoreError("RUNTIME_MISMATCH");
          const authority = agent.authority(owner.meetingId);
          if (!authority || !authority.ready()) throw new StoreError("NOT_READY");
          if (!sameOwner(authority.owner, owner)) throw new StoreError("FENCED");
          result = body.operation === "execute" ? await store.execute(authority, body.command as unknown as MeetingCommand)
            : await store.read(authority, body.credential as unknown as ParticipantCredential, body.after as number, body.limit as number);
          result = { owner, result };
        } catch (cause) {
          const code = cause instanceof StoreError ? cause.code : "DEPENDENCY_UNAVAILABLE";
          error = { code, message: code };
        } finally { clearTimeout(timer); active--; busy = false; }
        send(wire.reply(packet, result, error));
      })();
      pending.add(work); void work.finally(() => pending.delete(work)).catch(() => socket.terminate());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""), () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("PARTICIPANT_LISTENER_FAILED");
  let closed: Promise<void> | undefined;
  return { address: `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    close(): Promise<void> {
      return closed ??= (async () => {
        closing = true; for (const socket of sockets.clients) socket.terminate();
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await new Promise<void>(resolve => sockets.close(() => resolve())); await Promise.allSettled([...pending]);
      })();
    } };
}
