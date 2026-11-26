import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { serveParticipants } from "../coordination/participant-gateway.ts";
import { ParticipantConnection, participantResolver } from "../client/participant-transport.ts";
import { ControlWire } from "../coordination/wire.ts";
import { emptyState } from "../storage/engine.ts";
import { StoreError, type MeetingCommand, type Owner } from "../storage/types.ts";

function fixture() {
  const owner: Owner = { clusterId: randomUUID(), meetingId: randomUUID(), runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID(), generation: 1 };
  const identity = { clusterId: owner.clusterId, nodeId: randomUUID(), incarnation: randomUUID() };
  const command: MeetingCommand = { participantId: identity.nodeId, secret: randomBytes(32).toString("hex"), id: randomUUID(), lamport: 1, operation: { type: "join", name: "Alice" } };
  const token = randomBytes(32).toString("hex");
  let ready = true, calls = 0;
  const gate = { owner, ready: () => ready };
  const agent = { identity: { clusterId: owner.clusterId, runtimeId: owner.runtimeId, incarnation: owner.incarnation }, authority: () => gate };
  const store = {
    async execute(_authority: unknown, input: MeetingCommand) { calls++; if (input.secret !== command.secret) throw new StoreError("AUTH_REQUIRED"); return { code: "OK", seq: 1, generation: 1, grantVersion: 0 }; },
    async read() { calls++; return { meetingId: owner.meetingId, code: "socket", generation: 1, runtimeId: owner.runtimeId, incarnation: owner.incarnation,
      attemptId: owner.attemptId, phase: "ACTIVE" as const, watermark: 1, state: emptyState(), observedAt: new Date().toISOString(),
      events: [{ seq: 1, generation: 1, lamport: 1, kind: "joined", payload: { participantId: identity.nodeId, name: "Alice" } }], scannedWatermark: 1 }; },
    async listGroups(_auth?: unknown, p?: any, after?: string, limit?: number) { calls++; if (p.secret !== command.secret) throw new StoreError("AUTH_REQUIRED"); return { groups: [], nextAfter: null }; },
    async readGroup(_auth?: unknown, p?: any, groupId?: string, after?: number, limit?: number): Promise<import("../storage/types.ts").GroupReplay> { calls++; throw new StoreError("GROUP_ACCESS_DENIED"); },
  };
  return { owner, identity, command, token, agent, store, calls: () => calls, unready: () => { ready = false; } };
}

test("scoped production requests authenticate the caller and reject old protocol handshakes", async () => {
  const f = fixture(), service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token });
  const connection = await ParticipantConnection.connect({ ...f, address: service.address });
  try {
    assert.deepEqual(await connection.listGroups(f.command, "", 16), { groups: [], nextAfter: null });
    await assert.rejects(connection.readGroup(f.command, randomUUID(), 0, 16), /GROUP_ACCESS_DENIED/);
    await assert.rejects(connection.listGroups({ ...f.command, secret: "f".repeat(64) }, "", 16), /AUTH_REQUIRED/);
    const before = f.calls();
    await assert.rejects(connection.readGroup(f.command, randomUUID(), 0, 17), /INVALID_REQUEST/);
    assert.equal(f.calls(), before);
    const old = new WebSocket(`ws://${service.address}/v2/participant`, "zoom.participant.v1", { headers: { Authorization: `Bearer ${f.token}` } });
    old.on("error", () => {});
    await assert.rejects(once(old, "open")); old.terminate();
  } finally { connection.close(); await service.close(); }
});

test("a pinned participant connection rejects private history from an impossible future generation", async () => {
  const f = fixture(), groupId = randomUUID();
  f.store.readGroup = async () => ({ groupId, watermark: 1, scannedWatermark: 1,
    events: [{ seq: 1, generation: 9000, lamport: 1, kind: "group-left", payload: { participantId: f.identity.nodeId } }] });
  const service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token });
  const connection = await ParticipantConnection.connect({ ...f, address: service.address });
  try { await assert.rejects(connection.readGroup(f.command, groupId, 0, 16), /INVALID_GROUP_CURSOR/); }
  finally { connection.close(); await service.close(); }
});

test("production participant sockets pin authority, stamp replies and pass resume credentials to fenced storage", async () => {
  const f = fixture();
  const wire = new ControlWire({ clusterId: f.owner.clusterId, nodeId: f.owner.runtimeId, incarnation: f.owner.incarnation });
  const service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token, wire });
  const options = { ...f, address: service.address, timeoutMs: 500 };
  const connection = await ParticipantConnection.connect(options);
  try {
    assert.equal((await connection.execute(f.command)).code, "OK");
    assert.equal((await connection.read(f.command, 0, 100)).scannedWatermark, 1);
    assert.ok(wire.logicalTime > f.command.lamport);
    await assert.rejects(connection.execute({ ...f.command, secret: "a".repeat(64) }), /AUTH_REQUIRED/);
    f.unready();
    await assert.rejects(connection.execute(f.command), /NOT_READY/);
    await assert.rejects(connection.read(f.command, 0, 100), /NOT_READY/);
    assert.equal(f.calls(), 3);
  } finally { connection.close(); await service.close(); }
});

