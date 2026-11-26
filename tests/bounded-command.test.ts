import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { boundedCommand } from "../scripts/bounded-command.ts";
import { until } from "../scripts/coordinator-lab.ts";

test("supervisor external commands leave its event loop responsive and abort their exact child", async () => {
  const root = await mkdtemp(join(process.cwd(), ".local", "bounded-command-")), path = join(root, "pid.txt"), abort = new AbortController();
  const pending = boundedCommand(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", path], { timeoutMs: 10000, signal: abort.signal });
  const rejected = assert.rejects(pending, /COMMAND_ABORTED/);
  const pid = await until("child alive without blocking supervisor", async () => { try { return Number(await readFile(path, "utf8")); } catch { return undefined; } }, 2000);
  process.kill(pid, 0); abort.abort(); await rejected;
  await until("aborted exact child terminated", async () => { try { process.kill(pid, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }, 2000);
});
test("supervisor command deadlines terminate stalled work and retain a bounded failure", async () => {
  await assert.rejects(boundedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }), /COMMAND_TIMEOUT/);
});
