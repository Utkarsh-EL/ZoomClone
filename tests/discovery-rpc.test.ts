import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { DiscoveryNode } from "../coordination/discovery.ts";
import { discoveryTransport, serveDiscovery } from "../coordination/discovery-rpc.ts";
import { resolveMeeting } from "../coordination/meeting-resolver.ts";
import { ControlWire } from "../coordination/wire.ts";
import { discoveryId, toHex } from "../coordination/discovery-id.ts";
import type { HelperAccess, MetadataState } from "../coordination/helper-client.ts";
import type { Observation, Owner } from "../storage/types.ts";

test("four HTTP discovery peers use stamped authenticated frames and multiple bootstrap addresses", async () => {
  const clusterId = randomUUID(), token = randomBytes(32).toString("hex");
  const services: Awaited<ReturnType<typeof serveDiscovery>>[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const service = await serveDiscovery({ clusterId, nodeId: randomUUID(), incarnation: randomUUID(), token,
        address: "127.0.0.1:0", ...(i === 0 ? { initialize: true } : { bootstraps: ["127.0.0.1:1", services[0].address] }), intervalMs: 60_000 });
      services.push(service);
    }
    for (let round = 0; round < 6; round++) for (const service of services) await service.node.maintain(0);
    const hint = { generation: 1, expiresAt: Date.now() + 20_000, value: { address: "127.0.0.1:4321", ready: true } };
    await services[0].node.publish("meeting", "demo", hint);
    assert.deepEqual(await services[3].node.lookup("meeting", "demo"), hint);
    const identity = { clusterId, nodeId: randomUUID(), incarnation: randomUUID() };
    const transport = discoveryTransport(identity, token);
    const peer = services[0].node.self;
    await assert.rejects(transport(peer.address, { operation: "status" }, AbortSignal.timeout(1000), { ...peer, incarnation: randomUUID() }), /INCARNATION/);
    await assert.rejects(discoveryTransport(identity, "x".repeat(32))(peer.address, { operation: "status" }, AbortSignal.timeout(1000)), /401/);
    await assert.rejects(discoveryTransport({ ...identity, clusterId: randomUUID() }, token)(peer.address, { operation: "status" }, AbortSignal.timeout(1000)), /400/);
    const wire = new ControlWire(identity);
    const request = async (body: string) => {
      const response = await fetch(`http://${peer.address}/v1/discovery`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
      await response.text(); return response.status;
    };
    assert.equal(await request(JSON.stringify(wire.request({ operation: "route", key: 16 }))+"\n"), 400);
    assert.equal(await request("x".repeat(65537)), 413);
    assert.equal(await request(JSON.stringify(wire.request({ operation: "status" }))), 400);
    assert.ok(services[0].logicalTime > 0);
  } finally { await Promise.all(services.map(service => service.close())); }
});

test("authoritative resolution ignores hint readiness and requires matching READY metadata and ACTIVE SQL fence", async () => {
  const clusterId = randomUUID(), meetingId = randomUUID();
  const owner: Owner = { clusterId, meetingId, generation: 2, runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID() };
  const metadata: MetadataState = { version: 3, cluster: clusterId, highWater: 1, runtimes: {}, meetings: {
    [meetingId]: { id: meetingId, code: "demo", generation: owner.generation, assignment: { ...owner, phase: "READY", renewalRevision: 0 } },
  } };
  let unavailable = false;
  const helper: HelperAccess = { async call<T>(operation: string) {
    assert.equal(operation, "read"); if (unavailable) throw new Error("NO_QUORUM"); return structuredClone(metadata) as T;
  } };
  const observation = { ...owner, phase: "ACTIVE" } as unknown as Observation;
  const store = { async observe(id: string) { assert.equal(id, meetingId); return structuredClone(observation); } };
  assert.deepEqual(await resolveMeeting(clusterId, "demo", helper, store), { status: "ready", owner });
  observation.generation = 1;
  assert.deepEqual(await resolveMeeting(clusterId, "demo", helper, store), { status: "unavailable" });
  observation.generation = 2;
  metadata.meetings[meetingId].assignment!.phase = "INTENT";
  assert.deepEqual(await resolveMeeting(clusterId, "demo", helper, store), { status: "unavailable" });
  assert.deepEqual(await resolveMeeting(clusterId, "absent", helper, store), { status: "unknown" });
  unavailable = true;
  assert.deepEqual(await resolveMeeting(clusterId, "demo", helper, store), { status: "unavailable" });
  assert.deepEqual(await resolveMeeting(clusterId, "absent", helper, store), { status: "unavailable" });
});

test("bootstrap startup failure releases its listener and does not create a singleton", async () => {
  await assert.rejects(serveDiscovery({ clusterId: randomUUID(), nodeId: randomUUID(), incarnation: randomUUID(), token: "x".repeat(32),
    address: "127.0.0.1:0", bootstraps: ["127.0.0.1:1"], timeoutMs: 40 }), /UNAVAILABLE/);
});

test("untyped process configuration cannot turn a string initialization flag into a new ring", async () => {
  await assert.rejects(async () => {
    const service = await serveDiscovery({ clusterId: randomUUID(), nodeId: randomUUID(), incarnation: randomUUID(), token: "x".repeat(32),
      address: "127.0.0.1:0", initialize: "false" as unknown as boolean, bootstraps: ["127.0.0.1:1"] });
    await service.close();
  }, /BOOTSTRAP/);
});

test("transport serializes only public identity fields even when handed a configuration object", async () => {
  const config = { clusterId: randomUUID(), nodeId: randomUUID(), incarnation: randomUUID(), token: "private".repeat(8) };
  let fields: string[] = [];
  const remote = new ControlWire({ clusterId: config.clusterId, nodeId: randomUUID(), incarnation: randomUUID() });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const packet = JSON.parse(Buffer.concat(chunks).toString());
      fields = Object.keys(packet);
      response.end(JSON.stringify(remote.reply(packet, null)) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await discoveryTransport(config, config.token)(`127.0.0.1:${address.port}`, { operation: "status" }, AbortSignal.timeout(1000));
    assert.equal(fields.includes("token"), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("closing discovery drains an in-flight lookup before releasing its dependencies", async () => {
  const clusterId = randomUUID(), token = "x".repeat(32), identity = { clusterId, nodeId: randomUUID(), incarnation: randomUUID() };
  let entered!: () => void, pending = 0;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const blackhole = createServer((_request, response) => {
    pending++; response.once("close", () => { pending--; }); entered();
  });
  await new Promise<void>(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  const service = await serveDiscovery({ ...identity, address: "127.0.0.1:0", token, initialize: true });
  try {
    const nodeId = randomUUID();
    service.node.handle({ operation: "notify", peer: { nodeId, incarnation: randomUUID(), id: toHex(discoveryId(clusterId, "peer", nodeId)),
      address: `127.0.0.1:${(blackhole.address() as { port: number }).port}` } });
    const call = discoveryTransport({ ...identity, nodeId: randomUUID() }, token)(service.address,
      { operation: "lookup", namespace: "service", name: "helper" }, AbortSignal.timeout(2000)).catch(() => {});
    await arrived;
    await service.close();
    // The peer's socket-close notification can arrive on the next loop turn.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pending, 0);
    await call;
  } finally { await service.close(); blackhole.closeAllConnections(); await new Promise<void>(resolve => blackhole.close(() => resolve())); }
});
