import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { connect as connectTCP } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import { serveBrowserAttachment } from "../client/browser-attachment.ts";
import { ClientSession } from "../client/client-session.ts";
import { SessionJournal } from "../client/session-journal.ts";
import { ControlWire } from "../coordination/wire.ts";
import { emptyState } from "../storage/engine.ts";
import { startParticipant } from "../client/participant-agent.ts";

async function fixture(timeoutMs = 2000, maxClients = 8) {
  const root = await mkdtemp(join(tmpdir(), "zoom-attachment-"));
  const target = { clusterId: randomUUID(), meetingId: randomUUID(), name: "Alice" };
  const journal = SessionJournal.open(join(root, "session.sqlite"), target);
  const session = new ClientSession(journal, async () => { throw new Error("OFFLINE"); });
  const wire = new ControlWire({ clusterId: target.clusterId, nodeId: journal.credential().participantId, incarnation: randomUUID() });
  const server = await serveBrowserAttachment(session, { address: "127.0.0.1:0", wire, timeoutMs, maxClients });
  const token = new URL(server.url).hash.slice(1), clients: WebSocket[] = [];
  async function connect(headers: Record<string, string> = { Origin: server.origin }) {
    const socket = new WebSocket(server.origin.replace("http:", "ws:") + "/v1/attachment", "zoom.attachment.v1", { headers });
    socket.on("error", () => {}); clients.push(socket);
    await once(socket, "open");
    const clientWire = new ControlWire({ clusterId: target.clusterId, nodeId: randomUUID(), incarnation: randomUUID() });
    const events: any[] = [];
    socket.on("message", data => { const p = JSON.parse(data.toString()); if (p.kind === "control.event") events.push(p); });
    let attachment: unknown;
    async function call(action: string, body: object = {}, stamp?: number) {
      const packet = clientWire.request({ version: 1, action, ...(attachment ? { attachment } : {}), ...body });
      if (stamp !== undefined) packet.lamport = stamp;
      const reply = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("REPLY_TIMEOUT")); }, Math.max(2000, timeoutMs));
        const closed = () => { cleanup(); reject(new Error("ATTACHMENT_CLOSED")); };
        const receive = (data: WebSocket.RawData) => {
          const p = JSON.parse(data.toString()); if (p.requestId !== packet.requestId || p.kind !== "control.reply") return;
          cleanup();
          try { resolve(clientWire.receive(p, packet.requestId, wire.identity.nodeId)); } catch (e) { reject(e); }
        };
        function cleanup() { clearTimeout(timer); socket.off("message", receive); socket.off("close", closed); }
        socket.on("message", receive); socket.once("close", closed);
      });
      socket.send(JSON.stringify(packet)); return reply;
    }
    return { socket, events, call, async attach(secret = token, stamp?: number) {
      const p = await call("attach", { token: secret }, stamp); attachment = p.body?.attachment; return p;
    } };
  }
  return { session, journal, server, target, token, connect, wire, async close() {
    for (const client of clients) client.terminate(); await server.close(); journal.close(); await rm(root, { recursive: true, force: true });
  } };
}

function httpStatus(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => { const r = request(url, { headers }, res => { res.resume(); resolve(res.statusCode!); }); r.on("error", reject); r.end(); });
}

test("attachment requires exact Host/Origin, token and protocol before exposing shared state", async () => {
  const f = await fixture();
  try {
    assert.equal(await httpStatus(f.server.origin + "/"), 200);
    assert.equal(await httpStatus(f.server.origin + "/", { Host: "evil.example" }), 403);
    assert.equal(await httpStatus(f.server.origin + "/", { Origin: "null" }), 403);
    for (const headers of [{}, { Origin: "null" }, { Origin: "https://evil.example" }, { Origin: f.server.origin, Host: "evil.example" }] as Record<string, string>[]) {
      await assert.rejects(f.connect(headers), /403/);
    }
    const bad = await f.connect();
    assert.equal((await bad.attach("x".repeat(43))).error.code, "UNAUTHORIZED");
    assert.equal(f.journal.pending().length, 1);
    const good = await f.connect(), attached = await good.attach();
    assert.ok(attached.body.attachment.revision > 0);
    assert.equal((await good.call("view")).body.view.participantId, f.session.view().participantId);
    assert.equal(JSON.stringify((await good.call("view")).body).includes(f.journal.credential().secret), false);
    await assert.rejects(serveBrowserAttachment(f.session, { address: "0.0.0.0:0" }), /ADDRESS/);
  } finally { await f.close(); }
});

