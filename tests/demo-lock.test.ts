import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { claimDemoLock, releaseDemoOwnership } from "../scripts/demo-lock.ts";

test("one supervisor wins a fresh lock and simultaneous contenders cannot replace it", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-lock-test-")), path = join(root, "supervisor.lock");
  const a = { runId: randomUUID(), pid: process.pid }, b = { runId: randomUUID(), pid: process.pid };
  const results = await Promise.allSettled([claimDemoLock(path, a), claimDemoLock(path, b)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const owner = JSON.parse(await readFile(path, "utf8"));
  assert.ok([a.runId, b.runId].includes(owner.runId));
  await assert.rejects(claimDemoLock(path, { ...a, runId: randomUUID() }), /DEMO_LOCK/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), owner);
});
test("failed cleanup retains ownership records so another supervisor cannot reuse uncertain resources", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-release-test-")), runId = randomUUID();
  await claimDemoLock(join(root, "supervisor.lock"), { runId, pid: process.pid });
  await writeFile(join(root, "control.json"), JSON.stringify({ runId, port: 1, token: "a".repeat(64) }));
  const before = await readFile(join(root, "supervisor.lock"), "utf8");
  assert.equal(await releaseDemoOwnership(root, runId, ["child termination unconfirmed"]), false);
  assert.equal(await readFile(join(root, "supervisor.lock"), "utf8"), before);
  await assert.rejects(claimDemoLock(join(root, "supervisor.lock"), { runId: randomUUID(), pid: process.pid }), /DEMO_LOCK/);
  assert.equal(await releaseDemoOwnership(root, runId, []), true);
});
test("a stale or malformed lock is refused without an automatic unlink/reclaim race", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-stale-test-")), path = join(root, "supervisor.lock");
  for (const bytes of [JSON.stringify({ runId: randomUUID(), pid: 2147483647 }), "broken lock"] ) {
    await writeFile(path, bytes);
    await assert.rejects(claimDemoLock(path, { runId: randomUUID(), pid: process.pid }), /DEMO_LOCK/);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});