test("production media ingress authenticates fresh storage, scopes peers and refuses stale authority", async () => {
  const { RuntimeMedia } = await import("../media/runtime-media.ts");
  const f = fixture(), effects: any[] = [], peerId = randomUUID();
  f.store.read = async (_authority?: unknown, credential?: any) => {
    if (credential?.secret !== f.command.secret) throw new StoreError("AUTH_REQUIRED");
    return { code: "socket", ...f.owner, phase: "ACTIVE" as const, watermark: 1,
      state: { ...emptyState(), members: { [f.command.participantId]: { name: "Alice", joined: true } } },
      observedAt: new Date().toISOString(), events: [], scannedWatermark: 1 };
  };
  const media = new RuntimeMedia([{ meetingId: f.owner.meetingId, effect: async r => { effects.push(r); return { epoch: "epoch", value: "ok" }; } }]);
  const service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token, media });
  const connection = await ParticipantConnection.connect({ ...f, address: service.address });
  try {
    assert.equal((await connection.media(f.command, peerId, { action: "open" }, false)).value, "ok");
    assert.equal(effects.at(-1).peerId, `${f.identity.nodeId}/${f.identity.incarnation}/${peerId}`);
    const count = effects.length;
    await assert.rejects(connection.media({ ...f.command, secret: "f".repeat(64) }, peerId, { action: "list", epoch: "epoch" }, false), /AUTH_REQUIRED/);
    assert.equal(effects.filter(e => e.action !== "hello").length, count - 1);
    await assert.rejects(connection.media(f.command, peerId, { action: "produce", source: "camera", epoch: "epoch" }, false), /NOT_CAPTURE_OWNER/);
    // Failed fresh credentials must not exhaust this meeting's shared room.
    for (let i = 0; i < 8; i++) await assert.rejects(connection.media({ ...f.command, secret: "f".repeat(64) }, randomUUID(), { action: "open" }, false), /AUTH_REQUIRED/);
    assert.equal((await connection.media(f.command, randomUUID(), { action: "open" }, false)).value, "ok");
    f.unready();
    await assert.rejects(connection.media(f.command, peerId, { action: "open" }, true), /NOT_READY/);
  } finally { connection.close(); await service.close(); await media.close(); }
});

test("stalled SFU work cannot consume the durable command admission budget", async () => {
  let release!: () => void, entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), f = fixture();
  const media = { async handle() { entered(); await new Promise<void>(resolve => { release = resolve; }); return { epoch: "epoch", value: {} }; } };
  const service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token, maxConcurrent: 1, media: media as any });
  const publishing = await ParticipantConnection.connect({ ...f, address: service.address });
  const chatting = await ParticipantConnection.connect({ ...f, address: service.address });
  try {
    const work = publishing.media(f.command, randomUUID(), { action: "open" }, false); await arrived;
    try { assert.equal((await chatting.execute(f.command)).code, "OK"); }
    finally { release(); await work; }
  } finally { release?.(); publishing.close(); chatting.close(); await service.close(); }
});

test("gateway rejects unauthenticated browser/agent sockets and stale owners before storage", async () => {
  const f = fixture(), service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token });
  try {
    await assert.rejects(ParticipantConnection.connect({ ...f, address: service.address, token: "b".repeat(64), timeoutMs: 200 }), /unavailable|401/i);
    const socket = new WebSocket(`ws://${service.address}/v2/participant`, "zoom.participant.v2", { origin: "http://malicious.example", headers: { Authorization: `Bearer ${f.token}` } });
    await once(socket, "error");
    const stale = await ParticipantConnection.connect({ ...f, address: service.address, owner: { ...f.owner, incarnation: randomUUID() } });
    try { await assert.rejects(stale.execute(f.command), /INCARNATION_MISMATCH/); } finally { stale.close(); }
    const wrong = await ParticipantConnection.connect({ ...f, address: service.address, identity: { ...f.identity, nodeId: randomUUID() } });
    try { await assert.rejects(wrong.execute(f.command), /INVALID_REQUEST/); } finally { wrong.close(); }
    assert.equal(f.calls(), 0);
  } finally { await service.close(); }
});

