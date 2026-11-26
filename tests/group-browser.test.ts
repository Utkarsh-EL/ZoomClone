import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { StorageLab } from "../scripts/storage-lab.ts";
import { CoordinatorLab, until } from "../scripts/coordinator-lab.ts";
import { Database, createPool } from "../storage/database.ts";
import { MeetingStore } from "../storage/meeting-store.ts";
import { startMeetingRuntime } from "../coordination/runtime-service.ts";
import { RemoteRuntime, availableRuntimes } from "../coordination/runtime-rpc.ts";
import { RecoveryController } from "../coordination/recovery-controller.ts";
import { startParticipant } from "../client/participant-agent.ts";
import { nativeBrowser } from "./fixtures/native-browser.ts";
import { LeaderRoute } from "../coordination/helper-route.ts";

test("four browser sessions demonstrate private group membership pub/sub, earlier history, CLI/reload and leave", { timeout: 120000 }, async () => {
  const storage = new StorageLab(); await storage.start();
  let db: Database | undefined, pool: ReturnType<typeof createPool> | undefined, helpers: CoordinatorLab | undefined;
  let runtime: Awaited<ReturnType<typeof startMeetingRuntime>> | undefined, browser: Awaited<ReturnType<typeof nativeBrowser>> | undefined;
  const participants: ReturnType<typeof startParticipant>[] = [];
  try {
    const probe = createPool(storage.url, 1);
    try { await until("published group PostgreSQL endpoint", async () => { try { await probe.query("SELECT 1"); return true; } catch { return undefined; } }, 10000); }
    finally { await probe.end(); }
    db = await Database.open({ connectionString: storage.url, clusterId: storage.clusterId, initialize: true });
    const password = randomBytes(32).toString("hex"); await db.pool.query(`ALTER ROLE zoom_runtime LOGIN PASSWORD '${password}'`);
    const runtimeURL = new URL(storage.url); runtimeURL.username = "zoom_runtime"; runtimeURL.password = password;
    pool = createPool(runtimeURL.href); const store = new MeetingStore(db, pool);
    helpers = await CoordinatorLab.create(3, storage.clusterId);
    await helpers.leader();
    const helper = new LeaderRoute(helpers.nodes.map(n => helpers!.connection(n))), routes = helpers.nodes.map(n => ({ helperId: n.id, address: n.address }));
    const identity = { clusterId: storage.clusterId, nodeId: randomUUID(), incarnation: randomUUID() }, runtimeId = randomUUID(), token = randomBytes(32).toString("hex");
    runtime = await startMeetingRuntime({ clusterId: storage.clusterId, runtimeId, expectedRevision: 0, address: "127.0.0.1:0", token, callers: [identity.nodeId], helpers: routes,
      helperToken: helpers.token, helperTimeoutMs: 500, connectionString: storage.url, runtimeConnectionString: runtimeURL.href, participants: { address: "127.0.0.1:0", token } }, () => {});
    const incarnation = runtime.agent.identity.incarnation;
    const remote = new RemoteRuntime({ ...identity, identity, runtimeId, incarnation, address: runtime.address, token, timeoutMs: 800 });
    await until("group runtime registered", async () => await remote.available() ? true : undefined);
    const meetingId = randomUUID();
    await helper.call("apply", { command: { id: randomUUID(), kind: "reserve", meetingId, code: "group-demo" } });
    const controller = new RecoveryController(helpers.connection(await helpers.leader()), store, { clusterId: storage.clusterId, suspicionMs: 1500 });
    await until("group meeting ready", async () => await controller.tick(meetingId, await availableRuntimes([remote])) === "READY" ? true : undefined);
    browser = await nativeBrowser(join(storage.root, "group-browser"));
    const tabs: Awaited<ReturnType<typeof browser.tab>>[] = [];
    for (const name of ["Alice", "Bob", "Charlie", "Outsider"]) {
      const participant = startParticipant({ sessionPath: join(storage.root, name + ".sqlite"), target: { clusterId: storage.clusterId, meetingId, name },
        helpers: routes, helperToken: helpers.token, routes: [{ runtimeId, incarnation, address: runtime.participantAddress!, token }], intervalMs: 100 });
      participants.push(participant);
      await until(name + " ready", async () => participant.session.state === "connected" ? true : undefined);
      tabs.push(await browser.tab((await participant.openBrowser()).url));
    }
    const [alice, bob, charlie, outsider] = tabs;
    for (const tab of tabs) await until("participant controls", async () => await tab.eval("globalThis.attachment && !document.querySelector('#group-name').disabled") ? true : undefined);
    for (let i = 0; i < 20; i++) participants[0].session.submit({ type: "chat", content: `advanced meeting ${i}` });
    await until("meeting replay advanced", async () => participants.every(p => p.session.journal.cursor().seq >= 24) ? true : undefined);
    await alice.eval("document.querySelector('#group-name').value='Private study'; document.querySelector('#group-create-form').requestSubmit()");
    const groupId = await until("created through UI", async () => participants[0].session.journal.groupsView().groups[0]?.groupId);
    await until("creator can publish", async () => await alice.eval("!document.querySelector('#group-send').disabled || !document.querySelector('#group-input').disabled") ? true : undefined);
    async function send(tab: typeof alice, content: string) {
      await tab.eval(`document.querySelector('#group-input').value=${JSON.stringify(content)}; document.querySelector('#group-form').requestSubmit()`);
      await until("draft cleared only after admission", async () => await tab.eval("document.querySelector('#group-input').value === ''") ? true : undefined);
    }
    await send(alice, "Earlier private message");
    for (const [i, tab] of [[1, bob], [2, charlie]] as const) {
      const id = participants[i].session.view().participantId;
      await until("invitation control ready", async () => await alice.eval("!document.querySelector('#group-invite').disabled") ? true : undefined);
      await alice.eval(`document.querySelector('#group-invite-person').value=${JSON.stringify(id)}; document.querySelector('#group-invite-form').requestSubmit()`);
      await until("invitation visible", async () => await tab.eval("!document.querySelector('#group-join').hidden && !document.querySelector('#group-join').disabled") ? true : undefined);
      assert.equal(participants[i].session.journal.groupView(groupId).events.length, 0, "invite alone delivers no history");
      await tab.eval("document.querySelector('#group-join').click()");
      await until("earlier history after join", async () => await tab.eval("document.querySelector('#group-history').textContent.includes('Earlier private message') && !document.querySelector('#group-input').disabled") ? true : undefined);
    }
    await send(alice, "One publisher, two subscribers");
    for (const tab of [bob, charlie]) await until("publication received", async () => await tab.eval("document.querySelector('#group-history').textContent.includes('One publisher, two subscribers')") ? true : undefined);
    assert.deepEqual(await outsider.eval("attachment.groups().then(r=>r.catalog.groups)"), []);
    assert.equal(await outsider.eval(`attachment.groupHistory(${JSON.stringify(groupId)}).then(()=>false,e=>e.message)`), "GROUP_ACCESS_DENIED");
    assert.equal(JSON.stringify(participants[3].session.view()).includes("Private study"), false);
    participants[2].session.submit({ type: "group-chat", groupId, content: "Shared CLI identity" });
    await browser.cdp("Page.reload", {}, charlie.sessionId);
    await until("same CLI history after reload", async () => await charlie.eval("document.querySelector('#group-history').textContent.includes('Shared CLI identity')") ? true : undefined);
    await bob.eval("document.querySelector('#group-leave').click()");
    await until("unsubscribed", async () => participants[1].session.journal.groupView(groupId).membership === "left" ? true : undefined);
    await send(alice, "After Bob left");
    await until("remaining subscriber receives", async () => await charlie.eval("document.querySelector('#group-history').textContent.includes('After Bob left')") ? true : undefined);
    assert.equal(JSON.stringify(participants[1].session.journal.groupView(groupId)).includes("After Bob left"), false);
    assert.equal(participants[1].session.journal.groupView(groupId).events.some(e => e.payload.content === "Earlier private message"), true);
    await until("fresh server authorization rejects departed subscriber", async () => {
      const owner = runtime!.agent.authority(meetingId); if (!owner?.ready()) return undefined;
      try { await store.readGroup(owner, participants[1].session.journal.credential(), groupId); assert.fail("departed member read private history"); }
      catch (error) { if (error instanceof Error && error.message === "NOT_READY") return undefined; assert.match(String(error), /GROUP_ACCESS_DENIED/); return true; }
    });
    const evidenceRoot = ".local/group-browser-evidence"; await mkdir(evidenceRoot, { recursive: true });
    for (const [label, width, height] of [["desktop", 1440, 1100], ["mobile", 390, 900]] as const) {
      await browser.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, alice.sessionId);
      assert.equal(await alice.eval("document.documentElement.scrollWidth <= innerWidth"), true);
      const capture = await browser.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, alice.sessionId);
      await writeFile(join(evidenceRoot, label + ".png"), Buffer.from(capture.data, "base64"));
    }
    await writeFile(join(evidenceRoot, "result.json"), JSON.stringify({ storageLab: storage.project, checks: ["four distinct sessions", "advanced meeting cursor", "explicit invitations", "earlier history", "multiple subscribers", "outsider payload exclusion", "shared CLI and reload", "leave stops future access", "retained local history", "desktop/mobile fit"] }, null, 2));
  } finally {
    await browser?.close(); await Promise.allSettled(participants.map(p => p.close()));
    await runtime?.close(); await pool?.end(); await db?.close(); await helpers?.stop(); storage.stop();
  }
});
