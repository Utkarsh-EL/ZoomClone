import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { until } from "../../scripts/coordinator-lab.ts";

export async function nativeBrowser(root: string, extra: string[] = []) {
  let executable = process.env.ZOOM_BROWSER_EXECUTABLE;
  for (const path of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"])
    if (!executable) { try { await access(path); executable = path; } catch {} }
  if (!executable) throw new Error("ZOOM_BROWSER_EXECUTABLE_REQUIRED");
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${root}`,
    "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", ...extra, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(browser, "exit"); let stderr = "";
  browser.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
  let socket: WebSocket;
  try {
    const endpoint = await until("media browser DevTools", async () => {
      const logged = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]; if (logged) return logged;
      const [port, path] = (await readFile(join(root, "DevToolsActivePort"), "utf8").catch(() => "")).trim().split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
      if (browser.exitCode !== null) throw new Error(stderr); return undefined;
    }, 10000);
    socket = new WebSocket(endpoint); await once(socket, "open");
  } catch (error) { browser.kill(); await exited; throw error; }
  let sequence = 0;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  socket.on("message", data => { const packet = JSON.parse(data.toString()), waiter = pending.get(packet.id); if (!waiter) return; pending.delete(packet.id); packet.error ? waiter.reject(new Error(JSON.stringify(packet.error))) : waiter.resolve(packet.result); });
  const cdp = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP_TIMEOUT: ${method}`)); }, 15000);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  async function evaluate(sessionId: string, expression: string) {
    const reply = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails)); return reply.result.value;
  }
  return { cdp, evaluate, async tab(url: string) {
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Page.enable", {}, sessionId); await cdp("Page.navigate", { url }, sessionId);
    return { targetId, sessionId, eval: (expression: string) => evaluate(sessionId, expression) };
  }, async close() { socket.close(); browser.kill(); await exited; } };
}
