import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
import { ControlWire, UUID_PATTERN, type Envelope } from "../coordination/wire.ts";
import { fields, participantTimeout, participantURL, record } from "../coordination/participant-protocol.ts";
import type { Operation } from "../storage/engine.ts";
import type { ClientSession } from "./client-session.ts";

export interface Attachment { id: string; revision: number }
export interface CaptureLease { revision: number; owner: Attachment | null }
export interface BrowserOptions { address: string; wire?: ControlWire; timeoutMs?: number; maxClients?: number }
const PROTOCOL = "zoom.attachment.v1", OUTPUT_BYTES = 8 * 1024 * 1024;
const same = (a: Attachment | null, b: Attachment) => a?.id === b.id && a.revision === b.revision;

/** Local capability boundary only. Runtime readiness and SQL authorization stay
 * in ClientSession's existing transport. This service never opens a journal. */
export async function serveBrowserAttachment(session: ClientSession, options: BrowserOptions) {
  const url = participantURL(options.address), timeout = participantTimeout(options.timeoutMs ?? 30000);
  const maxClients = options.maxClients ?? 8;
  if (!Number.isSafeInteger(maxClients) || maxClients < 1 || maxClients > 32) throw new Error("INVALID_ATTACHMENT_BOUNDS");
  const view = session.view(0, 1);
  const wire = options.wire ?? new ControlWire({ clusterId: view.clusterId, nodeId: view.participantId, incarnation: randomUUID() });
  if (wire.identity.clusterId !== view.clusterId || wire.identity.nodeId !== view.participantId) throw new Error("ATTACHMENT_WIRE_MISMATCH");
  const token = randomBytes(32).toString("base64url"), expected = Buffer.from(token);
  // Assets are fixed at startup; no filesystem path is derived from a request.
  const assets = new Map<string, { type: string; text: string }>([
    ["/", { type: "text/html; charset=utf-8", text: '<!doctype html><meta charset="utf-8"><title>Participant attachment</title><h1>Participant attachment</h1><pre id="status">Connecting</pre><script type="module" src="/bootstrap.js"></script>' }],
  ]);
  for (const [path, file] of [["/attachment.js", "browser-attachment.js"], ["/bootstrap.js", "browser-bootstrap.js"]]) {
    // The protocol-only service can also be used without the optional page adapter.
    const text = await readFile(new URL(file, import.meta.url), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
    assets.set(path, { type: "text/javascript; charset=utf-8", text });
  }
  let origin = "", host = "", closing = false, revision = 0;
  let capture: CaptureLease = { revision: 0, owner: null };
  const attached = new Map<WebSocket, Attachment>();
  function send(socket: WebSocket, packet: unknown): void {
    const text = JSON.stringify(packet), bytes = Buffer.byteLength(text);
    if (bytes > OUTPUT_BYTES || socket.bufferedAmount + bytes > OUTPUT_BYTES) { socket.terminate(); return; }
    if (socket.readyState === WebSocket.OPEN) socket.send(text, error => { if (error) socket.terminate(); });
  }
  function changeCapture(owner: Attachment | null) {
    capture = { revision: capture.revision + 1, owner };
    const event = { ...wire.request({ version: 1, event: "capture", capture }), kind: "control.event" };
    for (const socket of attached.keys()) send(socket, event);
  }
  const server = createServer((request, response) => {
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      response.writeHead(403, headers).end(); return;
    }
    const asset = assets.get(request.url ?? "");
    if (closing || request.method !== "GET" || !asset) { response.writeHead(404, headers).end(); return; }
    const text = asset.text.replace("/*ATTACHMENT_CONFIG*/null", JSON.stringify({ ...wire.identity, origin, timeoutMs: timeout }));
    response.writeHead(200, { ...headers, "Content-Type": asset.type }).end(text);
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(PROTOCOL) ? PROTOCOL : false });
  server.maxConnections = 64; server.headersTimeout = timeout; server.requestTimeout = timeout;
  server.on("connection", socket => { socket.setTimeout(timeout, () => socket.destroy()); socket.on("error", () => {}); });
  server.on("upgrade", (request, socket, head) => {
    if (closing || request.method !== "GET" || request.url !== "/v1/attachment" || request.headers.host !== host
      || request.headers.origin !== origin || request.headers["sec-websocket-protocol"] !== PROTOCOL) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    if (sockets.clients.size >= maxClients) { socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws));
  });
  sockets.on("connection", socket => {
    socket.on("error", () => {});
    const idle = setTimeout(() => socket.terminate(), timeout);
    let identity: { nodeId: string; incarnation: string } | undefined, lamport = 0;
    socket.once("close", () => {
      clearTimeout(idle);
      const ref = attached.get(socket); attached.delete(socket);
      // A delayed close from a superseded capture owner cannot release its successor.
      if (ref && same(capture.owner, ref)) changeCapture(null);
    });
    socket.on("message", (data, binary) => {
      let packet: Envelope;
      try {
        if (binary) throw new Error("BINARY");
        const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data as Buffer));
        if (!record(raw) || typeof raw.requestId !== "string" || !UUID_PATTERN.test(raw.requestId) || !record(raw.body)) throw new Error("INVALID_REQUEST");
        if (!attached.has(socket)) {
          const supplied = Buffer.from(typeof raw.body.token === "string" ? raw.body.token : "");
          if (raw.body.action !== "attach" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            send(socket, wire.reply(raw as unknown as Envelope, null, { code: "UNAUTHORIZED", message: "UNAUTHORIZED" })); socket.close(1008); return;
          }
        }
        if (identity && (raw.nodeId !== identity.nodeId || raw.incarnation !== identity.incarnation || (raw.lamport as number) <= lamport)) throw new Error("STALE_FRAME");
        packet = wire.accept(raw); lamport = packet.lamport;
      } catch { socket.terminate(); return; }
      idle.refresh();
      try {
        const body = packet.body as Record<string, unknown>;
        if (body.version !== 1 || !fields(body, ["version", "action", "token", "attachment", "operation", "after", "limit", "captureRevision"])) throw new Error("INVALID_REQUEST");
        let result: Record<string, unknown>;
        const ref = attached.get(socket);
        if (!ref) {
          if (!fields(body, ["version", "action", "token"])) throw new Error("INVALID_REQUEST");
          const attachment = { id: randomUUID(), revision: ++revision };
          identity = { nodeId: packet.nodeId, incarnation: packet.incarnation }; attached.set(socket, attachment);
          result = { attachment, capture };
        } else {
          if (!record(body.attachment) || !same(body.attachment as unknown as Attachment, ref) || !fields(body.attachment, ["id", "revision"])) throw new Error("STALE_ATTACHMENT");
          if (body.token !== undefined) throw new Error("INVALID_REQUEST");
          if (body.action === "view") {
            const limit = body.limit ?? 16;
            if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new Error("INVALID_CURSOR");
            result = { view: session.view(body.after as number | undefined, Math.min(limit as number, 16)), capture };
          } else if (body.action === "submit") result = { commandId: session.submit(body.operation as Operation), capture };
          else if (body.action === "capture.claim" || body.action === "capture.release") {
            if (body.captureRevision !== capture.revision) throw new Error("STALE_CAPTURE");
            if (body.action === "capture.claim") { if (!same(capture.owner, ref)) changeCapture(ref); }
            else { if (!same(capture.owner, ref)) throw new Error("NOT_CAPTURE_OWNER"); changeCapture(null); }
            result = { capture };
          } else throw new Error("INVALID_REQUEST");
        }
        send(socket, wire.reply(packet, result));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "INVALID_REQUEST";
        const code = /^[A-Z_]{1,64}$/.test(message) ? message : "INVALID_REQUEST";
        send(socket, wire.reply(packet, null, { code, message: code }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""), () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("ATTACHMENT_LISTENER_FAILED");
  host = `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`; origin = `http://${host}`;
  let closed: Promise<void> | undefined;
  return { origin, url: `${origin}/#${token}`, close(): Promise<void> {
    return closed ??= (async () => {
      closing = true; for (const socket of sockets.clients) socket.terminate();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    })();
  } };
}