test("reload and CLI share identity, pending command IDs and durable inbox without duplicating join", async () => {
  const f = await fixture();
  try {
    const first = await f.connect(), a = await first.attach();
    const cliId = f.session.submit({ type: "chat", content: "CLI pending" });
    const browserId = (await first.call("submit", { operation: { type: "chat", content: "browser pending" } })).body.commandId;
    f.journal.recordReplay(f.journal.cursor(), { meetingId: f.target.meetingId, code: "test", generation: 1,
      runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID(), phase: "ACTIVE", observedAt: new Date().toISOString(),
      watermark: 1, scannedWatermark: 1, state: emptyState(), events: [{ seq: 1, lamport: 2, generation: 1, kind: "chat", payload: { participantId: randomUUID(), content: "inbox" } }] });
    const closed = once(first.socket, "close"); first.socket.close(); await closed;
    const reloaded = await f.connect(), b = await reloaded.attach(), view = (await reloaded.call("view")).body.view;
    assert.ok(b.body.attachment.revision > a.body.attachment.revision);
    assert.equal(view.participantId, f.session.view().participantId);
    assert.deepEqual(view.commands.map((c: any) => c.id), f.session.view().commands.map(c => c.id));
    assert.ok(view.commands.some((c: any) => c.id === cliId && c.outcome === null));
    assert.ok(view.commands.some((c: any) => c.id === browserId && c.outcome === null));
    assert.deepEqual(view.events, f.session.view().events);
    assert.equal(view.cursor.subscriptionRevision, 0);
    assert.equal(view.commands.filter((c: any) => c.operation.type === "join").length, 1);
    assert.equal((await reloaded.call("submit", { attachment: a.body.attachment, operation: { type: "chat", content: "stale" } })).error.code, "STALE_ATTACHMENT");
    assert.equal(f.journal.pending().length, 3);
  } finally { await f.close(); }
});

test("capture compare-and-set allows one owner and fences stale releases and disconnects", async () => {
  const f = await fixture();
  try {
    const a = await f.connect(), b = await f.connect();
    const aa = await a.attach(), bb = await b.attach();
    assert.equal(aa.body.capture.owner, null);
    const claims = await Promise.all([a.call("capture.claim", { captureRevision: 0 }), b.call("capture.claim", { captureRevision: 0 })]);
    assert.equal(claims.filter(p => !p.error).length, 1);
    assert.equal(claims.filter(p => p.error?.code === "STALE_CAPTURE").length, 1);
    const old = claims.find(p => !p.error).body.capture;
    const next = (await b.call("capture.claim", { captureRevision: old.revision })).body.capture;
    assert.deepEqual(next.owner, bb.body.attachment);
    assert.equal((await a.call("capture.release", { captureRevision: old.revision })).error.code, "STALE_CAPTURE");
    const closed = once(a.socket, "close"); a.socket.close(); await closed;
    assert.deepEqual((await b.call("view")).body.capture, next);
    assert.ok(a.events.some(p => p.body.capture.owner?.id === bb.body.attachment.id));
    const released = (await b.call("capture.release", { captureRevision: next.revision })).body.capture;
    assert.equal(released.owner, null);
    assert.ok(released.revision > next.revision);
    assert.notDeepEqual(aa.body.attachment, bb.body.attachment);
  } finally { await f.close(); }
});

test("unauthenticated and idle attachments expire, malformed frames fail closed and admission is bounded", async () => {
  const f = await fixture(150, 1);
  try {
    const idle = await f.connect();
    await assert.rejects(f.connect(), /503/);
    await once(idle.socket, "close");
    const authenticated = await f.connect(); await authenticated.attach();
    const closed = once(authenticated.socket, "close"); authenticated.socket.send(Buffer.alloc(65537)); await closed;
    const again = await f.connect(); await again.attach();
    assert.equal((await again.call("view")).body.view.commands.length, 1);
    await once(again.socket, "close");
  } finally { await f.close(); }
});

