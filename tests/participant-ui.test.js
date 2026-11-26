import assert from "node:assert/strict";
import { test } from "node:test";
import { ParticipantModel } from "../client/participant-model.js";

class Attachment extends EventTarget {
  readyState = "attached";
  captureState = { revision: 2, owner: null };
  attachment = { id: "tab", revision: 1 };
  commands = [];
  submissions = [];
  events = Array.from({ length: 49 }, (_, i) => ({ seq: i + 1, kind: i % 3 ? "chat" : "share-changed", payload: { participantId: "me", content: `message ${i + 1}` } }));
  state = { members: { me: { name: "Alice", joined: true } }, holder: null, queue: [], grantVersion: 0 };
  requests = [];
  async view(after, limit) {
    this.requests.push({ after, limit });
    return { view: { clusterId: "cluster", meetingId: "meeting", participantId: "me", name: "Alice", cursor: { subscriptionRevision: 0, seq: this.events.length }, left: false,
      connection: "authority unavailable", observation: { state: this.state, watermark: this.events.length, observedAt: "2026-11-25T12:00:00Z" },
      events: this.events.filter(e => e.seq > after).slice(0, limit), commands: structuredClone(this.commands) } };
  }
  async submit(operation) {
    this.submissions.push(operation);
    const commandId = `command-${this.submissions.length}`;
    this.commands.push({ id: commandId, operation, outcome: null });
    return { commandId };
  }
  async claimCapture(revision) { this.claimedRevision = revision; throw new Error("STALE_CAPTURE"); }
  async releaseCapture(revision) { this.releasedRevision = revision; return {}; }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
}

function fixture(attachment = new Attachment(), saved = new Map()) {
  const model = new ParticipantModel(attachment, { load: key => saved.get(key), save: (key, value) => saved.set(key, value) });
  return { model, attachment, saved };
}

test('captured screen release shares the persisted uncertainty guard and original command review', async () => {
  const f = fixture(); f.attachment.state.holder = { participantId: 'me', requestId: 'captured' }; f.attachment.state.grantVersion = 7;
  await f.model.refresh(); const submit = f.attachment.submit.bind(f.attachment);
  f.attachment.submit = async operation => { await submit(operation); throw new Error('ATTACHMENT_TIMEOUT'); };
  assert.equal(await f.model.releaseCaptured({ requestId: 'captured', grantVersion: 7 }), null);
  assert.equal(f.model.uncertain, true); await f.model.refresh();
  assert.deepEqual(f.model.view.commands[0].operation, { type: 'release-share', requestId: 'captured' });
  const reloaded = fixture(f.attachment, f.saved); await reloaded.model.refresh();
  assert.equal(reloaded.model.uncertain, true);
  assert.equal(await reloaded.model.releaseCaptured({ requestId: 'captured', grantVersion: 7 }), null);
  assert.equal(f.attachment.submissions.length, 1);
});
test('captured release never waits out a busy command or releases a replacement grant', async () => {
  const f = fixture(); f.attachment.state.holder = { participantId: 'me', requestId: 'captured' }; f.attachment.state.grantVersion = 8;
  await f.model.refresh();
  assert.equal(await f.model.releaseCaptured({ requestId: 'captured', grantVersion: 7 }), null);
  f.model.busy = true;
  assert.equal(await f.model.releaseCaptured({ requestId: 'captured', grantVersion: 8 }), null);
  f.model.busy = false; await f.model.refresh(); assert.equal(f.attachment.submissions.length, 0);
});

test("history is a bounded unfiltered page, browsing stays put and latest follows the inbox", async () => {
  const { model, attachment } = fixture();
  await model.refresh();
  assert.equal(model.after, 33);
  assert.deepEqual(model.events.map(e => e.seq), Array.from({ length: 16 }, (_, i) => i + 34));
  assert.ok(model.events.some(e => e.kind === "share-changed"));
  await model.older(); assert.equal(model.after, 17);
  attachment.events.push({ seq: 50, kind: "left", payload: { participantId: "other" } });
  await model.refresh(); assert.equal(model.after, 17);
  await model.newer(); assert.equal(model.after, 33);
  await model.latest(); assert.equal(model.after, 34);
  assert.equal(model.events.at(-1).seq, 50);
  assert.ok(attachment.requests.every(r => r.limit === 16));
  assert.equal(attachment.events.length, 50);
});

test("tab display positions survive reload, remain scoped and never write a replay cursor", async () => {
  const first = fixture(); await first.model.refresh(); await first.model.older();
  const second = fixture(first.attachment, first.saved); await second.model.refresh();
  assert.equal(second.model.after, 17); assert.equal(second.model.followLatest, false);
  assert.equal(second.model.view.cursor.seq, 49);
  assert.equal(second.model.view.cursor.subscriptionRevision, 0);
  assert.equal(first.saved.size, 1);
  const key = [...first.saved.keys()][0];
  assert.match(key, /cluster.*meeting.*me.*0/);
  first.saved.set(key, { after: Number.MAX_SAFE_INTEGER, followLatest: false });
  const invalid = fixture(first.attachment, first.saved); await invalid.model.refresh();
  assert.equal(invalid.model.after, 33);
});

