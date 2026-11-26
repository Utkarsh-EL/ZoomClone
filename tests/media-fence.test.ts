import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ControlWire } from "../coordination/wire.ts";

// Import dynamically so the first RED run reports the missing production boundary.
test("kernel fences epochs, caller incarnation/order, provisioned meeting and exact owner", async () => {
  const { KernelFence } = await import("../media/kernel-fence.ts");
  const clusterId = randomUUID(), epoch = randomUUID(), meetingId = randomUUID();
  const identity = { clusterId, nodeId: randomUUID(), incarnation: randomUUID() }, wire = new ControlWire(identity);
  const fence = new KernelFence({ epoch, meetingId, callers: [identity] });
  const owner = { meetingId, generation: 1, runtimeId: identity.nodeId, incarnation: identity.incarnation, attemptId: randomUUID() };
  const request = (action: string, extra = {}) => wire.request({ action, epoch, owner, ...extra });
  assert.throws(() => fence.accept(request("open", { epoch: randomUUID() })), /SFU_RESTARTED/);
  assert.throws(() => fence.accept(request("sync", { owner: { ...owner, incarnation: randomUUID() } })), /FENCED/);
  assert.throws(() => fence.accept(request("sync", { owner: { ...owner, meetingId: randomUUID() } })), /FENCED/);
  const delayed = request("open"), cleanup = request("closePeer");
  fence.accept(cleanup);
  assert.throws(() => fence.accept(delayed), /STALE_MEDIA_CONTROL/);
  const unprovisioned = new ControlWire({ ...identity, incarnation: randomUUID() });
  assert.throws(() => fence.accept(unprovisioned.request({ action: "hello" })), /UNAUTHORIZED/);
});
