import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";

import { HelperClient, HelperUnavailableError, ProtocolError, RemoteError } from "../coordination/helper-client.ts";

const clusterId = "00000000-0000-4000-8000-000000000001";
const helperId = "00000000-0000-4000-8000-000000000002";
const token = "boundary-test-token-at-least-32-bytes";

test("helper client correlates replies, observes remote clocks and preserves command IDs", async (t) => {
  const received: Record<string, any>[] = [];
  let mutate = (reply: Record<string, any>): unknown => reply;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/control");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const packet = JSON.parse(Buffer.concat(chunks).toString());
    received.push(packet);
    const reply = mutate({ version: 1, clusterId, nodeId: helperId, incarnation: randomUUID(),
      requestId: packet.requestId, lamport: 80, kind: "control.reply", body: { code: "OK" } });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply) + "\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new HelperClient({ clusterId, nodeId: randomUUID(), helperId, token, address: `127.0.0.1:${address.port}` });
  const command = { id: randomUUID(), kind: "reserve" as const, meetingId: randomUUID(), code: "demo" };
  assert.deepEqual(await client.call("apply", { command }), { code: "OK" });
  assert.ok(client.logicalTime > 80);
  await client.forHelper(helperId, `127.0.0.1:${address.port}`).call("apply", { command });
  assert.equal(received[0].body.command.id, received[1].body.command.id);
  assert.notEqual(received[0].requestId, received[1].requestId);
  assert.ok(received[1].lamport > 80);
  assert.equal(received[0].version, 1);
  assert.equal(received[0].incarnation, received[1].incarnation);

  for (const field of ["clusterId", "nodeId", "requestId", "version", "lamport", "incarnation", "kind"]) {
    mutate = (reply) => { delete reply[field]; return reply; };
    await assert.rejects(client.call("status"), ProtocolError, `missing ${field} accepted`);
  }
  for (const change of [{ requestId: randomUUID() }, { nodeId: randomUUID() }, { clusterId: randomUUID() },
    { lamport: -1 }, { lamport: 1.1 }, { lamport: 0 }, { lamport: Number.MAX_SAFE_INTEGER + 1 },
    { lamport: Number.MAX_SAFE_INTEGER - 1 }, { kind: "raft.append.reply" }]) {
    mutate = (reply) => ({ ...reply, ...change });
    await assert.rejects(client.call("status"), ProtocolError, JSON.stringify(change));
  }
  mutate = (reply) => ({ ...reply, body: null, error: { code: "UNAVAILABLE", message: "not leader" } });
  await assert.rejects(client.call("read"), (error) => error instanceof RemoteError && error.code === "UNAVAILABLE");
});

test("helper client bounds chunked responses and marks transport failures uncertain", async (t) => {
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end("x".repeat(1024 * 1024 + 1)); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { clusterId, nodeId: randomUUID(), helperId, token, address: `127.0.0.1:${address.port}` };
  const client = new HelperClient(options);
  await assert.rejects(client.call("status"), /size|large|bound/i);
  await assert.rejects(client.call("apply", { command: { id: randomUUID(), kind: "reserve", meetingId: randomUUID(), code: "x".repeat(1024 * 1024) } }), /size|large|bound/i);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assert.rejects(client.call("status"), HelperUnavailableError);
  assert.throws(() => new HelperClient({ ...options, address: "example.com:80" }), /loopback/i);
  assert.throws(() => new HelperClient({ ...options, token: "" }), /token/i);
});
