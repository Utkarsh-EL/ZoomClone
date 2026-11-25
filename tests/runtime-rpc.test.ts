import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { RemoteRuntime, availableRuntimes, serveRuntime } from "../coordination/runtime-rpc.ts";
import { ControlWire } from "../coordination/wire.ts";
import type { Owner } from "../storage/meeting-store.ts";

function setup() {
  const clusterId = randomUUID(), runtimeId = randomUUID(), incarnation = randomUUID(), callerId = randomUUID();
  const identity = { clusterId, nodeId: callerId, incarnation: randomUUID() };
  const token = randomBytes(32).toString("hex");
  const owner: Owner = { clusterId, runtimeId, incarnation, meetingId: randomUUID(), generation: 1, attemptId: randomUUID() };
  let prepared = 0;
  const agent = { identity: { clusterId, runtimeId, incarnation }, registered: true,
    async prepare(value: Owner) { assert.deepEqual(value, owner); prepared++; } };
  return { agent, owner, token, identity, callerId, prepared: () => prepared };
}

test("remote candidates authenticate, pin the runtime incarnation and exchange stamped correlated frames", async () => {
  const f = setup();
  const service = await serveRuntime(f.agent, { address: "127.0.0.1:0", token: f.token, callers: [f.callerId] });
  const options = { ...f.agent.identity, address: service.address, token: f.token, identity: f.identity };
  try {
    const remote = new RemoteRuntime(options);
    assert.equal(await remote.available(), true);
    await remote.prepare(f.owner);
    assert.equal(f.prepared(), 1);
    assert.ok(remote.logicalTime >= 4);
    assert.deepEqual(await availableRuntimes([remote]), [remote]);
    await assert.rejects(new RemoteRuntime({ ...options, token: randomBytes(32).toString("hex") }).prepare(f.owner), /HTTP_401/);
    await assert.rejects(new RemoteRuntime({ ...options, incarnation: randomUUID() }).prepare({ ...f.owner, incarnation: randomUUID() }), /RUNTIME_MISMATCH/);
    const stale = new RemoteRuntime({ ...options, incarnation: randomUUID() });
    assert.equal(await stale.available(), false);
    await assert.rejects(stale.prepare({ ...f.owner, incarnation: stale.incarnation }), /INCARNATION|RUNTIME_MISMATCH/);
    assert.equal(f.prepared(), 1);
    f.agent.registered = false;
    assert.deepEqual(await availableRuntimes([remote]), []);
  } finally { await service.close(); }
});

test("runtime RPC rejects wrong callers, owner fields and framing before adapter work", async () => {
  const f = setup();
  const service = await serveRuntime(f.agent, { address: "127.0.0.1:0", token: f.token, callers: [f.callerId] });
  const wire = new ControlWire(f.identity);
  const send = async (packet: unknown) => {
    const response = await fetch(`http://${service.address}/v1/runtime`, { method: "POST", headers: { Authorization: `Bearer ${f.token}` }, body: typeof packet === "string" ? packet : JSON.stringify(packet) + "\n" });
    const text = await response.text(); return { status: response.status, text };
  };
  const body = { operation: "prepare", runtimeId: f.owner.runtimeId, incarnation: f.owner.incarnation, owner: f.owner };
  try {
    const badCaller = wire.request(body); badCaller.nodeId = randomUUID();
    assert.equal((await send(badCaller)).status, 403);
    assert.equal((await send(wire.request({ ...body, owner: { ...f.owner, generation: "1" } }))).status, 400);
    assert.equal((await send(wire.request({ ...body, owner: { ...f.owner, extra: "untrusted" } }))).status, 400);
    assert.equal((await send(wire.request({ ...body, operation: "install" }))).status, 400);
    assert.equal((await send(JSON.stringify(wire.request(body)))).status, 400);
    assert.equal((await send("x".repeat(65537))).status, 413);
    assert.equal(f.prepared(), 0);
  } finally { await service.close(); }
});

test("slow runtime calls time out while server capacity remains bounded", async () => {
  const f = setup();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  const arrived = new Promise<void>(r => { entered = r; });
  f.agent.prepare = async () => { entered(); await waiting; };
  const service = await serveRuntime(f.agent, { address: "127.0.0.1:0", token: f.token, callers: [f.callerId], maxConcurrent: 1, timeoutMs: 100 });
  const options = { ...f.agent.identity, address: service.address, token: f.token, identity: f.identity };
  try {
    const remote = new RemoteRuntime({ ...options, timeoutMs: 30 });
    const pending = assert.rejects(remote.prepare(f.owner), /unavailable|timeout/i);
    await arrived;
    await assert.rejects(new RemoteRuntime(options).prepare(f.owner), /HTTP_503/);
    await pending;
  } finally { release(); await service.close(); }
});

test("a runtime client rejects a correlated response from the wrong incarnation", async () => {
  const f = setup();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const packet = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify({ ...packet, nodeId: f.owner.runtimeId, incarnation: randomUUID(),
        kind: "control.reply", lamport: packet.lamport + 1, body: { registered: true } }) + "\n");
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    assert.equal(await new RemoteRuntime({ ...f.agent.identity, address: `127.0.0.1:${address.port}`, token: f.token, identity: f.identity }).available(), false);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("a partial request is disconnected at its deadline without terminating the listener", async () => {
  const f = setup();
  const service = await serveRuntime(f.agent, { address: "127.0.0.1:0", token: f.token, callers: [f.callerId], timeoutMs: 40 });
  const socket = connect(Number(service.address.split(":").at(-1)), "127.0.0.1");
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(`POST /v1/runtime HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.token}\r\nContent-Length: 1000\r\n\r\n{`);
    await closed;
    const remote = new RemoteRuntime({ ...f.agent.identity, address: service.address, token: f.token, identity: f.identity });
    assert.equal(await remote.available(), true);
    assert.equal(f.prepared(), 0);
  } finally { socket.destroy(); await service.close(); }
});

test("partial HTTP headers cannot retain a connection beyond the runtime deadline", async () => {
  const f = setup();
  const service = await serveRuntime(f.agent, { address: "127.0.0.1:0", token: f.token, callers: [f.callerId], timeoutMs: 40 });
  const socket = connect(Number(service.address.split(":").at(-1)), "127.0.0.1");
  socket.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, "connect");
    const closed = once(socket, "close").then(() => true);
    socket.write("POST /v1/runtime HTTP/1.1\r\nHost: localhost\r\nX-Slow: ");
    assert.equal(await Promise.race([closed, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 400); })]), true);
    assert.equal(f.prepared(), 0);
  } finally { clearTimeout(timer); socket.destroy(); await service.close(); }
});

test("controller routes share one Lamport clock across destinations", async () => {
  const f = setup(), observed: number[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const packet = JSON.parse(Buffer.concat(chunks).toString()); observed.push(packet.lamport);
      response.end(JSON.stringify({ ...packet, nodeId: f.owner.runtimeId, incarnation: f.owner.incarnation,
        kind: "control.reply", lamport: packet.lamport + 100, body: { registered: true } }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const options = { ...f.agent.identity, address: `127.0.0.1:${address.port}`, token: f.token, identity: f.identity };
  const wire = new ControlWire(f.identity);
  try {
    const first = new RemoteRuntime(options, wire), second = new RemoteRuntime(options, wire);
    assert.equal(await first.available(), true);
    assert.equal(await second.available(), true);
    assert.ok(observed[1] > observed[0] + 100, "second route ignored the first route's receive event");
    assert.throws(() => new RemoteRuntime(options, new ControlWire({ ...f.identity, incarnation: randomUUID() })), /identity mismatch/i);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
