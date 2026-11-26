import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { serveDiscovery } from "../coordination/discovery-rpc.ts";
import { DiscoveryClient } from "../coordination/discovery-client.ts";
import { DiscoveredHelpers } from "../coordination/discovered-helpers.ts";
import { ControlWire } from "../coordination/wire.ts";

test("new backend reads helpers discovered through either bootstrap and never retries uncertain writes", async () => {
  const clusterId = randomUUID(), identity = { clusterId, nodeId: randomUUID(), incarnation: randomUUID() }, token = "x".repeat(32);
  const helperId = randomUUID(), helperWire = new ControlWire({ clusterId, nodeId: helperId, incarnation: randomUUID() });
  let writes = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const packet = helperWire.accept(JSON.parse(Buffer.concat(chunks).toString()));
      if ((packet.body as { operation: string }).operation === "apply") { writes++; response.destroy(); return; }
      response.end(JSON.stringify(helperWire.reply(packet, { cluster: clusterId, meetings: {}, runtimes: {}, version: 3, highWater: 0 })) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const helperAddress = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const first = await serveDiscovery({ ...identity, nodeId: randomUUID(), token, address: "127.0.0.1:0", initialize: true });
  const second = await serveDiscovery({ ...identity, nodeId: randomUUID(), token, address: "127.0.0.1:0", bootstraps: [first.address] });
  try {
    for (let i = 0; i < 3; i++) { await first.node.maintain(0); await second.node.maintain(0); }
    await first.node.publish("service", "coordinators", { generation: 1, expiresAt: Date.now() + 30000,
      value: { helpers: [{ helperId, address: helperAddress }] } });
    const shared = new ControlWire(identity);
    const advanced = shared.request(null); advanced.lamport = 100;
    shared.accept(advanced);
    const before = shared.logicalTime;
    const discovery = new DiscoveryClient({ identity, token, bootstraps: ["127.0.0.1:1", second.address] }, shared);
    let discoveryReads = 0;
    const helper = new DiscoveredHelpers({ identity, token, discovery: { async lookup(namespace, name) {
      discoveryReads++;
      return discovery.lookup(namespace, name);
    } } });
    assert.equal((await helper.call<{ cluster: string }>("read")).cluster, clusterId);
    assert.ok(shared.logicalTime > before, "discovery participates in the process Lamport clock");
    assert.equal(discoveryReads, 1, "healthy barrier reads must not wait for discovery again");
    await assert.rejects(helper.call("apply", { command: { id: randomUUID(), kind: "reserve", meetingId: randomUUID(), code: "demo" } }), /unknown|unavailable/i);
    assert.equal(writes, 1);
    await first.close(); await second.close();
    // Retained authenticated helper routes can still perform barrier reads.
    assert.equal((await helper.call<{ cluster: string }>("read")).cluster, clusterId);
    assert.equal(discoveryReads, 1, "healthy barrier reads must not wait for discovery again");
  } finally { await first.close(); await second.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("two stalled bootstraps cannot starve a reachable third bootstrap", async () => {
  const identity = { clusterId: randomUUID(), nodeId: randomUUID(), incarnation: randomUUID() }, token = "x".repeat(32);
  const blackholes = [createServer(() => {}), createServer(() => {})];
  for (const server of blackholes) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const healthy = await serveDiscovery({ ...identity, address: "127.0.0.1:0", token, initialize: true });
  try {
    const hint = { generation: 1, expiresAt: Date.now() + 10000, value: { reachable: true } };
    await healthy.node.publish("service", "test", hint);
    const client = new DiscoveryClient({ identity, token, timeoutMs: 400,
      bootstraps: [...blackholes.map(server => `127.0.0.1:${(server.address() as { port: number }).port}`), healthy.address] });
    assert.deepEqual(await client.lookup("service", "test"), hint);
    assert.deepEqual(await client.lookup("service", "test"), hint);
  } finally {
    await healthy.close();
    for (const server of blackholes) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
