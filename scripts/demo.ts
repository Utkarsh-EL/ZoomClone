import { spawn, execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { demoRoot, readJSON, secret, writeJSON } from "./demo-state.ts";
import { DemoStack } from "./demo-stack.ts";
import { demoRequest } from "./demo-control.ts";
import { projectRoot } from "./coordinator-build.ts";
import { setTimeout as delay } from "node:timers/promises";
import { claimDemoLock, releaseDemoOwnership } from "./demo-lock.ts";

async function serve(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runId = randomUUID(), lockPath = join(root, "supervisor.lock");
  await claimDemoLock(lockPath, { runId, pid: process.pid });
  const stack = new DemoStack(root, runId), token = secret(), expected = Buffer.from(`Bearer ${token}`);
  let stopping: Promise<any> | undefined, start: Promise<void> = Promise.resolve(), mutation = Promise.resolve();
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? ""), host = `127.0.0.1:${(server.address() as { port: number }).port}`;
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json"); response.setHeader("Connection", "close");
    if (request.headers.host !== host || request.headers.origin !== undefined || request.headers["x-demo-run"] !== runId
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(JSON.stringify({ error: "UNAUTHORIZED" })); return; }
    if ((request.method !== "GET" || request.url !== "/status") && request.method !== "POST") { response.writeHead(405).end('{}'); return; }
    if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) { response.writeHead(400).end('{}'); return; }
    const reply = (status: number, body: object) => response.writeHead(status).end(JSON.stringify({ ...body, runId }));
    if (request.method === "GET") { void stack.status().then(status => reply(200, status), () => reply(503, { error: "STATUS_UNAVAILABLE" })); return; }
    if (request.url === "/stop") {
      void stop().then(result => { if (!result.cleanupErrors.length) response.once("finish", () => { server.closeAllConnections(); server.close(); }); reply(200, result); }, () => reply(500, { error: "STOP_FAILED_SEE_LOG" })); return;
    }
    const route = request.url ?? "";
    const work = mutation.then(async () => {
      if (stopping || stack.phase !== "running") throw new Error("DEMO_NOT_RUNNING");
      if (route === "/fail-runtime") return stack.failRuntime();
      const crash = /^\/fail-participant\/(Alice|Bob|Charlie|Outsider)$/.exec(route);
      if (crash) return stack.failParticipant(crash[1]);
      const match = /^\/(restart-participant|new-participant)\/(Alice|Bob|Charlie|Outsider)$/.exec(route);
      if (match) return stack.restartParticipant(match[2], match[1] === "new-participant");
      throw new Error("UNKNOWN_DEMO_ACTION");
    });
    mutation = work.then(() => {}, () => {});
    void work.then(result => reply(200, result), error => reply(400, { error: error.message }));
  });
  server.maxConnections = 16; server.headersTimeout = 5000; server.requestTimeout = 100000;
  server.on("connection", socket => { socket.setTimeout(190000, () => socket.destroy()); socket.on("error", () => {}); });
  async function stop() {
    return stopping ??= (async () => {
      stack.cancel(); await start.catch(() => {}); await mutation;
      const cleanupErrors = await stack.stop();
      const released = await releaseDemoOwnership(root, runId, cleanupErrors);
      return { phase: released ? "stopped" : "cleanup-incomplete", runId, cleanupErrors };
    })();
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  await writeJSON(join(root, "control.json"), { port: (server.address() as { port: number }).port, token, runId });
  start = stack.start();
  void start.catch(async error => {
    console.error(JSON.stringify({ event: "demo.startup-failed", message: error.message }));
    await stack.stop(); stack.phase = "failed";
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop().finally(() => { server.closeAllConnections(); server.close(); }); });
}
function openPages(status: any) {
  for (const p of status.participants ?? []) {
    if (p.left || !p.url) continue;
    const url = new URL(p.url); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("INVALID_PARTICIPANT_PAGE");
    const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [...(process.platform === "win32" ? ["url.dll,FileProtocolHandler"] : []), url.href], { windowsHide: true, detached: true, stdio: "ignore" });
    child.on("error", () => {}); child.unref();
  }
}
async function main() {
  const root = demoRoot(), args = process.argv.slice(2), action = args[0] ?? "status", positional = args.slice(1).filter(a => !a.startsWith("--"));
  if (args.some(a => a.startsWith("--") && !["--json", "--no-open"].includes(a))) throw new Error("UNKNOWN_DEMO_OPTION");
  if (action === "serve") { await serve(root); return; }
  let status: any, controlFailure: string | undefined;
  try { status = await demoRequest(root); } catch (error) { status = undefined; controlFailure = error instanceof Error ? error.message : "CONTROL_UNAVAILABLE"; }
  const lock = await readJSON(join(root, "supervisor.lock"));
  if (action === "start") {
    if (!status) {
      if (lock) {
        throw new Error("DEMO_LOCK_EXISTS_OWNERSHIP_RECOVERY_REQUIRED_SEE_SUPERVISOR_LOG");
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      // Rebuild current executables/assets before starting any durable process.
      for (const script of ["scripts/coordinator-build.ts", "scripts/media-build.ts"]) execFileSync(process.execPath, [script], { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      const log = await open(join(root, "supervisor.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, ["scripts/demo.ts", "serve"], { cwd: projectRoot, windowsHide: true, detached: true,
          env: { ...process.env, ZOOM_DEMO_ROOT: root }, stdio: ["ignore", log.fd, log.fd] });
        child.on("error", () => {}); child.unref();
      } finally { await log.close(); }
    }
    const deadline = performance.now() + 300000;
    while (performance.now() < deadline) {
      const current = await demoRequest(root).catch(() => undefined);
      if (current?.phase === "failed" || current?.phase === "cleanup-incomplete") {
        await demoRequest(root, "stop").catch(() => {});
        throw new Error((current.startupError ?? "DEMO_STARTUP_FAILED") + "; see " + join(root, "supervisor.log"));
      }
      if (current?.ready) { status = current; break; }
      await delay(300);
    }
    if (!status?.ready) throw new Error("DEMO_START_TIMEOUT_SEE_SUPERVISOR_LOG: " + root);
    if (!args.includes("--no-open")) openPages(status);
  } else if (action === "status") {
    if (!status) status = lock || controlFailure ? { phase: "unreachable", ready: false, root, cleanupErrors: ["Supervisor control unavailable; shutdown is unconfirmed. Inspect supervisor.log. " + (controlFailure ?? "")] }
      : { ...(await readJSON(join(root, "last-stop.json")) ?? {}), phase: "stopped", ready: false, root };
  }
  else if (action === "stop") {
    if (!status && (lock || controlFailure)) throw new Error("DEMO_UNREACHABLE_SHUTDOWN_UNCONFIRMED_SEE_SUPERVISOR_LOG");
    status = status ? await demoRequest(root, "stop") : { ...(await readJSON(join(root, "last-stop.json")) ?? {}), phase: "stopped", root };
  }
  else if (action === "open") { if (!status) throw new Error("DEMO_NOT_RUNNING"); openPages(status); }
  else if (action === "fail-runtime") { if (!status) throw new Error("DEMO_NOT_RUNNING"); status = await demoRequest(root, "fail-runtime"); }
  else if (["restart-participant", "new-participant", "fail-participant"].includes(action) && positional.length === 1) {
    if (!status) throw new Error("DEMO_NOT_RUNNING"); status = await demoRequest(root, `${action}/${positional[0]}`);
    if (!args.includes("--no-open")) openPages({ participants: status.participants.filter((p: any) => p.name === positional[0]) });
  } else throw new Error("Usage: demo.ts start|status|stop|open|fail-runtime|restart-participant <Name>|new-participant <Name> [--json] [--no-open]");
  if (args.includes("--json")) console.log(JSON.stringify(status));
  else {
    console.log(`Demo ${status.phase}${status.ready ? " · ready" : ""}. State: ${root}`);
    if (status.generation) console.log(`Meeting assignment generation ${status.generation}. Helpers ${status.helpers}/3 · discovery ${status.discoveryPeers}/4 · runtimes ${status.runtimes}/2 · media ${status.media}.`);
    for (const p of status.participants ?? []) console.log(`${p.name}: ${p.connection}${p.left ? " · use new-participant to return with a new identity" : ""}${p.url && !p.left ? " · " + p.url : ""}`);
    for (const error of status.cleanupErrors ?? []) console.log("Cleanup incomplete: " + error);
    if (status.startupError) console.log("Startup failed: " + status.startupError);
  }
  if (action === "stop" && status.cleanupErrors?.length) process.exitCode = 1;
}
try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : "DEMO_FAILED"); process.exitCode = 1; }
