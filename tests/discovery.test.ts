import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { discoveryId, fromHex, toHex, RING_SIZE } from "../coordination/discovery-id.ts";
import { DiscoveryNode, type DiscoveryTransport } from "../coordination/discovery.ts";

function network() {
  const clusterId = randomUUID();
  const nodes = new Map<string, DiscoveryNode>();
  let now = 1000;
  const transport: DiscoveryTransport = async (address, body) => {
    const node = nodes.get(address);
    if (!node) throw new Error("OFFLINE");
    return node.handle(structuredClone(body));
  };
  const add = () => {
    const node = new DiscoveryNode({ clusterId, nodeId: randomUUID(), incarnation: randomUUID(),
      address: `127.0.0.1:${20000 + nodes.size}`, transport, now: () => now });
    nodes.set(node.self.address, node); return node;
  };
  return { clusterId, nodes, add, advance: (ms: number) => { now += ms; } };
}

test("128-bit discovery IDs separate clusters and namespaces and require canonical wire hex", () => {
  const cluster = randomUUID();
  const ids = [discoveryId(cluster, "peer", "x"), discoveryId(cluster, "meeting", "x"),
    discoveryId(cluster, "service", "x"), discoveryId(randomUUID(), "peer", "x")];
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) { assert.ok(id >= 0n && id < RING_SIZE); assert.equal(fromHex(toHex(id)), id); assert.equal(toHex(id).length, 32); }
  for (const value of ["1", "0x" + "0".repeat(32), "F".repeat(32), 1, null]) assert.throws(() => fromHex(value));
});

test("joined peers route with fingers, survive two successor failures and expire replicated hints", async () => {
  const f = network(), first = f.add(); first.initialize();
  for (let i = 1; i < 12; i++) { const node = f.add(); await node.join(["127.0.0.1:1", first.self.address]); }
  const all = [...f.nodes.values()];
  for (let round = 0; round < 14; round++) for (const node of all) await node.maintain(0);
  for (const node of all) await node.maintain(128);
  const sorted = all.toSorted((a, b) => a.self.id < b.self.id ? -1 : 1);
  const origin = sorted[0], target = sorted[7];
  const route = await origin.locate(target.self.id);
  assert.equal(route.peer.nodeId, target.self.nodeId);
  assert.ok(route.path.length < 7, `finger shortcut path: ${route.path.length}`);
  assert.equal(origin.fingers.length, 128);
  assert.equal(origin.predecessor?.nodeId, sorted.at(-1)!.self.nodeId);
  const hint = { generation: 4, expiresAt: 5000, value: { runtimeId: randomUUID(), phase: "READY" } };
  await origin.publish("meeting", "meeting-code", hint);
  assert.deepEqual((await sorted[5].lookup("meeting", "meeting-code")), hint);
  f.nodes.delete(sorted[1].self.address); f.nodes.delete(sorted[2].self.address);
  assert.equal((await origin.locate(sorted[3].self.id)).peer.nodeId, sorted[3].self.nodeId);
  f.advance(5000);
  assert.equal(await origin.lookup("meeting", "meeting-code"), null);
});

test("bootstrap failure never initializes a new ring and bounded lookups reject a stalled transport", async () => {
  const f = network(), node = f.add();
  await assert.rejects(node.join(["127.0.0.1:1", "127.0.0.1:2"]), /UNAVAILABLE/);
  await assert.rejects(node.locate(1n), /NOT_JOINED/);
  const stalled = new DiscoveryNode({ clusterId: f.clusterId, nodeId: randomUUID(), incarnation: randomUUID(),
    address: "127.0.0.1:30000", transport: async () => new Promise(() => {}), timeoutMs: 30 });
  const started = performance.now();
  await assert.rejects(stalled.join(["127.0.0.1:1"]), /UNAVAILABLE/);
  assert.ok(performance.now() - started < 1000);
});

test("discovery validates reference hashes, namespaces, bounds and immutable hint generations", async () => {
  const f = network(), node = f.add(); node.initialize();
  assert.throws(() => node.handle({ operation: "notify", peer: { id: "0".repeat(32), nodeId: randomUUID(), incarnation: randomUUID(), address: "127.0.0.1:1" } }));
  assert.throws(() => node.handle({ operation: "route", key: 12 }));
  assert.throws(() => node.handle({ operation: "grant-ownership" }));
  const hint = { generation: 2, expiresAt: 2000, value: { address: "127.0.0.1:1234" } };
  await node.publish("service", "helper", hint);
  await assert.rejects(node.publish("service", "helper", { ...hint, value: { address: "127.0.0.1:9876" } }), /CONFLICT/);
  await node.publish("service", "helper", { ...hint, generation: 1 });
  assert.deepEqual(await node.lookup("service", "helper"), hint);
  await assert.rejects(node.publish("service", "helper", { ...hint, expiresAt: 9999999 }), /HINT/);
});

test("a stalled bootstrap leaves time to reach another bootstrap", async () => {
  const f = network(), first = f.add(); first.initialize();
  const node = new DiscoveryNode({ clusterId: f.clusterId, nodeId: randomUUID(), incarnation: randomUUID(),
    address: "127.0.0.1:31000", timeoutMs: 200, transport: async (address, body) => {
      if (address === "127.0.0.1:1") return new Promise(() => {});
      return first.handle(body);
    } });
  await node.join(["127.0.0.1:1", first.self.address]);
  assert.equal((await node.locate(first.self.id)).peer.nodeId, first.self.nodeId);
});