test("gateway bounds stalled work and rejects malformed and oversized WebSocket frames", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(r => { release = r; }), arrived = new Promise<void>(r => { entered = r; });
  f.store.execute = async () => { entered(); await blocked; return { code: "OK", seq: 1, generation: 1, grantVersion: 0 }; };
  const service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token, timeoutMs: 150, maxConcurrent: 1 });
  const first = await ParticipantConnection.connect({ ...f, address: service.address, timeoutMs: 100 });
  const second = await ParticipantConnection.connect({ ...f, address: service.address, timeoutMs: 500 });
  try {
    const pending = assert.rejects(first.execute(f.command), /unavailable|timeout|closed/i);
    await arrived;
    await assert.rejects(second.execute(f.command), /BUSY/);
    await pending;
    for (const data of ["{", "x".repeat(65537), Buffer.from("binary")]) {
      const socket = new WebSocket(`ws://${service.address}/v2/participant`, "zoom.participant.v2", { headers: { Authorization: `Bearer ${f.token}` } });
      socket.on("error", () => {}); await once(socket, "open");
      const closed = once(socket, "close"); socket.send(data); await closed;
    }
  } finally { release(); first.close(); second.close(); await service.close(); }
});

test("helper routing requires READY metadata and a provisioned matching runtime incarnation", async () => {
  const f = fixture(), service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token });
  const meeting = { id: f.owner.meetingId, code: "socket", generation: 1, assignment: { ...f.owner, phase: "READY" } };
  const state = { cluster: f.owner.clusterId, meetings: { [meeting.id]: meeting } };
  const helper = { async call<T>() { return state as T; } };
  const routes = [{ runtimeId: f.owner.runtimeId, incarnation: f.owner.incarnation, address: service.address, token: f.token }];
  try {
    const resolve = participantResolver({ ...f.identity, meetingId: meeting.id, helper, routes });
    const connection = await resolve(); await connection.execute(f.command); connection.close();
    meeting.assignment.phase = "INTENT";
    await assert.rejects(resolve(), /AUTHORITY_UNAVAILABLE/);
    meeting.assignment.phase = "READY"; meeting.assignment.incarnation = randomUUID();
    await assert.rejects(resolve(), /AUTHORITY_UNAVAILABLE/);
  } finally { await service.close(); }
});

test("idle upgraded sockets are closed at their deadline", async () => {
  const f = fixture(), service = await serveParticipants(f.agent, f.store, { address: "127.0.0.1:0", token: f.token, timeoutMs: 40 });
  const socket = new WebSocket(`ws://${service.address}/v2/participant`, "zoom.participant.v2", { headers: { Authorization: `Bearer ${f.token}` } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, "open");
    const closed = once(socket, "close").then(() => true);
    assert.equal(await Promise.race([closed, new Promise<boolean>(r => { timer = setTimeout(() => r(false), 300); })]), true);
  } finally { clearTimeout(timer); socket.terminate(); await service.close(); }
});

test("maximum-size escaped chat history replays in pages below the wire byte bound", async () => {
  const f = fixture();
  const store = { ...f.store, async read(_authority: unknown, _credential: unknown, after = 0, limit = 100) {
    const base = await f.store.read();
    const end = Math.min(100, after + limit);
    return { ...base, watermark: 100, scannedWatermark: end, events: Array.from({ length: end - after }, (_, i) => ({
      seq: after + i + 1, generation: 1, lamport: 1, kind: "chat", payload: { participantId: f.identity.nodeId, content: "\u0001".repeat(8192) },
    })) };
  } };
  const service = await serveParticipants(f.agent, store, { address: "127.0.0.1:0", token: f.token });
  const connection = await ParticipantConnection.connect({ ...f, address: service.address });
  try {
    let after = 0;
    const received: number[] = [];
    while (after < 100) {
      const page = await connection.read(f.command, after, 100);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
      received.push(...page.events.map(e => e.seq)); after = page.scannedWatermark;
    }
    assert.deepEqual(received, Array.from({ length: 100 }, (_, i) => i + 1));
  } finally { connection.close(); await service.close(); }
});

test("participant snapshot bounds roster size while SQL retains departed identities", async () => {
  const f = fixture();
  const state = emptyState();
  for (let i = 0; i < 6000; i++) state.members[randomUUID()] = { name: "x".repeat(200), joined: false };
  state.members[f.identity.nodeId] = { name: "Alice", joined: true };
  const store = { ...f.store, async read() { return { ...await f.store.read(), state }; } };
  const service = await serveParticipants(f.agent, store, { address: "127.0.0.1:0", token: f.token });
  const connection = await ParticipantConnection.connect({ ...f, address: service.address });
  try {
    const replay = await connection.read(f.command, 0, 100);
    assert.deepEqual(Object.keys(replay.state.members), [f.identity.nodeId]);
    assert.equal(Object.keys(state.members).length, 6001);
  } finally { connection.close(); await service.close(); }
});
