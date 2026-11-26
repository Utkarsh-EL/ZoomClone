import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createServer } from "node:http";

test("unreachable supervisor status never claims a clean stop or discards its lock", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-control-test-")), runId = randomUUID();
  await writeFile(join(root, "control.json"), JSON.stringify({ port: 1, token: "a".repeat(64), runId }));
  await writeFile(join(root, "supervisor.lock"), JSON.stringify({ pid: process.pid, runId }));
  const result = await promisify(execFile)(process.execPath, ["scripts/demo.ts", "status", "--json"], { windowsHide: true, env: { ...process.env, ZOOM_DEMO_ROOT: root } });
  const status = JSON.parse(result.stdout);
  assert.equal(status.phase, "unreachable"); assert.equal(status.ready, false);
  assert.ok(status.cleanupErrors.length > 0);
});

test("a shutdown reporting cleanup failures returns a failing CLI exit status", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "demo-stop-result-")), runId = randomUUID();
  const server = createServer((request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(request.url === "/status"
    ? { runId, phase: "running", ready: true } : { runId, phase: "stopped", cleanupErrors: ["participant drain unconfirmed"] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(join(root, "control.json"), JSON.stringify({ port: (server.address() as { port: number }).port, token: "b".repeat(64), runId }));
    await assert.rejects(promisify(execFile)(process.execPath, ["scripts/demo.ts", "stop", "--json"], { windowsHide: true, env: { ...process.env, ZOOM_DEMO_ROOT: root } }),
      (error: any) => error.code === 1 && JSON.parse(error.stdout).cleanupErrors[0] === "participant drain unconfirmed");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
