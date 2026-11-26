import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { test } from "node:test";
import WebSocket from "ws";
import { SessionJournal } from "../client/session-journal.ts";
import { emptyState, evaluate as evaluateCommand } from "../storage/engine.ts";
import { ClientSession } from "../client/client-session.ts";
import { serveBrowserAttachment } from "../client/browser-attachment.ts";
import type { MeetingEvent } from "../storage/types.ts";
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
  const otherId = randomUUID(), shareId = randomUUID();
  const retainedState = { ...emptyState(), members: { [participantId]: { name: "Alice", joined: true }, [otherId]: { name: "Morgan " + "long-name".repeat(15), joined: true } },
    holder: { participantId: otherId, requestId: randomUUID() }, queue: [{ participantId, requestId: shareId }], grantVersion: 1 };
  const retainedEvents: MeetingEvent[] = Array.from({ length: 49 }, (_, i) => ({ seq: i + 1, lamport: i + 2, generation: 1, kind: "chat", payload: { participantId, content: i === 48 ? 'retained inbox <img src=x onerror="globalThis.injected=true"> ' + "long".repeat(100) : `retained inbox ${i + 1}` } }));
  retainedEvents[47] = { seq: 48, lamport: 49, generation: 1, kind: "share-changed", payload: { holder: retainedState.holder, queue: retainedState.queue, grantVersion: 1 } };
  journal.recordReplay(journal.cursor(), { meetingId: target.meetingId, code: "browser", generation: 1, runtimeId: randomUUID(),
    incarnation: randomUUID(), attemptId: randomUUID(), phase: "ACTIVE", observedAt: new Date().toISOString(), watermark: 49, scannedWatermark: 49,
    state: retainedState, events: retainedEvents });
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
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    await until("participant interface", async () => await evaluate(first, "document.querySelector('#chat-input') && ['reconnecting','authority unavailable'].includes(document.querySelector('#session-status')?.textContent)") ? true : undefined, 3000)
      .catch(async error => { throw new Error(`${error.message}: ${await evaluate(first, "document.body.innerText")}`); });
    assert.match(await evaluate(first, "document.querySelector('#history').textContent"), /retained inbox/);
    const initial = await evaluate(first, "attachment.view()");
    assert.equal(initial.view.participantId, participantId);
    assert.equal(initial.view.events[0].payload.content, "retained inbox 1");
    assert.equal(await evaluate(first, "document.querySelectorAll('#history li').length"), 16);
    assert.equal(await evaluate(first, "document.querySelectorAll('#history img').length"), 0);
    assert.equal(await evaluate(first, "globalThis.injected === true"), false);
    assert.match(await evaluate(first, "document.querySelector('#roster').textContent"), /Morgan/);
    assert.match(await evaluate(first, "document.querySelector('#share-status').textContent"), /#1/);
    await evaluate(first, "document.querySelector('#older').click()");
    await until("older UI history page", async () => await evaluate(first, "document.querySelector('#page-status').textContent.includes('18–33')") ? true : undefined, 2000);
    const cliPending = await cli("submit", { operation: { type: "chat", content: "CLI pending" } });
    await evaluate(first, "document.querySelector('#chat-input').value = 'browser pending'; document.querySelector('#chat-input').dispatchEvent(new Event('input')); document.querySelector('#chat-form').requestSubmit()");
    const browserPending = await until("UI submitted command", async () => {
      const view = await cli("view");
      return view.commands.find((c: any) => c.operation.content === "browser pending") as { id: string } | undefined;
    }, 3000);
    await until("pending ID rendered", async () => await evaluate(first, `document.querySelector('#commands').textContent.includes('${browserPending.id}')`) ? true : undefined, 2000);
    await evaluate(first, `(() => { const d=Array.from(document.querySelectorAll('#commands details')).find(d=>d.textContent.includes('${browserPending.id}')); d.open=true; d.querySelector('summary').focus(); })()`);
    const laterCli = await cli("submit", { operation: { type: "chat", content: "later CLI traffic" } });
    await until("new CLI command rendered", async () => await evaluate(first, `document.querySelector('#commands').textContent.includes('${laterCli.commandId}')`) ? true : undefined, 2000);
    assert.equal(await evaluate(first, `(() => { const d=Array.from(document.querySelectorAll('#commands details')).find(d=>d.textContent.includes('${browserPending.id}')); return d.open && d.contains(document.activeElement); })()`), true, "command review stays open and focused during other traffic");
    await evaluate(first, "document.querySelector('#capture-claim').click()");
    await until("UI capture owner", async () => await evaluate(first, "attachment.ownsCapture") ? true : undefined, 2000);
    const claim = { capture: await evaluate(first, "attachment.captureState") };
    const oldRevision = await evaluate(first, "attachment.attachment.revision");
    await cdp("Page.reload", {}, first);
    await until("new browser document", async () => {
      try { return await evaluate(first, `globalThis.attachment?.readyState === 'attached' && attachment.attachment.revision > ${oldRevision}`) ? true : undefined; } catch { return undefined; }
    }, 6000);
    const reloaded = await evaluate(first, "attachment.view()"), cliView = await cli("view");
    await until("history display position restored", async () => await evaluate(first, "document.querySelector('#page-status').textContent.includes('18–33')") ? true : undefined, 2000);
    await evaluate(first, "document.querySelector('#newer').click()");
    await until("newer UI history page", async () => await evaluate(first, "document.querySelector('#page-status').textContent.includes('34–49')") ? true : undefined, 2000);
    await evaluate(first, "document.querySelector('#latest').click()");
    await until("UI follows latest", async () => await evaluate(first, "document.querySelector('#page-status').textContent.includes('following latest')") ? true : undefined, 2000);
    assert.equal(await evaluate(first, "(() => { const h=document.querySelector('#history'); return h.scrollHeight - h.scrollTop - h.clientHeight < 2; })()"), true);
    assert.equal(reloaded.view.participantId, participantId);
    assert.deepEqual(reloaded.view.commands, cliView.commands);
    assert.deepEqual(reloaded.view.events, cliView.events.slice(0, 16));
    assert.equal(reloaded.view.cursor.subscriptionRevision, 0);
    for (const id of [cliPending.commandId, browserPending.id]) assert.ok(reloaded.view.commands.some((c: any) => c.id === id && c.outcome === null));
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
    await until("UI capture replacement notice", async () => await evaluate(first, "document.querySelector('#capture-status').textContent.includes('Another tab')") ? true : undefined, 2000);
    await evaluate(second, "document.querySelector('#capture-release').click()");
    await until("UI capture released", async () => await evaluate(first, "attachment.captureState.owner === null") ? true : undefined, 2000);
    // A queue cancellation must bind the original observed request, even offline.
    await evaluate(first, "document.querySelector('#share-release').click()");
    await until("UI original share release ID", async () => (await cli("view")).commands.some((c: any) => c.operation.type === "release-share" && c.operation.requestId === shareId) ? true : undefined, 2000);
    // Inspect both layouts in one round. These are synthetic retained observations.
    if (process.env.ZOOM_UI_EVIDENCE) {
      await mkdir(process.env.ZOOM_UI_EVIDENCE, { recursive: true });
      await cdp("Page.bringToFront", {}, first);
      for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
        await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, first);
        await evaluate(first, "window.scrollTo(0,0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        assert.equal(await evaluate(first, "document.documentElement.scrollWidth <= innerWidth"), true, `${name} must not overflow horizontally`);
        const metrics = await cdp("Page.getLayoutMetrics", {}, first);
        const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: metrics.cssContentSize.height, scale: 1 } }, first);
        await writeFile(join(process.env.ZOOM_UI_EVIDENCE, `${name}.png`), Buffer.from(shot.data, "base64"));
      }
    }
    await evaluate(first, "document.querySelector('#leave').click(); document.querySelector('#leave-cancel').click()");
    assert.equal((await cli("view")).commands.some((c: any) => c.operation.type === "leave"), false);
    await evaluate(first, "document.querySelector('#leave').click(); document.querySelector('#leave-submit').click()");
    await until("UI explicit leave pending", async () => await evaluate(first, "document.querySelector('#session-status').textContent === 'leave pending' && document.querySelector('#chat-input').disabled") ? true : undefined, 2000);
    // Shutting down the CLI closes the attachment without sending domain leave.
    child.stdin.end(); await exited;
    await until("browser observes agent shutdown", async () => await evaluate(second, "attachment.readyState === 'closed'") ? true : undefined, 2000);
    const reopened = SessionJournal.open(path, target);
    try { assert.equal(reopened.credential().participantId, participantId); assert.equal(reopened.pending().length, 6); assert.equal(reopened.pending().filter(c => c.operation.type === "leave").length, 1); assert.equal(reopened.left, false); }
    finally { reopened.close(); }
    // A deterministic engine transport exercises resolved UI actions. This is
    // browser/session evidence; real SQL/runtime fences have their own suite.
    const interactiveTarget = { clusterId: randomUUID(), meetingId: randomUUID(), name: "Taylor" };
    const interactiveJournal = SessionJournal.open(join(root, "interactive.sqlite"), interactiveTarget);
    let state = emptyState(); const events: MeetingEvent[] = [], outcomes = new Map();
    const runtime = { runtimeId: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID() };
    const interactiveSession = new ClientSession(interactiveJournal, async () => ({
      async execute(command) {
        if (outcomes.has(command.id)) return outcomes.get(command.id);
        if (command.operation.type.startsWith("group-")) throw new Error("GROUP_ACCESS_DENIED");
        const result = evaluateCommand(state, command.participantId, command.id, command.operation as import("../storage/engine.ts").MeetingOperation); state = result.state;
        if (result.event) events.push({ ...result.event, seq: events.length + 1, generation: 1, lamport: command.lamport + 1 });
        const outcome = { code: result.code, seq: events.length, generation: 1, grantVersion: state.grantVersion }; outcomes.set(command.id, outcome); return outcome;
      },
      async read(_credential, after, limit) {
        const page = events.filter(e => e.seq > after).slice(0, limit);
        return { ...runtime, meetingId: interactiveTarget.meetingId, code: "interactive", phase: "ACTIVE", generation: 1, observedAt: new Date().toISOString(), state: structuredClone(state), watermark: events.length, scannedWatermark: after + page.length, events: structuredClone(page) };
      }, async listGroups() { return { groups: [], nextAfter: null }; }, async readGroup() { throw new Error("GROUP_ACCESS_DENIED"); }, close() {},
    }));
    const controller = new AbortController();
    const running = interactiveSession.run(controller.signal, () => {}, 10);
    const interactiveServer = await serveBrowserAttachment(interactiveSession, { address: "127.0.0.1:0" });
    try {
      const active = await tab(interactiveServer.url); await ready(active);
      await until("resolved session UI", async () => await evaluate(active, "document.querySelector('#session-status').textContent === 'connected'") ? true : undefined, 2000);
      await evaluate(active, "document.querySelector('#share-request').click()");
      await until("UI share granted", async () => await evaluate(active, "document.querySelector('#share-status').textContent.includes('Taylor holds') && !document.querySelector('#share-release').disabled") ? true : undefined, 2000);
      const originalShare = state.holder!.requestId;
      await evaluate(active, "document.querySelector('#share-release').click()");
      await until("UI share released", async () => await evaluate(active, "!document.querySelector('#share-request').hidden && !document.querySelector('#share-request').disabled") ? true : undefined, 2000);
      assert.ok(interactiveJournal.view().commands.some(c => c.operation.type === "release-share" && c.operation.requestId === originalShare && c.outcome?.code === "OK"));
      await evaluate(active, "(() => { const submit=attachment.submit.bind(attachment); attachment.submit=async operation => { await submit(operation); throw new Error('INTERRUPTED_UI_REPLY'); }; document.querySelector('#chat-input').value='lost UI reply'; document.querySelector('#chat-form').requestSubmit(); })()");
      await until("uncertain UI submission", async () => await evaluate(active, "!document.querySelector('#uncertainty').hidden && document.querySelector('#chat-input').disabled") ? true : undefined, 2000);
      const uncertainId = interactiveJournal.view().commands.find(c => c.operation.type === "chat" && c.operation.content === "lost UI reply")!.id;
      const beforeReload = interactiveJournal.view().commands.map(c => c.id);
      const interactiveRevision = await evaluate(active, "attachment.attachment.revision");
      await cdp("Page.reload", {}, active);
      await until("uncertainty survives native reload", async () => {
        try { return await evaluate(active, `globalThis.attachment?.attachment?.revision > ${interactiveRevision} && !document.querySelector('#uncertainty').hidden && document.querySelector('#commands').textContent.includes('${uncertainId}')`) ? true : undefined; } catch { return undefined; }
      }, 3000);
      assert.deepEqual(interactiveJournal.view().commands.map(c => c.id), beforeReload);
      await evaluate(active, "document.querySelector('#reviewed').click()");
      await until("manual outcome review unlocks controls", async () => await evaluate(active, "!document.querySelector('#leave').disabled") ? true : undefined, 2000);
      await evaluate(active, "document.querySelector('#leave').click(); document.querySelector('#leave-submit').click()");
      await until("UI leave resolved", async () => await evaluate(active, "document.querySelector('#session-status').textContent === 'left'") ? true : undefined, 2000);
      assert.equal(interactiveJournal.left, true);
      assert.equal(await evaluate(active, "document.querySelector('#share-request').disabled && document.querySelector('#capture-claim').disabled"), true);
    } finally { controller.abort(); await running; await interactiveServer.close(); interactiveJournal.close(); }
    console.log(JSON.stringify({ browser: executable, checks: ["native UI controls", "history paging/reload", "CLI identity and pending IDs", "command review retains open state/focus during CLI traffic", "untrusted text", "capture replacement/release", "queued share cancellation", "resolved request/grant/release", "interrupted UI reply/reload/manual review without resubmit", "explicit pending/resolved leave", "shutdown", ...(process.env.ZOOM_UI_EVIDENCE ? ["desktop/mobile overflow and screenshots"] : [])], participantId }));
  } finally {
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL"); await browserExited;
    lines.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
