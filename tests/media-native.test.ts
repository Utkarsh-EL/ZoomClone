import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
import { serveBrowserAttachment } from "../client/browser-attachment.ts";
import { nativeBrowser } from "./fixtures/native-browser.ts";
import { tcpCut } from "./fixtures/tcp-cut.ts";
import { ParticipantConnection } from "../client/participant-transport.ts";
import { ownerFor } from "../coordination/recovery-controller.ts";
import type { MetadataState } from "../coordination/helper-client.ts";

async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
test("two native browsers exchange SFU capture under SQL/runtime and local lease fences, then rebuild after SFU crash", { timeout: 180000 }, async () => {
  const storage = new StorageLab(); await storage.start();
  const clusterId = storage.clusterId, meetingId = randomUUID();
  let db: Database | undefined, pool: ReturnType<typeof createPool> | undefined, helpers: CoordinatorLab | undefined;
  let runtime: Awaited<ReturnType<typeof startMeetingRuntime>> | undefined;
  let successor: Awaited<ReturnType<typeof startMeetingRuntime>> | undefined;
  const cuts: Awaited<ReturnType<typeof tcpCut>>[] = [];
  const participants: ReturnType<typeof startParticipant>[] = [], attachments: Awaited<ReturnType<typeof serveBrowserAttachment>>[] = [], browsers: Awaited<ReturnType<typeof nativeBrowser>>[] = [];
  const name = `zoom-media-${randomUUID().slice(0, 8)}`, identity = { clusterId, nodeId: randomUUID(), incarnation: randomUUID() }, nodeId = randomUUID(), token = randomBytes(32).toString("hex");
  let container = false;
  const evidence: any = { base: "5bf5067", composition: "supervised participant controls through production gateway and provisioned SFU routes", storageLab: storage.project, mediaContainer: name, checks: [] };
  function check(name: string, value: unknown = true) { evidence.checks.push({ name, value }); console.log(`media check: ${name}`); }
  try {
    // Compose's in-container pg_isready can see the temporary initialization
    // server. Probe the actual published TCP path before starting migrations.
    const probe = createPool(storage.url, 1);
    try { await until("published PostgreSQL endpoint", async () => { try { await probe.query("SELECT 1"); return true; } catch { return undefined; } }, 10000); }
    finally { await probe.end(); }
    db = await Database.open({ connectionString: storage.url, clusterId, initialize: true });
    const runtimePassword = randomBytes(32).toString("hex");
    await db.pool.query(`ALTER ROLE zoom_runtime LOGIN PASSWORD '${runtimePassword}'`);
    const runtimeURL = new URL(storage.url); runtimeURL.username = "zoom_runtime"; runtimeURL.password = runtimePassword;
    pool = createPool(runtimeURL.href); const store = new MeetingStore(db, pool);
    helpers = await CoordinatorLab.create(3, clusterId);
    const routes = helpers.nodes.map(n => ({ helperId: n.id, address: n.address })), helper = helpers.connection(await helpers.leader());
    const controlPort = await port(), mediaPort = await port();
    const runtimeId = randomUUID(), runtimeIncarnation = randomUUID(), successorId = randomUUID(), successorIncarnation = randomUUID();
    const runtimeToken = randomBytes(32).toString("hex"), participantToken = randomBytes(32).toString("hex");
    for (const route of routes) cuts.push(await tcpCut(route.address));
    const isolatedHelpers = routes.map((route, i) => ({ ...route, address: cuts[i].address }));
    const successorMedia = await tcpCut(`127.0.0.1:${controlPort}`); cuts.push(successorMedia);
    const mediaRoute = { meetingId, address: `http://127.0.0.1:${controlPort}`, nodeId, token, observationPath: join(storage.root, "media-primary.json") };
    runtime = await startMeetingRuntime({ clusterId, runtimeId, incarnation: runtimeIncarnation, expectedRevision: 0, address: "127.0.0.1:0", token: runtimeToken, callers: [identity.nodeId], helpers: isolatedHelpers,
      helperToken: helpers.token, helperTimeoutMs: 400, connectionString: storage.url, runtimeConnectionString: runtimeURL.href,
      intervalMs: 500, readinessMs: 2000, participants: { address: "127.0.0.1:0", token: participantToken, timeoutMs: 15000 }, media: { routes: [mediaRoute] } }, (_id, error) => {
        evidence.runtimeRenewals ??= { ok: 0, errors: {} };
        if (error) evidence.runtimeRenewals.errors[error.message] = (evidence.runtimeRenewals.errors[error.message] ?? 0) + 1;
        else { evidence.runtimeRenewals.ok++; evidence.lastRenewalAtMs = performance.now(); }
      });
    successor = await startMeetingRuntime({ clusterId, runtimeId: successorId, incarnation: successorIncarnation, expectedRevision: 0,
      address: "127.0.0.1:0", token: runtimeToken, callers: [identity.nodeId], helpers: routes,
      helperToken: helpers.token, helperTimeoutMs: 400, connectionString: storage.url, runtimeConnectionString: runtimeURL.href,
      participants: { address: "127.0.0.1:0", token: participantToken, timeoutMs: 15000 }, media: { routes: [{ ...mediaRoute,
        address: `http://${successorMedia.address}`, observationPath: join(storage.root, "media-successor.json") }] } }, () => {});
    const incarnation = runtime.agent.identity.incarnation;
    const remote = new RemoteRuntime({ clusterId, runtimeId, incarnation, address: runtime.address, token: runtimeToken, identity, timeoutMs: 800 });
    const nextRemote = new RemoteRuntime({ clusterId, runtimeId: successorId, incarnation: successorIncarnation, address: successor.address, token: runtimeToken, identity, timeoutMs: 800 });
    await until("registered media runtime", async () => await remote.available() ? true : undefined);
    await helper.call("apply", { command: { id: randomUUID(), kind: "reserve", meetingId, code: "media-" + meetingId.slice(0, 8) } });
    const controller = new RecoveryController(helper, store, { clusterId, suspicionMs: 1500 });
    await until("active media meeting", async () => await controller.tick(meetingId, await availableRuntimes([remote])) === "READY" ? true : undefined);
    storage.docker(["run", "--detach", "--name", name, "--label", `org.zoomclone.lab=${name}`, "--publish", `127.0.0.1:${controlPort}:8080/tcp`, "--publish", `127.0.0.1:${mediaPort}:${mediaPort}/tcp`, "--publish", `127.0.0.1:${mediaPort}:${mediaPort}/udp`,
      ...["MEDIA_CLUSTER_ID", "MEDIA_NODE_ID", "MEDIA_MEETING_ID", "MEDIA_CALLERS", "MEDIA_TOKEN", "MEDIA_PORT"].flatMap(key => ["--env", key]), "zoomclone-media-feasibility:3.32.2"],
      { MEDIA_CLUSTER_ID: clusterId, MEDIA_NODE_ID: nodeId, MEDIA_MEETING_ID: meetingId, MEDIA_CALLERS: JSON.stringify([{ nodeId: runtimeId, incarnation }, { nodeId: successorId, incarnation: successorIncarnation }]), MEDIA_TOKEN: token, MEDIA_PORT: String(mediaPort) });
    container = true;
    for (const person of ["Alice", "Bob"]) {
      const agent = startParticipant({ sessionPath: join(storage.root, `${person}.sqlite`), target: { clusterId, meetingId, name: person }, helpers: routes, helperToken: helpers.token,
        routes: [{ runtimeId, incarnation, address: runtime.participantAddress!, token: participantToken },
          { runtimeId: successorId, incarnation: successorIncarnation, address: successor.participantAddress!, token: participantToken }], helperTimeoutMs: 400, timeoutMs: 8000, intervalMs: 200,
        browser: { address: "127.0.0.1:0", timeoutMs: 30000 }, media: { bundlePath: ".local/media-lab.js" } });
      participants.push(agent);
      await until(`${person} joined`, async () => agent.session.state === "connected" ? true : undefined);
      const attachment = await agent.openBrowser();
      attachments.push(attachment);
    }
    check("real PostgreSQL, three helpers, provisioned runtime route and two distinct shared sessions");
    for (const person of ["Alice", "Bob"]) browsers.push(await nativeBrowser(join(storage.root, `browser-${person}`), ["--auto-select-tab-capture-source-by-title=SFU capture source"]));
    const [a, b] = await Promise.all(browsers.map((browser, i) => browser.tab(attachments[i].url)));
    async function ready(tab: typeof a) {
      await until("native media controls", async () => await tab.eval("globalThis.participantMedia && !document.querySelector('#media-section').hidden") ? true : undefined);
      await tab.eval("globalThis.media = participantMedia.media");
    }
    await ready(a); await ready(b);
    await browsers[0].cdp("Browser.setPermission", { permission: { name: "camera" }, setting: "denied", origin: attachments[0].origin });
    await a.eval("attachment.claimCapture()");
    await until("Alice media eligible", async () => await a.eval("!document.querySelector('#media-connect').disabled") ? true : undefined);
    await a.eval("document.querySelector('#media-connect').click()");
    await until("Alice media connected", async () => await a.eval("participantMedia.canStart") ? true : undefined)
      .catch(async error => { throw new Error(`${error.message}: ${await a.eval("JSON.stringify({enabled:participantMedia.enabled,eligible:participantMedia.eligible,state:media.state,error:participantMedia.error,attempts:participantMedia.attempts,owner:attachment.ownsCapture,status:document.querySelector('#media-status').textContent})")}`); });
    await a.eval("document.querySelector('#media-camera').click()");
    await until("camera denial visible", async () => await a.eval("document.querySelector('#media-error').textContent.includes('Permission was denied')") ? true : undefined);
    assert.equal(await a.eval("media.capture.tracks.size"), 0); check("native camera permission denial visible in participant controls");
    for (let i = 0; i < browsers.length; i++) await browsers[i].cdp("Browser.grantPermissions", { permissions: ["audioCapture", "videoCapture"], origin: attachments[i].origin });
    await b.eval("attachment.claimCapture()");
    await b.eval("document.querySelector('#media-connect').click()");
    for (const tab of [a, b]) {
      for (const source of ['mic', 'camera']) {
        await until("capture control ready", async () => await tab.eval(`!document.querySelector('#media-${source}').disabled`) ? true : undefined);
        await tab.eval(`document.querySelector('#media-${source}').click()`);
        await until("source publishing", async () => await tab.eval(`document.querySelector('#${source}-status').textContent.includes('publishing')`) ? true : undefined);
      }
    }
    for (const tab of [a, b]) await tab.eval("media.subscribe()");
    async function received(tab: typeof a, screen = false) {
      return until("received native RTP and decoded frames", async () => {
        const stats = await tab.eval("media.stats()");
        return (screen ? stats.some((s: any) => s.source === "screen" && s.frames > 0) : stats.some((s: any) => s.kind === "audio" && s.bytes > 0) && stats.some((s: any) => s.source === "camera" && s.frames > 0)) ? stats : undefined;
      }, 15000);
    }
    check("bidirectional native audio/video", [await received(a), await received(b)]);
    const evidenceRoot = process.env.ZOOM_MEDIA_EVIDENCE ?? '.local/media-evidence'; await mkdir(evidenceRoot, { recursive: true });
    for (const [label, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 900]] as const) {
      await browsers[0].cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, a.sessionId);
      assert.equal(await a.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${label} media controls fit viewport`);
      const capture = await browsers[0].cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, a.sessionId);
      await writeFile(join(evidenceRoot, `${label}.png`), Buffer.from(capture.data, 'base64'));
    }
    await browsers[0].cdp('Emulation.clearDeviceMetricsOverride', {}, a.sessionId);
    await a.eval("document.querySelector('#media-play').click()");
    assert.equal(await a.eval('media.playback'), 'playing');
    await a.eval("document.querySelector('#media-play').click()"); assert.equal(await a.eval('media.playback'), 'muted');
    check('explicit playback and responsive desktop/mobile media controls');
    await a.eval("document.querySelector('#share-request').click()");
    const request = await until("UI share request saved", async () => {
      const command = participants[0].session.view().commands.find(c => c.operation.type === 'request-share');
      return command ? { commandId: command.id } : undefined;
    });
    await until("committed SQL screen grant", async () => (await store.observe(meetingId)).state.holder?.requestId === request.commandId ? true : undefined);
    const grant = { requestId: request.commandId, grantVersion: (await store.observe(meetingId)).state.grantVersion };
    assert.equal(await a.eval(`media.call({action:'produce',source:'screen',requestId:'${grant.requestId}',grantVersion:0}).then(()=>null,e=>e.message)`), "STALE_GRANT");
    check("stale screen grant rejected before producer creation");
    const source = await browsers[0].tab(attachments[0].origin);
    await until("capture source document", async () => await source.eval("document.readyState === 'complete'") ? true : undefined);
    await source.eval("document.title = 'SFU capture source'; document.body.textContent='Native display capture source'; setInterval(()=>document.body.textContent=String(Date.now()),100)");
    await until("display control has grant", async () => await a.eval("!document.querySelector('#media-screen').disabled") ? true : undefined);
    await a.eval("document.querySelector('#media-screen').click()");
    await until("display publishes", async () => await a.eval("!!media.capture.tracks.get('screen')?.producer") ? true : undefined);
    await b.eval("media.subscribe()"); check("native display capture received", await received(b, true));
    // Closing the selected source makes Chromium end the native display track.
    // No synthetic ended event or replacement getDisplayMedia implementation.
    await browsers[0].cdp("Target.closeTarget", { targetId: source.targetId });
    await until("browser ended screen release", async () => await a.eval("media.capture.releaseCommandId") || undefined);
    const releaseId = await a.eval("media.capture.releaseCommandId");
    await until("SQL screen release", async () => (await store.observe(meetingId)).state.holder === null ? true : undefined);
    assert.equal(participants[0].session.view().commands.find(c => c.id === releaseId)?.operation.type, "release-share");
    assert.equal(participants[0].session.view().commands.filter(c => c.operation.type === "release-share").length, 1);
    const intentions = await db.pool.query("SELECT seq,desired FROM zoom.media_intentions WHERE meeting_id=$1 ORDER BY seq", [meetingId]);
    assert.equal(intentions.rows.length, 2); assert.equal(intentions.rows[0].desired.holder.requestId, grant.requestId); assert.equal(intentions.rows[1].desired.holder, null);
    check("native browser source ended, exact single release", { commandId: releaseId, requestId: request.commandId });
    // A separate native browser asks for this-tab capture with auto-reject. This
    // exercises Chromium's canceled picker path without stubbing capture APIs.
    const cancelBrowser = await nativeBrowser(join(storage.root, "browser-cancel"), ["--auto-reject-this-tab-capture"]); browsers.push(cancelBrowser);
    const cancelTab = await cancelBrowser.tab(attachments[0].url); await ready(cancelTab); await cancelTab.eval("attachment.claimCapture()");
    const cancelRequest = participants[0].session.submit({ type: 'request-share' });
    await until("picker cancel has current grant", async () => await cancelTab.eval(`participantMedia.model.state?.holder?.requestId === '${cancelRequest}'`) ? true : undefined);
    const cancelGrant = { requestId: cancelRequest, grantVersion: (await store.observe(meetingId)).state.grantVersion };
    const beforeCancel = participants[0].session.view().commands.length;
    const canceled = await cancelTab.eval(`media.capture.start('screen', () => navigator.mediaDevices.getDisplayMedia({video:true,preferCurrentTab:true}), ${JSON.stringify(cancelGrant)}).then(()=>null,e=>e.name)`);
    assert.equal(canceled, "NotAllowedError"); assert.equal(await cancelTab.eval("media.capture.tracks.size"), 0); check("native display picker cancel", canceled);
    assert.equal(participants[0].session.view().commands.length, beforeCancel);
    await cancelTab.eval(`participantMedia.model.releaseCaptured(${JSON.stringify(cancelGrant)})`);
    await until("cancel grant released explicitly", async () => (await store.observe(meetingId)).state.holder === null ? true : undefined);
    await until("lease revokes original tracks", async () => await a.eval("media.capture.tracks.size === 0") ? true : undefined);
    const aliceId = participants[0].session.view().participantId;
    const afterRevoke = await b.eval("media.call({action:'list'})");
    assert.equal(afterRevoke.filter((p: any) => p.participantId === aliceId).length, 0, "server closes revoked capture even if the old browser ignores events");
    await a.eval("attachment.claimCapture()"); await a.eval("media.open();");
    for (const kind of ["mic", "camera"]) await a.eval(`media.start('${kind}')`);
    await b.eval("media.subscribe()"); await received(b);
    check("lease replacement stops original capture and successor remains usable");
    const oldEpoch = await a.eval("media.epoch"), beforeRestart = performance.now();
    storage.docker(["kill", name]);
    const chat = participants[0].session.submit({ type: "chat", content: "chat while SFU is down" });
    await until("independent chat delivery", async () => participants[1].session.view().events.some(e => e.payload.content === "chat while SFU is down") ? true : undefined);
    assert.ok(participants[0].session.view().commands.find(c => c.id === chat)?.outcome);
    const unavailable = await a.eval("media.subscribe().then(()=>false,()=>media.state === 'unavailable')"); assert.equal(unavailable, true);
    storage.docker(["start", name]);
    await until("supervised rebuild after SFU restart", async () => await a.eval(`media.epoch !== '${oldEpoch}' && media.state === 'ready' && participantMedia.attempts === 0`) && await b.eval("media.state === 'ready' && participantMedia.attempts === 0") ? true : undefined, 25000);
    for (const tab of [a, b]) await tab.eval("media.subscribe()");
    const recovered = [await received(a), await received(b)];
    assert.notEqual(await a.eval("media.epoch"), oldEpoch);
    check("SFU crash leaves chat usable, explicit media rebuild with new epoch", { elapsedMs: performance.now() - beforeRestart, stats: recovered });
    for (let i = 0; i < participants.length; i++) {
      const view = await [a, b][i].eval("attachment.view()");
      assert.equal(view.view.participantId, participants[i].session.view().participantId);
      assert.equal(view.view.cursor.subscriptionRevision, 0);
      assert.equal(view.view.commands.filter((c: any) => c.operation.type === "join").length, 1);
      assert.deepEqual(view.view.commands, participants[i].session.view().commands);
    }
    check("browser and CLI retain identity, original command IDs and unfiltered revision zero");
    const oldOwner = ownerFor(clusterId, (await helper.call<MetadataState>("read")).meetings[meetingId]);
    // Isolate old runtime + SFU from the coordinators/new runtime's media path.
    // Old runtime retains SQL reachability; the successor retains SQL/quorum.
    for (const cut of cuts.slice(0, 3)) cut.cut(); successorMedia.cut();
    await until("takeover while old runtime and SFU are isolated", async () => {
      const result = await controller.tick(meetingId, await availableRuntimes([nextRemote]));
      return result === "READY" && (await store.observe(meetingId)).generation === 2 ? true : undefined;
    }, 20000);
    const credential = participants[0].session.journal.credential();
    await assert.rejects(runtime.store.read({ owner: oldOwner, ready: () => true }, credential, 0, 1), /FENCED/);
    const stale = await ParticipantConnection.connect({ identity: { clusterId, nodeId: credential.participantId, incarnation: randomUUID() },
      owner: oldOwner, address: runtime.participantAddress!, token: participantToken });
    try { await assert.rejects(stale.media(credential, randomUUID(), { action: "open" }, true), /NOT_READY|FENCED/); }
    finally { stale.close(); }
    const takeoverChat = participants[0].session.submit({ type: "chat", content: "chat during media isolation and runtime takeover" });
    await until("takeover chat independent of isolated SFU", async () => participants[1].session.view().events.some(e => e.payload.content === "chat during media isolation and runtime takeover") ? true : undefined);
    assert.ok(participants[0].session.view().commands.find(c => c.id === takeoverChat)?.outcome);
    assert.equal(await a.eval("media.call({action:'list'}).then(()=>false,()=>media.state==='unavailable')"), true);
    check("real TCP isolation: takeover chat works, old runtime and stale SQL authority refuse new media");
    successorMedia.heal();
    await a.eval("media.reconnect()"); await b.eval("media.reconnect()");
    for (const tab of [a, b]) await tab.eval("media.subscribe()");
    check("successor reconciles same provisioned SFU after healing", [await received(a), await received(b)]);
    await runtime.close();
    assert.ok((await b.eval("media.call({action:'list'})")).some((p: any) => p.source === "camera"));
    check("old runtime drain cannot tear down successor-owned transports");
    const observations = JSON.parse(await readFile(join(storage.root, "media-successor.json"), "utf8"));
    assert.ok(observations.length <= 64 && observations.some((record: any) => record.status === "applied"));
    assert.equal(JSON.stringify(observations).includes(credential.secret), false);
    check("separate bounded persisted effect observations exclude participant credentials");
    await a.eval("document.querySelector('#leave').click(); document.querySelector('#leave-submit').click()");
    assert.equal(await a.eval('media.capture.tracks.size'), 0);
    await until('UI leave committed', async () => !(await store.observe(meetingId)).state.members[aliceId]?.joined ? true : undefined);
    assert.equal(await a.eval('participantMedia.enabled'), false);
    check('explicit leave stops local capture immediately and preserves shared command path');
    await Promise.all(participants.map(participant => participant.close()));
    check("participant shutdown explicitly drains local media cleanup before journal close");
    evidence.result = "passed";
  } catch (error) {
    evidence.result = "failed"; evidence.error = String(error);
    if (container) console.error(storage.docker(["logs", "--tail", "35", name]));
    console.error(storage.compose(["logs", "--tail", "40", "postgres"]));
    throw error;
  } finally {
    const evidenceRoot = process.env.ZOOM_MEDIA_EVIDENCE ?? ".local/media-evidence"; await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(attachments.map(attachment => attachment.close()));
    await Promise.allSettled(participants.map(agent => agent.close()));
    await Promise.allSettled([runtime?.close(), successor?.close()]); await Promise.allSettled(cuts.map(cut => cut.close()));
    await helpers?.stop(); await pool?.end(); await db?.close();
    if (container) storage.docker(["rm", "--force", name]); storage.stop();
  }
});
