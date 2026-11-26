import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DemoChild } from "../scripts/demo-child.ts";

test("cleanup reports a crashed child while explicit recovery can acknowledge it and reuse its durable state", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-child-test-"));
  const child = new DemoChild(process.execPath, ["-e", "process.exit(3)"], {}, join(root, "child.log"));
  await child.closed;
  await assert.rejects(child.stop(), /CHILD_EXITED_UNEXPECTEDLY/);
  assert.equal(await (child.stop as any)(true, true), false);
});
