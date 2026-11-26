import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { nativeBrowser } from "./fixtures/native-browser.ts";
import { until } from "../scripts/coordinator-lab.ts";

test("actual demo launcher rehearses media, meeting chat, private pub/sub, runtime and journal recovery", { timeout: 300000 }, async () => {
  const root = join(process.cwd(), ".local", "demo-rehearsals", randomUUID()), run = promisify(execFile);
  let browser: Awaited<ReturnType<typeof nativeBrowser>> | undefined;
  const evidence: { checks: { name: string; value: unknown }[]; limits: string[] } = { checks: [], limits: ["Synthetic Chromium microphone/camera and automated display selection; physical devices and audible output unverified", "Single Windows computer/Docker Desktop; independent-host and TURN deployment unverified", "Abrupt supervisor death leaves a lock requiring ownership recovery; ordinary stop/start and runtime crash recovery are supported"] };
  const check = (name: string, value: unknown = true) => { evidence.checks.push({ name, value }); console.log("rehearsal: " + name); };
  async function command(...args: string[]) {
    const result = await run(process.execPath, ["scripts/demo.ts", ...args, "--json", "--no-open"], { windowsHide: true,
      env: { ...process.env, ZOOM_DEMO_ROOT: root }, timeout: 180000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout.trim());
  }
  try {
    let status = await command("start"); assert.equal(status.ready, true);
    const ids = status.participants.map((p: any) => p.participantId);
    check("documented launcher starts actual 3-helper/4-discovery/2-runtime/4-participant processes and provisioned SFU", { helpers: status.helpers, discoveryPeers: status.discoveryPeers, runtimes: status.runtimes, media: status.media });
    browser = await nativeBrowser(join(root, "rehearsal-browser"), ["--auto-select-tab-capture-source-by-title=Assignment demo display"]);
    const tabs: Awaited<ReturnType<typeof browser.tab>>[] = [];
    for (const p of status.participants) tabs.push(await browser.tab(p.url));
    const [alice, bob, charlie, outsider] = tabs;
    for (const tab of tabs) await until("actual participant controls ready", async () => await tab.eval("globalThis.participantMedia && !document.querySelector('#group-name').disabled") ? true : undefined);
    for (const [i, tab] of [alice, bob].entries()) {
      await browser.cdp("Browser.grantPermissions", { permissions: ["audioCapture", "videoCapture"], origin: new URL(status.participants[i].url).origin });
      await tab.eval("document.querySelector('#capture-claim').click(); document.querySelector('#media-connect').click()");
      await until("media capture controls enabled", async () => await tab.eval("!document.querySelector('#media-mic').disabled && !document.querySelector('#media-camera').disabled") ? true : undefined);
      await tab.eval("document.querySelector('#media-mic').click(); document.querySelector('#media-camera').click()");
    }
    const received = async (tab: typeof alice, screen = false) => until("received media in actual launched runtime", async () => {
      const stats = await tab.eval("participantMedia.media.stats()");
      return (screen ? stats.some((s: any) => s.source === "screen" && s.frames > 0) : stats.some((s: any) => s.kind === "audio" && s.bytes > 0) && stats.some((s: any) => s.source === "camera" && s.frames > 0)) ? stats : undefined;
    }, 20000);
    check("bidirectional microphone bytes and decoded camera frames", [await received(alice), await received(bob)]);
    await alice.eval("document.querySelector('#media-play').click()");
    await until("explicit playback starts", async () => await alice.eval("participantMedia.media.playback === 'playing'") ? true : undefined);
    check("explicit playback control starts browser playback");
    await alice.eval("document.querySelector('#chat-input').value='Meeting message during media'; document.querySelector('#chat-form').requestSubmit()");
    for (const tab of [bob, charlie, outsider]) await until("public chat delivered", async () => await tab.eval("document.querySelector('#history').textContent.includes('Meeting message during media')") ? true : undefined);
    check("meeting chat reaches all four sessions while media flows");
    await alice.eval("document.querySelector('#share-request').click()");
    await until("Alice holds share turn", async () => await alice.eval("document.querySelector('#share-status').textContent.includes('Alice holds')") ? true : undefined);
    await bob.eval("document.querySelector('#share-request').click()");
    await until("Bob queued", async () => await bob.eval("document.querySelector('#share-status').textContent.includes('You are #1')") ? true : undefined);
    const source = await browser.tab(new URL(status.participants[0].url).origin);
    await until("display source loaded", async () => await source.eval("document.readyState === 'complete'") ? true : undefined);
    await source.eval("document.title='Assignment demo display';document.body.textContent='Assignment display';setInterval(()=>document.body.textContent=String(Date.now()),100)");
    await until("display control enabled", async () => await alice.eval("!document.querySelector('#media-screen').disabled") ? true : undefined);
    await alice.eval("document.querySelector('#media-screen').click()");
    check("screen display frames received under share grant", await received(bob, true));
    await browser.cdp("Target.closeTarget", { targetId: source.targetId });
    await until("exact release hands queue to Bob", async () => await bob.eval("document.querySelector('#share-status').textContent.includes('Bob holds')") ? true : undefined);
    assert.equal(await bob.eval("participantMedia.media.capture.tracks.has('screen')"), false);
    await until("Bob release button ready", async () => await bob.eval("!document.querySelector('#share-release').disabled") ? true : undefined);
    await bob.eval("document.querySelector('#share-release').click()");
    check("browser-ended display releases exact grant, queue hands off without automatically capturing");
    await alice.eval("document.querySelector('#group-name').value='Demo private group'; document.querySelector('#group-create-form').requestSubmit()");
    const groupId = await until("group created through controls", async () => await alice.eval("attachment.groups().then(r=>r.catalog.groups.find(g=>g.name==='Demo private group')?.groupId)") || undefined);
    const sendGroup = async (tab: typeof alice, content: string) => {
      await until("group composer ready", async () => await tab.eval("!document.querySelector('#group-input').disabled") ? true : undefined);
      await tab.eval(`document.querySelector('#group-input').value=${JSON.stringify(content)};document.querySelector('#group-form').requestSubmit()`);
      await until("group draft durably admitted", async () => await tab.eval("document.querySelector('#group-input').value === ''") ? true : undefined);
    };
    await sendGroup(alice, "Earlier private demo message");
    for (const [i, tab] of [[1, bob], [2, charlie]] as const) {
      await until("invite button ready", async () => await alice.eval("!document.querySelector('#group-invite').disabled") ? true : undefined);
      await alice.eval(`document.querySelector('#group-invite-person').value=${JSON.stringify(ids[i])};document.querySelector('#group-invite-form').requestSubmit()`);
      await until("explicit invitation ready", async () => await tab.eval("!document.querySelector('#group-join').hidden && !document.querySelector('#group-join').disabled") ? true : undefined);
      const beforeJoin = await tab.eval(`attachment.groupHistory(${JSON.stringify(groupId)}).then(r=>r.history.events)`); assert.deepEqual(beforeJoin, []);
      await tab.eval("document.querySelector('#group-join').click()");
      await until("earlier private history delivered", async () => await tab.eval("document.querySelector('#group-history').textContent.includes('Earlier private demo message')") ? true : undefined);
    }
    await sendGroup(alice, "Private multi-subscriber publication");
    for (const tab of [bob, charlie]) await until("both private subscribers receive", async () => await tab.eval("document.querySelector('#group-history').textContent.includes('Private multi-subscriber publication')") ? true : undefined);
    assert.deepEqual(await outsider.eval("attachment.groups().then(r=>r.catalog.groups)"), []);
    assert.equal(await outsider.eval(`attachment.groupHistory(${JSON.stringify(groupId)}).then(()=>false,e=>e.message)`), "GROUP_ACCESS_DENIED");
    check("private pub/sub has multiple subscribers, earlier history and nonmember payload exclusion");
    const generation = status.generation;
    const oldProducers = await alice.eval("[...participantMedia.media.producers.keys()]");
    status = await command("fail-runtime"); assert.ok(status.generation > generation); assert.deepEqual(status.participants.map((p: any) => p.participantId), ids);
    await until("media rebuild after actual runtime crash", async () => await alice.eval(`participantMedia.media.state === 'ready' && [...participantMedia.media.producers.keys()].some(id=>!${JSON.stringify(oldProducers)}.includes(id))`) ? true : undefined, 25000);
    check("actual runtime process crash recovers metadata/SQL/journals and media reception", { generation: status.generation, received: [await received(alice), await received(bob)] });
    await sendGroup(alice, "Private after runtime recovery");
    await until("group subscription survives runtime recovery", async () => await charlie.eval("document.querySelector('#group-history').textContent.includes('Private after runtime recovery')") ? true : undefined);
    await bob.eval("document.querySelector('#group-leave').click()");
    await until("group leave effective", async () => await bob.eval("document.querySelector('#group-status').textContent.includes('You have left')") ? true : undefined);
    await sendGroup(alice, "After group unsubscribe");
    await until("remaining subscriber receives", async () => await charlie.eval("document.querySelector('#group-history').textContent.includes('After group unsubscribe')") ? true : undefined);
    assert.equal(await bob.eval(`attachment.groupHistory(${JSON.stringify(groupId)}).then(r=>JSON.stringify(r.history).includes('After group unsubscribe'))`), false);
    check("group leave stops subsequent delivery and retains earlier downloaded messages");
    await command("fail-participant", "Bob"); status = await command("restart-participant", "Bob");
    assert.equal(status.participants[1].participantId, ids[1]);
    const bobRestarted = await browser.tab(status.participants[1].url);
    await until("same journal after participant crash", async () => await bobRestarted.eval(`attachment.groupHistory(${JSON.stringify(groupId)}).then(r=>r.history.membership === 'left' && r.history.events.some(e=>e.payload.content==='Earlier private demo message'))`) ? true : undefined);
    check("participant crash/restart preserves identity and deliberate group leave");
    await bobRestarted.eval("document.querySelector('#leave').click();document.querySelector('#leave-submit').click()");
    await until("meeting leave durable", async () => (await command("status")).participants[1].left ? true : undefined);
    status = await command("new-participant", "Bob"); assert.notEqual(status.participants[1].participantId, ids[1]);
    const newBob = await browser.tab(status.participants[1].url);
    await until("new participant page ready", async () => await newBob.eval("globalThis.attachment?.readyState === 'attached'") ? true : undefined);
    assert.deepEqual(await newBob.eval("attachment.groups().then(r=>r.catalog.groups)"), []);
    check("explicit return after meeting leave creates a new identity without restoring private membership");
    const finalIds = status.participants.map((p: any) => p.participantId);
    await browser.close(); browser = undefined;
    const stopped = await command("stop"); assert.deepEqual(stopped.cleanupErrors, []);
    status = await command("start"); assert.deepEqual(status.participants.map((p: any) => p.participantId), finalIds);
    browser = await nativeBrowser(join(root, "resumed-browser"));
    const resumed = await browser.tab(status.participants[2].url);
    await until("retained private history after complete stop/start", async () => await resumed.eval("document.querySelector('#group-history').textContent.includes('After group unsubscribe')") ? true : undefined);
    check("complete shutdown/start retains shared histories, identities and subscriptions");
    await browser.close(); browser = undefined;
    const finalStop = await command("stop"); assert.deepEqual(finalStop.cleanupErrors, []); assert.equal((await command("status")).phase, "stopped");
    check("final shutdown confirms owned resource cleanup and retained volumes");
    const output = ".local/demo-rehearsal-evidence"; await mkdir(output, { recursive: true });
    await writeFile(join(output, "result.json"), JSON.stringify({ ...evidence, root, observedAt: new Date().toISOString() }, null, 2));
  } finally { await browser?.close(); await command("stop"); }
});
