import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParticipantMedia } from '../client/participant-media.js';

function fixture(options = {}) {
  const attachment = new EventTarget(); attachment.readyState = 'attached'; attachment.ownsCapture = true;
  const model = new EventTarget(); model.attached = true; model.canSubmit = true;
  model.view = { participantId: 'me' }; model.state = { members: { me: { joined: true } } };
  const media = new EventTarget(); media.state = 'idle'; let attempts = 0, subscriptions = 0, revoked = 0;
  media.capture = new EventTarget(); media.capture.tracks = new Map(); media.capture.pending = new Set();
  media.capture.reconcile = () => {}; media.capture.revoke = () => { revoked++; };
  media.closeTransports = () => { media.state = 'idle'; };
  media.reconnect = async () => { attempts++; throw new Error('SFU_DOWN'); };
  media.subscribe = async () => { subscriptions++; };
  const timers = [];
  const controller = new ParticipantMedia(model, attachment, media, { schedule: cb => { timers.push(cb); return timers.length; }, cancel() {}, ...options });
  return { model, attachment, media, controller, timers, attempts: () => attempts, subscriptions: () => subscriptions, revoked: () => revoked };
}
test('supervision invokes browser timer cancellation without a controller receiver', async () => {
  const saved = globalThis.clearTimeout;
  globalThis.clearTimeout = function () { assert.equal(this, undefined, 'browser timer must not receive ParticipantMedia as this'); };
  try { const f = fixture({ cancel: undefined }); await f.controller.enable(); f.controller.dispose(); }
  finally { globalThis.clearTimeout = saved; }
});
test('supervision bounds reconnect failures and requires explicit retry after exhaustion', async () => {
  const f = fixture(); await f.controller.enable();
  await f.controller.tick(); await f.controller.tick(); await f.controller.tick();
  assert.equal(f.attempts(), 3); assert.equal(f.controller.exhausted, true);
  await f.controller.enable(); assert.equal(f.attempts(), 4);
  f.controller.dispose();
});
test('supervision is single-flight and pending leave synchronously stops capture and cancels transport rebuild', async () => {
  const f = fixture(); let finish;
  f.media.reconnect = async () => { await new Promise(resolve => { finish = resolve; }); f.media.state = 'ready'; };
  const opening = f.controller.enable(); await f.controller.tick();
  f.model.leaving = true; f.model.dispatchEvent(new Event('change'));
  assert.equal(f.controller.enabled, false); assert.equal(f.revoked(), 1);
  finish(); await opening; assert.equal(f.subscriptions(), 0); f.controller.dispose();
});
