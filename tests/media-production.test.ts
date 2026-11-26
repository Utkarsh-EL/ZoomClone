import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("local media serialization fences late publication and drains cleanup across route changes", async () => {
  const { LocalMediaBridge } = await import("../client/local-media.ts");
  let lease = true, release!: () => void, route = "old";
  const effects: string[] = [];
  const bridge = new LocalMediaBridge(async (_id, request) => {
    effects.push(`${route}:${request.action}`);
    if (request.action === "produce") await new Promise<void>(resolve => { release = resolve; });
    return {};
  });
  const publishing = bridge.handle("tab", { action: "produce" }, () => lease);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  lease = false; const cleanup = bridge.revoke("tab"); route = "new";
  const stale = bridge.handle("tab", { action: "produce" }, () => false);
  release(); await publishing; await cleanup; await assert.rejects(stale, /NOT_CAPTURE_OWNER/);
  assert.deepEqual(effects, ["old:produce", "new:closePeer"]);
  await bridge.close();
  await assert.rejects(bridge.handle("tab", { action: "open" }, () => true), /MEDIA_CLOSED/);
});

test("failed local cleanup blocks successor publication until confirmed cleanup", async () => {
  const { LocalMediaBridge } = await import("../client/local-media.ts");
  let available = true, published = 0;
  const bridge = new LocalMediaBridge(async (_id, request) => {
    if (!available) throw new Error("AUTHORITY_UNAVAILABLE");
    if (request.action === "produce") published++;
    return {};
  });
  await bridge.handle("old", { action: "open" }, () => true); available = false;
  await assert.rejects(bridge.revoke("old"), /AUTHORITY_UNAVAILABLE/);
  await assert.rejects(bridge.handle("new", { action: "produce" }, () => true), /AUTHORITY_UNAVAILABLE/);
  assert.equal(published, 0); available = true;
  await bridge.handle("new", { action: "produce" }, () => true); assert.equal(published, 1); await bridge.close();
});

test("dirty cleanup recovery preserves a peer with an intervening queued reopen", async () => {
  const { LocalMediaBridge } = await import("../client/local-media.ts");
  const live = new Set<string>(); let available = true, release!: () => void, pause = false;
  const bridge = new LocalMediaBridge(async (id, request) => {
    if (!available) throw new Error("AUTHORITY_UNAVAILABLE");
    if (request.action === "open") live.add(id);
    if (request.action === "closePeer") {
      if (id === "old" && pause) { pause = false; await new Promise<void>(resolve => { release = resolve; }); }
      live.delete(id);
    }
    return {};
  });
  await bridge.handle("old", { action: "open" }, () => true); available = false;
  await assert.rejects(bridge.revoke("old"), /AUTHORITY_UNAVAILABLE/); available = true; pause = true;
  const next = bridge.handle("new", { action: "open" }, () => true);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const reopen = bridge.handle("old", { action: "open" }, () => true);
  release(); await next; await reopen;
  await bridge.revoke("old"); await bridge.close(); assert.deepEqual([...live], []);
});

test("shutdown retries only certified pre-effect readiness rejection before confirming cleanup", async () => {
  const { LocalMediaBridge } = await import("../client/local-media.ts"); let live = false, cleanup = 0;
  const bridge = new LocalMediaBridge(async (_id, request) => {
    if (request.action === "open") live = true;
    if (request.action === "closePeer") { if (++cleanup === 1) throw new Error("NOT_READY"); live = false; }
    return {};
  });
  await bridge.handle("tab", { action: "open" }, () => true);
  await bridge.close(); assert.equal(live, false); assert.equal(cleanup, 2);
});

test("a full set of failed revocations can drain before admitting a new attachment", async () => {
  const { LocalMediaBridge } = await import("../client/local-media.ts"); let available = true;
  const live = new Set<string>();
  const bridge = new LocalMediaBridge(async (id, request) => {
    if (!available) throw new Error("SFU_UNAVAILABLE");
    if (request.action === "open") live.add(id);
    if (request.action === "closePeer") live.delete(id);
    return {};
  });
  for (let i = 0; i < 8; i++) await bridge.handle(String(i), { action: "open" }, () => true);
  available = false;
  await Promise.all(Array.from({ length: 8 }, (_, i) => assert.rejects(bridge.revoke(String(i)), /SFU_UNAVAILABLE/)));
  available = true; await bridge.handle("new", { action: "open" }, () => true);
  assert.deepEqual([...live], ["new"]); await bridge.close();
});

test("persistent effect observations bound retained entries and exclude signaling and secrets", async () => {
  const { observeEffects } = await import("../media/observations.ts");
  const root = await mkdtemp(join(tmpdir(), "zoom-media-observations-")), path = join(root, "effects.json");
  try {
    const effect = observeEffects(path, async request => { if (request.action === "produce") throw new Error("SFU_UNAVAILABLE"); return { epoch: "epoch", value: {} }; });
    for (let i = 0; i < 70; i++) await effect({ action: "sync", owner: { generation: 2 }, secret: "private-resume", dtlsParameters: { private: "private-dtls" } });
    await assert.rejects(effect({ action: "produce", rtpParameters: "private-rtp" }), /SFU_UNAVAILABLE/);
    const text = await readFile(path, "utf8"), records = JSON.parse(text);
    assert.ok(records.length <= 64); assert.equal(records.at(-1).status, "uncertain");
    assert.equal(text.includes("private-"), false); assert.equal(records.at(-1).action, "produce");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a transient Windows observation-file lock retries replacement without replaying the SFU effect", { skip: process.platform !== "win32", timeout: 10000 }, async () => {
  const { observeEffects } = await import("../media/observations.ts");
  const root = await mkdtemp(join(tmpdir(), "zoom-media-lock-")), path = join(root, "effects.json");
  await writeFile(path, "[]\n");
  const script = "$f=[IO.File]::Open($env:ZOOM_MEDIA_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 200; $f.Dispose()";
  const locker = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, env: { ...process.env, ZOOM_MEDIA_LOCK_PATH: path }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(locker, "exit"); let effects = 0;
  try {
    await once(locker.stdout, "data");
    const effect = observeEffects(path, async () => { effects++; return { epoch: "epoch", value: {} }; });
    await effect({ action: "sync" });
    assert.equal(effects, 1); assert.equal(JSON.parse(await readFile(path, "utf8")).at(-1).status, "applied");
  } finally { await exited; await rm(root, { recursive: true, force: true }); }
});