test("lookup finds replicated hints after their ring owner crashes", async () => {
  const f = network(), first = f.add(); first.initialize();
  for (let i = 1; i < 6; i++) await f.add().join([first.self.address]);
  const all = [...f.nodes.values()];
  for (let round = 0; round < 8; round++) for (const node of all) await node.maintain(0);
  const key = discoveryId(f.clusterId, "service", "coordinator"), owner = (await first.locate(key)).peer;
  const writer = all.find(node => node.self.nodeId !== owner.nodeId)!;
  const hint = { generation: 7, expiresAt: 5000, value: { address: "127.0.0.1:40000" } };
  await writer.publish("service", "coordinator", hint);
  f.nodes.delete(owner.address);
  for (let round = 0; round < 3; round++) for (const node of f.nodes.values()) await node.maintain(0);
  assert.deepEqual(await writer.lookup("service", "coordinator"), hint);
});

test("partitioned peers refuse singleton routing and rediscover the ring after healing", async () => {
  const f = network(), first = f.add(); first.initialize();
  const second = f.add(); await second.join([first.self.address]);
  await first.maintain(0); await second.maintain(0);
  f.nodes.delete(second.self.address);
  await first.maintain(0);
  await assert.rejects(first.locate(second.self.id), /UNAVAILABLE/);
  f.nodes.set(second.self.address, second);
  for (let i = 0; i < 3; i++) { await first.maintain(0); await second.maintain(0); }
  assert.equal((await first.locate(second.self.id)).peer.nodeId, second.self.nodeId);
});

test("both isolated peers rebuild topology after healing without requiring existing routes", async () => {
  const f = network(), first = f.add(); first.initialize();
  const second = f.add(); await second.join([first.self.address]);
  await first.maintain(0); await second.maintain(0);
  f.nodes.clear();
  await first.maintain(0); await second.maintain(0);
  f.nodes.set(first.self.address, first); f.nodes.set(second.self.address, second);
  for (let i = 0; i < 4; i++) { await first.maintain(0); await second.maintain(0); }
  assert.equal((await first.locate(second.self.id)).peer.nodeId, second.self.nodeId);
  assert.equal((await second.locate(first.self.id)).peer.nodeId, first.self.nodeId);
});

test("a delayed refresh cannot shorten the lifetime of the same hint generation", async () => {
  const f = network(), node = f.add(); node.initialize();
  const hint = { generation: 1, expiresAt: 5000, value: { address: "127.0.0.1:40000" } };
  await node.publish("service", "helper", hint);
  await node.publish("service", "helper", { ...hint, expiresAt: 3000 });
  f.advance(2500);
  assert.deepEqual(await node.lookup("service", "helper"), hint);
});

test("surviving subrings merge after a partition heals", async () => {
  const f = network(), first = f.add(); first.initialize();
  for (let i = 1; i < 12; i++) await f.add().join([first.self.address]);
  const all = [...f.nodes.values()].toSorted((a, b) => a.self.id < b.self.id ? -1 : 1);
  for (let round = 0; round < 14; round++) for (const node of all) await node.maintain(0);
  for (const group of [all.slice(0, 6), all.slice(6)]) {
    f.nodes.clear(); group.forEach(node => f.nodes.set(node.self.address, node));
    for (let round = 0; round < 15; round++) for (const node of group) await node.maintain(16);
  }
  f.nodes.clear(); all.forEach(node => f.nodes.set(node.self.address, node));
  for (let round = 0; round < 30; round++) for (const node of all) await node.maintain(16);
  assert.equal((await all[0].locate(all[8].self.id)).peer.nodeId, all[8].self.nodeId);
  assert.equal((await all[8].locate(all[0].self.id)).peer.nodeId, all[0].self.nodeId);
});

test("a cyclic or excessively long routing path terminates within the hop bound", async () => {
  const clusterId = randomUUID();
  const peers = Array.from({ length: 70 }, (_, index) => {
    const nodeId = randomUUID();
    return { nodeId, incarnation: randomUUID(), address: `127.0.0.1:${32000 + index}`, id: toHex(discoveryId(clusterId, "peer", nodeId)) };
  });
  let calls = 0;
  const node = new DiscoveryNode({ clusterId, nodeId: randomUUID(), incarnation: randomUUID(), address: "127.0.0.1:31999",
    transport: async (address, body) => {
      const index = peers.findIndex(peer => peer.address === address), peer = peers[index]; calls++;
      return (body as { operation: string }).operation === "status"
        ? { self: peer, predecessor: null, successors: [] } : { owner: null, candidates: [peers[(index + 1) % peers.length]] };
    } });
  node.initialize(); node.handle({ operation: "notify", peer: peers[0] });
  // Target outside the local successor interval forces traversal of the path.
  const key = (node.self.id + RING_SIZE - 1n) % RING_SIZE;
  await assert.rejects(node.locate(key), /UNAVAILABLE/);
  assert.ok(calls <= 34, `routing exceeded hop bound: ${calls}`);
});

test("lookup skips a crashed hint owner even while other peers still advertise its stale successor", async () => {
  const f = network(), first = f.add(); first.initialize();
  for (let i = 1; i < 6; i++) await f.add().join([first.self.address]);
  const all = [...f.nodes.values()].toSorted((a, b) => a.self.id < b.self.id ? -1 : 1);
  for (let round = 0; round < 8; round++) for (const node of all) await node.maintain(0);
  const name = "service", key = discoveryId(f.clusterId, "service", name);
  const ownerIndex = Math.max(0, all.findIndex(node => node.self.id >= key));
  const writer = all[(ownerIndex + all.length - 2) % all.length];
  const hint = { generation: 1, expiresAt: 5000, value: { retained: true } };
  await writer.publish("service", name, hint);
  f.nodes.delete(all[ownerIndex].self.address);
  assert.deepEqual(await writer.lookup("service", name), hint);
});