test("agent owns one browser lifecycle, rotates capability on restart and closes failed startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "zoom-attachment-agent-"));
  const config = { sessionPath: join(root, "session.sqlite"), target: { clusterId: randomUUID(), meetingId: randomUUID(), name: "Alice" },
    helpers: [{ helperId: randomUUID(), address: "127.0.0.1:1" }], helperToken: "h".repeat(64), helperTimeoutMs: 50,
    routes: [{ runtimeId: randomUUID(), incarnation: randomUUID(), address: "127.0.0.1:1", token: "r".repeat(64) }], browser: { address: "127.0.0.1:0" } };
  const agent = startParticipant(config);
  try {
    const [one, two] = await Promise.all([agent.openBrowser(), agent.openBrowser()]);
    assert.equal(one, two);
    const participantId = agent.session.view().participantId;
    await Promise.all([agent.close(), agent.close()]);
    await assert.rejects(fetch(one.origin), /fetch failed/);
    assert.throws(() => agent.openBrowser(), /CLOSED/);
    const restarted = startParticipant(config);
    try {
      const next = await restarted.openBrowser();
      assert.equal(restarted.session.view().participantId, participantId);
      assert.notEqual(new URL(next.url).hash, new URL(one.url).hash);
    } finally { await restarted.close(); }
    const failed = startParticipant({ ...config, browser: { address: "0.0.0.0:0" } });
    await assert.rejects(failed.openBrowser(), /ADDRESS/);
    await failed.close();
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});

test("attachment rejects out-of-range browser clock before advancing the shared agent clock", async () => {
  const f = await fixture();
  try {
    const browser = await f.connect(), before = f.wire.logicalTime;
    const closed = once(browser.socket, "close");
    // Ignore the request waiter's timeout: the invalid attachment must close
    // without accepting the remote time or emitting a reply.
    void browser.attach(f.token, Number.MAX_SAFE_INTEGER - 4).catch(() => {});
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("CLOCK_FRAME_ACCEPTED")), 300))]);
    assert.equal(f.wire.logicalTime, before);
    const valid = await f.connect(); await valid.attach();
    assert.equal((await valid.call("view")).body.view.participantId, f.session.view().participantId);
  } finally { await f.close(); }
});

test("shutdown destroys rejected upgrades even when the peer keeps its write side open", { timeout: 2000 }, async () => {
  const f = await fixture(100), url = new URL(f.server.origin);
  const socket = connectTCP({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
  socket.on("error", () => {});
  let writes: NodeJS.Timeout | undefined;
  try {
    await once(socket, "connect");
    const response = once(socket, "data");
    socket.write(`GET /v1/attachment HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: https://foreign.example\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Protocol: zoom.attachment.v1\r\n\r\n`);
    assert.match(String((await response)[0]), /403/);
    writes = setInterval(() => { if (!socket.destroyed) socket.write("x"); }, 20);
    await Promise.race([f.server.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("SHUTDOWN_BLOCKED")), 300))]);
  } finally { clearInterval(writes); socket.destroy(); await f.close(); }
});

test("partial HTTP headers have an absolute deadline even if bytes continue arriving", async () => {
  const f = await fixture(100), url = new URL(f.server.origin);
  const socket = connectTCP({ host: url.hostname, port: Number(url.port) }); socket.on("error", () => {});
  let writes: NodeJS.Timeout | undefined;
  try {
    await once(socket, "connect"); const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    socket.write("GET / HTTP/1.1\r\nHost: "); writes = setInterval(() => socket.write("a"), 20);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("HEADERS_NOT_EXPIRED")), 350))]);
  } finally { clearInterval(writes); socket.destroy(); await f.close(); }
});

test("bounded local views retain all pending contents and a full page under worst-case JSON escaping", async () => {
  const f = await fixture(10000);
  try {
    const content = "\u0001".repeat(8191) + "x";
    for (let i = 0; i < 127; i++) f.session.submit({ type: "chat", content });
    f.journal.recordReplay(f.journal.cursor(), { meetingId: f.target.meetingId, code: "test", generation: 1,
      runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID(), phase: "ACTIVE", observedAt: new Date().toISOString(),
      watermark: 16, scannedWatermark: 16, state: emptyState(), events: Array.from({ length: 16 }, (_, i) => ({
        seq: i + 1, lamport: i + 1, generation: 1, kind: "chat", payload: { participantId: randomUUID(), content },
      })) });
    const browser = await f.connect(); await browser.attach();
    const view = (await browser.call("view", { limit: 200 })).body.view;
    assert.equal(view.commands.length, 128);
    assert.equal(view.commands.at(-1).operation.content, content);
    assert.equal(view.events.length, 16);
    assert.equal(view.events.at(-1).payload.content, content);
  } finally { await f.close(); }
});
