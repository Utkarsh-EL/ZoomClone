import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { test } from "node:test";
import WebSocket from "ws";
import { SessionJournal } from "../client/session-journal.ts";
import { emptyState } from "../storage/engine.ts";
import { until } from "../scripts/coordinator-lab.ts";

test("native browser reload and CLI retain one identity, pending IDs, inbox and fenced capture", { timeout: 40000 }, async () => {
  let executable = process.env.ZOOM_BROWSER_EXECUTABLE;
  for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]) {
    if (!executable) { try { await access(candidate); executable = candidate; } catch {} }
  }
  assert.ok(executable, "Set ZOOM_BROWSER_EXECUTABLE to a Chromium browser for npm run test:browser");
  const root = await mkdtemp(join(tmpdir(), "zoom-native-browser-"));
  const target = { clusterId: randomUUID(), meetingId: randomUUID(), name: "Alice" }, path = join(root, "session.sqlite");
  const journal = SessionJournal.open(path, target);
  const participantId = journal.credential().participantId;
  journal.recordReplay(journal.cursor(), { meetingId: target.meetingId, code: "browser", generation: 1, runtimeId: randomUUID(),
    incarnation: randomUUID(), attemptId: randomUUID(), phase: "ACTIVE", observedAt: new Date().toISOString(), watermark: 1, scannedWatermark: 1,
    state: emptyState(), events: [{ seq: 1, lamport: 2, generation: 1, kind: "chat", payload: { participantId, content: "retained inbox" } }] });
  journal.close();
  const config = { sessionPath: path, target, helpers: [{ helperId: randomUUID(), address: "127.0.0.1:1" }], helperToken: "h".repeat(64),
    helperTimeoutMs: 100, intervalMs: 30, routes: [{ runtimeId: randomUUID(), incarnation: randomUUID(), address: "127.0.0.1:1", token: "r".repeat(64) }],
    browser: { address: "127.0.0.1:0" } };
  const child = spawn(process.execPath, ["scripts/participant-agent.ts"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ZOOM_PARTICIPANT_CONFIG: JSON.stringify(config) } });
  const exited = once(child, "exit"), lines = createInterface({ input: child.stdout }), messages: any[] = [];
  let childError = ""; child.stderr.on("data", data => { childError = (childError + data).slice(-2000); });
  lines.on("line", line => { try { messages.push(JSON.parse(line)); } catch {} });
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(root, "profile")}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const browserExited = once(browser, "exit");
  let browserError = "", socket: WebSocket | undefined;
  browser.stderr.on("data", data => { browserError = (browserError + data).slice(-8000); });
  try {
    const started = await until("browser attachment startup", async () => {
      if (child.exitCode !== null) throw new Error(childError || JSON.stringify(messages));
      return messages.find(m => m.event === "participant.started");
    }, 5000);
    assert.ok(started.browser?.url, "participant.started must expose its private attachment URL");
    const endpoint = await until("Chromium DevTools", async () => {
      const logged = browserError.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (logged) return logged;
      const active = await readFile(join(root, "profile", "DevToolsActivePort"), "utf8").catch(() => "");
      const [port, path] = active.trim().split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
      if (browser.exitCode !== null) throw new Error(`Browser exited ${browser.exitCode}: ${browserError}`);
      return undefined;
    }, 10000).catch(error => { throw new Error(`${error.message}: ${browserError}`); });
    socket = new WebSocket(endpoint); await once(socket, "open");
    let nextId = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    socket.on("message", data => { const p = JSON.parse(data.toString()); const waiter = pending.get(p.id); if (!waiter) return; pending.delete(p.id); p.error ? waiter.reject(new Error(JSON.stringify(p.error))) : waiter.resolve(p.result); });
    const cdp = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    async function tab(url: string) {
      const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
      await cdp("Page.enable", {}, sessionId); await cdp("Page.navigate", { url }, sessionId);
      return sessionId as string;
    }
    async function evaluate(sessionId: string, expression: string) {
      const value = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value;
    }
    async function ready(sessionId: string) {
      return until("native attachment ready", async () => await evaluate(sessionId, "globalThis.attachment?.readyState === 'attached'") ? true : undefined, 6000);
    }
    async function cli(action: string, body: object = {}) {
      const id = randomUUID(); child.stdin.write(JSON.stringify({ id, action, ...body }) + "\n");
      return until("CLI reply", async () => messages.find(m => m.id === id)?.result, 2000);
    }
    const first = await tab(started.browser.url); await ready(first);
    const initial = await evaluate(first, "attachment.view()");
    assert.equal(initial.view.participantId, participantId);
    assert.equal(initial.view.events[0].payload.content, "retained inbox");
    const cliPending = await cli("submit", { operation: { type: "chat", content: "CLI pending" } });
    const browserPending = await evaluate(first, "attachment.submit({type:'chat',content:'browser pending'})");
    const claim = await evaluate(first, "attachment.claimCapture()");
    const oldRevision = await evaluate(first, "attachment.attachment.revision");
    await cdp("Page.reload", {}, first);
    await until("new browser document", async () => {
      try { return await evaluate(first, `globalThis.attachment?.readyState === 'attached' && attachment.attachment.revision > ${oldRevision}`) ? true : undefined; } catch { return undefined; }
    }, 6000);
    const reloaded = await evaluate(first, "attachment.view()"), cliView = await cli("view");
    assert.equal(reloaded.view.participantId, participantId);
    assert.deepEqual(reloaded.view.commands, cliView.commands);
    assert.deepEqual(reloaded.view.events, cliView.events);
    assert.equal(reloaded.view.cursor.subscriptionRevision, 0);
    for (const id of [cliPending.commandId, browserPending.commandId]) assert.ok(reloaded.view.commands.some((c: any) => c.id === id && c.outcome === null));
    assert.equal(reloaded.view.commands.filter((c: any) => c.operation.type === "join").length, 1);
    assert.equal(await evaluate(first, "location.hash"), "");
    assert.equal(reloaded.capture.owner, null);
    const newClaim = await evaluate(first, "attachment.claimCapture()");
    assert.ok(newClaim.capture.revision > claim.capture.revision);
    const second = await tab(started.browser.url); await ready(second);
    const replacement = await evaluate(second, "attachment.claimCapture()");
    await until("capture revoked on original browser", async () => await evaluate(first, `attachment.captureState.owner?.id === ${JSON.stringify(replacement.capture.owner.id)}`) ? true : undefined, 2000);
    assert.equal(await evaluate(first, "attachment.ownsCapture"), false);
    assert.equal(await evaluate(second, "attachment.ownsCapture"), true);
    // Shutting down the CLI closes the attachment without sending domain leave.
    child.stdin.end(); await exited;
    await until("browser observes agent shutdown", async () => await evaluate(second, "attachment.readyState === 'closed'") ? true : undefined, 2000);
    const reopened = SessionJournal.open(path, target);
    try { assert.equal(reopened.credential().participantId, participantId); assert.equal(reopened.pending().length, 3); assert.equal(reopened.left, false); }
    finally { reopened.close(); }
    console.log(JSON.stringify({ browser: executable, checks: ["native WebSocket", "reload", "CLI identity", "pending IDs", "durable inbox", "capture replacement", "shutdown"], participantId }));
  } finally {
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL"); await browserExited;
    lines.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