test("overlapping refreshes share one read and navigation waits for the current read", async () => {
  const { model, attachment } = fixture(); await model.refresh();
  const original = attachment.view.bind(attachment); let unblock;
  attachment.view = async (...args) => { await new Promise(resolve => { unblock = resolve; }); return original(...args); };
  const refresh = model.refresh(), duplicate = model.refresh(), older = model.older();
  attachment.view = original; unblock();
  await Promise.all([refresh, duplicate, older]);
  assert.equal(model.after, 17);
});

test("a submit is single-flight, retains the returned ID and obeys a CLI pending leave", async () => {
  const { model, attachment } = fixture(); await model.refresh();
  const first = model.submit({ type: "chat", content: "hello" });
  assert.equal(await model.submit({ type: "chat", content: "duplicate" }), null);
  assert.equal(await first, "command-1");
  assert.equal(attachment.submissions.length, 1);
  assert.equal(model.view.commands[0].id, "command-1");
  attachment.commands.push({ id: "cli-leave", operation: { type: "leave" }, outcome: null });
  await model.refresh(); assert.equal(model.canSubmit, false);
  assert.equal(await model.submit({ type: "chat", content: "after leave" }), null);
});

test("accepted submit waits for a post-acceptance view before enabling another share request", async () => {
  const { model, attachment } = fixture(); await model.refresh();
  const original = attachment.view.bind(attachment);
  let unblock;
  attachment.view = async (...args) => {
    const snapshot = await original(...args);
    await new Promise(resolve => { unblock = resolve; }); return snapshot;
  };
  const reading = model.refresh();
  await Promise.resolve();
  const submitting = model.submit({ type: "request-share" });
  attachment.view = original; unblock();
  await Promise.all([reading, submitting]);
  assert.equal(model.sharePending, true);
  assert.equal(await model.submit({ type: "request-share" }), null);
  assert.equal(attachment.submissions.length, 1);
});

test("failed post-acceptance view keeps actions disabled until shared commands can be inspected", async () => {
  const { model, attachment } = fixture(); await model.refresh();
  const original = attachment.view.bind(attachment);
  attachment.view = async () => { throw new Error("READ_FAILED"); };
  assert.equal(await model.submit({ type: "request-share" }), "command-1");
  assert.equal(model.canSubmit, false);
  assert.equal(await model.submit({ type: "request-share" }), null);
  attachment.view = original; await model.refresh();
  assert.equal(model.sharePending, true); assert.equal(attachment.submissions.length, 1);
});

test("lost submit reply preserves uncertainty through reload and never automatically resubmits", async () => {
  const f = fixture(); await f.model.refresh();
  const submit = f.attachment.submit.bind(f.attachment);
  f.attachment.submit = async operation => { await submit(operation); throw new Error("ATTACHMENT_TIMEOUT"); };
  assert.equal(await f.model.submit({ type: "chat", content: "original contents" }), null);
  assert.ok(f.model.uncertain);
  await f.model.refresh(); assert.equal(f.attachment.submissions.length, 1);
  assert.equal(f.model.view.commands[0].operation.content, "original contents");
  const reloaded = fixture(f.attachment, f.saved); await reloaded.model.refresh();
  assert.ok(reloaded.model.uncertain); assert.equal(reloaded.model.canSubmit, false);
  assert.equal(await reloaded.model.submit({ type: "leave" }), null);
  reloaded.model.reviewUncertain(); assert.equal(reloaded.model.canSubmit, true);
  assert.equal(f.attachment.submissions.length, 1);
});

test("share queue actions bind the observed request and pending commands prevent duplicate requests", async () => {
  const { model, attachment } = fixture();
  attachment.state.queue = [{ participantId: "other", requestId: "first" }, { participantId: "me", requestId: "my-original" }];
  await model.refresh(); assert.equal(model.ownShare.requestId, "my-original");
  assert.equal(model.sharePosition, 2);
  assert.equal(await model.submit({ type: "request-share" }), null);
  assert.equal(await model.submit({ type: "release-share", requestId: "wrong" }), null);
  assert.ok(await model.submit({ type: "release-share", requestId: model.ownShare.requestId }));
  assert.equal(attachment.submissions[0].requestId, "my-original");
  assert.equal(await model.submit({ type: "release-share", requestId: "my-original" }), null);
});

test("capture uses the observed lease revision without retry; closed attachment disables mutations", async () => {
  const { model, attachment } = fixture(); await model.refresh();
  await model.capture("claim");
  assert.equal(attachment.claimedRevision, 2); assert.match(model.error, /STALE_CAPTURE/);
  assert.equal(attachment.submissions.length, 0);
  attachment.close(); assert.equal(model.canSubmit, false);
  assert.equal(await model.submit({ type: "leave" }), null);
});

test("invalid UTF-8 chat size is rejected before submission and disposed reads cannot mutate state", async () => {
  const { model, attachment } = fixture(); await model.refresh();
  assert.equal(await model.submit({ type: "chat", content: "😀".repeat(2049) }), null);
  assert.match(model.error, /8192/); assert.equal(attachment.submissions.length, 0);
  const prior = model.view;
  model.dispose(); await model.refresh(); assert.equal(model.view, prior);
});
