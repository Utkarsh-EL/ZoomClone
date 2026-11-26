import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureController } from '../client/media-capture.js';
import { MediaLab } from '../client/media-lab.js';
import { ParticipantMedia } from '../client/participant-media.js';

function fixture() {
  const attachment = new EventTarget(); attachment.ownsCapture = true; attachment.readyState = 'attached';
  const submitted = [], closed = [], published = [];
  attachment.submit = async operation => { submitted.push(operation); return { commandId: 'original-stop' }; };
  const capture = new CaptureController(attachment, async (source, track) => { published.push(source); return { id: source }; }, async id => { closed.push(id); });
  const track = () => { const t = new EventTarget(); t.readyState = 'live'; t.stop = () => { t.readyState = 'ended'; }; return t; };
  return { attachment, capture, submitted, closed, published, track };
}
test('capture permission denial and canceled selection retain no tracks or commands', async () => {
  const f = fixture();
  for (const name of ['NotAllowedError', 'AbortError']) {
    await assert.rejects(f.capture.start('screen', async () => { throw Object.assign(new Error(name), { name }); }, { requestId: 'grant', grantVersion: 1 }), { name });
    assert.equal(f.capture.tracks.size, 0);
  }
  assert.deepEqual(f.submitted, []);
});
test('late capture completion after lease replacement stops every returned track', async () => {
  const f = fixture(), track = f.track(); let finish;
  const start = f.capture.start('camera', () => new Promise(resolve => { finish = resolve; }));
  f.attachment.ownsCapture = false; f.attachment.dispatchEvent(new Event('capturechange'));
  finish({ getTracks: () => [track] });
  await assert.rejects(start, /CAPTURE_REVOKED/);
  assert.equal(track.readyState, 'ended'); assert.deepEqual(f.published, []);
});
test('browser stop-sharing submits one exact original grant release and keeps its ID', async () => {
  const f = fixture(), track = f.track();
  await f.capture.start('screen', async () => ({ getTracks: () => [track] }), { requestId: 'grant', grantVersion: 7 });
  track.dispatchEvent(new Event('ended')); track.dispatchEvent(new Event('ended'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.submitted, [{ type: 'release-share', requestId: 'grant' }]);
  assert.equal(f.capture.releaseCommandId, 'original-stop'); assert.equal(f.capture.tracks.size, 0);
});
test('revocation and local agent close stop capture without releasing the shared grant', async () => {
  const f = fixture(), track = f.track();
  await f.capture.start('screen', async () => ({ getTracks: () => [track] }), { requestId: 'grant', grantVersion: 7 });
  f.attachment.ownsCapture = false; f.attachment.dispatchEvent(new Event('capturechange'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(track.readyState, 'ended'); assert.deepEqual(f.submitted, []); assert.deepEqual(f.closed, ['screen']);
});
test('media retries explicit pre-effect NOT_READY with a bound but never retries uncertain effects', async () => {
  const attachment = new EventTarget(); let calls = 0;
  attachment.media = async () => { if (++calls < 3) throw new Error('NOT_READY'); return { epoch: 'current', value: 'ready' }; };
  const media = new MediaLab(attachment);
  assert.equal(await media.call({ action: 'list' }), 'ready'); assert.equal(calls, 3);
  calls = 0; attachment.media = async () => { calls++; throw new Error('ATTACHMENT_TIMEOUT'); };
  await assert.rejects(media.call({ action: 'produce' }), /ATTACHMENT_TIMEOUT/); assert.equal(calls, 1);
});

test('media may retry certified route lookup rejection before any effect was sent', async () => {
  const attachment = new EventTarget(); let calls = 0;
  attachment.media = async () => { if (++calls === 1) throw new Error('MEDIA_ROUTE_UNAVAILABLE'); return { epoch: 'current', value: 'ready' }; };
  assert.equal(await new MediaLab(attachment).call({ action: 'list' }), 'ready'); assert.equal(calls, 2);
});

test('a bounded media retry window can span two runtime renewal intervals without replaying an effect', async () => {
  const attachment = new EventTarget(), readyAt = performance.now() + 1050; let effects = 0;
  attachment.media = async () => { if (performance.now() < readyAt) throw new Error('NOT_READY'); effects++; return { epoch: 'current', value: 'ready' }; };
  assert.equal(await new MediaLab(attachment).call({ action: 'list' }), 'ready'); assert.equal(effects, 1);
});
test('explicit stop during a pending capture prevents its late completion from publishing', async () => {
  const f = fixture(), track = f.track(); let finish;
  const start = f.capture.start('camera', () => new Promise(resolve => { finish = resolve; }));
  await f.capture.stop('camera'); finish({ getTracks: () => [track] });
  await assert.rejects(start, /CAPTURE_REVOKED/); assert.equal(track.readyState, 'ended'); assert.deepEqual(f.published, []);
});
test('a reconnect publication completing after Stop also closes its server producer', async () => {
  const f = fixture(), track = f.track(), media = new MediaLab(f.attachment), closed = [];
  const entry = { track, grant: null, producer: { id: 'old' } }; media.capture.tracks.set('camera', entry);
  media.open = async () => {}; media.call = async request => { closed.push(request); };
  let finish;
  media.publish = () => new Promise(resolve => { finish = resolve; });
  const reconnect = media.reconnect();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await media.capture.stop('camera');
  finish({ id: 'late', close() {} }); await reconnect;
  assert.ok(closed.some(request => request.action === 'closeProducer' && request.producerId === 'late'));
});

const view = (holder = { participantId: 'me', requestId: 'grant' }, grantVersion = 7) => ({ participantId: 'me', observation: { state: { members: { me: { joined: true } }, holder, grantVersion } } });

test('release review follows the exact observed turn without submitting a deferred command', async () => {
  for (const next of [view(null), view({ participantId: 'other', requestId: 'grant' }), view({ participantId: 'me', requestId: 'next' }), view(undefined, 8)]) {
    const f = fixture(); f.capture.reconcile(view()); f.capture.release = async () => null;
    await f.capture.start('screen', async () => ({ getTracks: () => [f.track()] }), { requestId: 'grant', grantVersion: 7 });
    await f.capture.stop('screen', true);
    assert.equal(f.capture.releaseNeedsReview, true);
    f.capture.reconcile(view()); assert.equal(f.capture.releaseNeedsReview, true);
    f.capture.reconcile(next); assert.equal(f.capture.releaseNeedsReview, false);
    assert.deepEqual(f.submitted, []);
  }
});

test('only an installed later screen clears applicable review, not camera or canceled selection', async () => {
  const f = fixture(); f.capture.reconcile(view()); f.capture.release = async () => { throw new Error('TIMEOUT'); };
  const start = source => f.capture.start(source, async () => ({ getTracks: () => [f.track()] }), source === 'screen' ? { requestId: 'grant', grantVersion: 7 } : undefined);
  await start('screen'); await f.capture.stop('screen', true);
  assert.equal(f.capture.releaseNeedsReview, true); assert.equal(f.capture.releaseUncertain, true);
  await start('camera'); assert.equal(f.capture.releaseNeedsReview, true);
  await assert.rejects(f.capture.start('screen', async () => { throw new Error('CANCELED'); }, { requestId: 'grant', grantVersion: 7 }), /CANCELED/);
  assert.equal(f.capture.releaseNeedsReview, true);
  await start('screen');
  assert.equal(f.capture.releaseNeedsReview, false); assert.equal(f.capture.releaseUncertain, false);
  assert.equal(f.capture.tracks.get('screen').track.readyState, 'live');
  assert.deepEqual(f.submitted, []); f.capture.revoke();
});

test('late declined or uncertain release cannot restore review after turn resolution or later capture', async () => {
  for (const transition of ['resolved', 'capture']) for (const outcome of ['declined', 'uncertain']) {
    const f = fixture(); f.capture.reconcile(view()); let finish;
    f.capture.release = () => new Promise((resolve, reject) => { finish = () => outcome === 'declined' ? resolve(null) : reject(new Error('TIMEOUT')); });
    const start = () => f.capture.start('screen', async () => ({ getTracks: () => [f.track()] }), { requestId: 'grant', grantVersion: 7 });
    await start(); const stopped = f.capture.stop('screen', true);
    if (transition === 'resolved') f.capture.reconcile(view(null)); else await start();
    finish(); await stopped;
    assert.equal(f.capture.releaseNeedsReview, false, `${transition}/${outcome}`);
    assert.equal(f.capture.releaseUncertain, false);
    assert.deepEqual(f.submitted, []); f.capture.revoke();
  }
});

test('an old release acceptance cannot overwrite a newer release needing review', async () => {
  const f = fixture(); f.capture.reconcile(view()); let finish;
  f.capture.release = () => new Promise(resolve => { finish = resolve; });
  const start = () => f.capture.start('screen', async () => ({ getTracks: () => [f.track()] }), { requestId: 'grant', grantVersion: 7 });
  await start(); const first = f.capture.stop('screen', true);
  await start(); f.capture.release = async () => null; await f.capture.stop('screen', true);
  assert.equal(f.capture.releaseNeedsReview, true);
  finish('old-command'); await first;
  assert.equal(f.capture.releaseNeedsReview, true); assert.equal(f.capture.releaseCommandId, null);
});

test('turn resolution before or after acceptance preserves the original release command ID', async () => {
  for (const beforeAcceptance of [true, false]) {
    const f = fixture(); f.capture.reconcile(view());
    f.capture.release = async () => {
      if (beforeAcceptance) f.capture.reconcile(view(null));
      return 'saved-original-release';
    };
    await f.capture.start('screen', async () => ({ getTracks: () => [f.track()] }), { requestId: 'grant', grantVersion: 7 });
    await f.capture.stop('screen', true);
    if (!beforeAcceptance) f.capture.reconcile(view(null));
    assert.equal(f.capture.releaseNeedsReview, false);
    assert.equal(f.capture.releaseCommandId, 'saved-original-release');
  }
});

test('grant replacement cancels pending screen permission and stops only the old screen', async () => {
  const f = fixture(), screen = f.track(), camera = f.track(); let finish;
  f.capture.reconcile(view());
  await f.capture.start('camera', async () => ({ getTracks: () => [camera] }));
  const start = f.capture.start('screen', () => new Promise(resolve => { finish = resolve; }), { requestId: 'grant', grantVersion: 7 });
  f.capture.reconcile(view({ participantId: 'me', requestId: 'next' }, 8));
  finish({ getTracks: () => [screen] }); await assert.rejects(start, /CAPTURE_REVOKED/);
  assert.equal(screen.readyState, 'ended'); assert.equal(camera.readyState, 'live'); assert.deepEqual(f.submitted, []);
  f.capture.reconcile({ ...view(), left: true }); assert.equal(camera.readyState, 'ended');
});
test('lease revision change cancels pending permission even when the same tab owns capture again', async () => {
  const f = fixture(), track = f.track(); let finish;
  f.attachment.captureState = { revision: 1 };
  const start = f.capture.start('mic', () => new Promise(resolve => { finish = resolve; }));
  f.attachment.captureState = { revision: 3 }; f.attachment.dispatchEvent(new Event('capturechange'));
  finish({ getTracks: () => [track] }); await assert.rejects(start, /CAPTURE_REVOKED/);
  assert.equal(track.readyState, 'ended');
});
test('membership loss cancels all capture without releasing a shared grant', async () => {
  const f = fixture(), track = f.track(); f.capture.reconcile(view());
  await f.capture.start('screen', async () => ({ getTracks: () => [track] }), { requestId: 'grant', grantVersion: 7 });
  const departed = view(); departed.observation.state.members.me.joined = false;
  f.capture.reconcile(departed); await new Promise(resolve => setImmediate(resolve));
  assert.equal(track.readyState, 'ended'); assert.deepEqual(f.submitted, []);
});
test('overlapping opens serialize server effects and late replies cannot install transports', async () => {
  const attachment = new EventTarget(); attachment.readyState = 'attached';
  let finish, calls = 0; const transports = [];
  attachment.media = async () => { calls++; if (calls === 1) await new Promise(resolve => { finish = resolve; }); return { epoch: `epoch-${calls}`, value: { rtpCapabilities: {}, send: {}, recv: {} } }; };
  class FakeDevice {
    async load() {};
    createSendTransport() { const t = { on() {}, close() { this.closed = true; } }; transports.push(t); return t; }
    createRecvTransport() { return this.createSendTransport(); }
  }
  const media = new MediaLab(attachment, { Device: FakeDevice });
  const first = media.open(); const rejected = assert.rejects(first, /MEDIA_CANCELED/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const second = media.open(); assert.equal(calls, 1); finish(); await rejected; await second;
  assert.equal(media.epoch, 'epoch-2'); assert.equal(transports.length, 2); assert.equal(media.state, 'ready');
});
test('close during Device.load invalidates the open and never creates transports', async () => {
  const attachment = new EventTarget(); attachment.readyState = 'attached'; let finish, creates = 0;
  attachment.media = async () => ({ epoch: 'epoch', value: { rtpCapabilities: {} } });
  class FakeDevice { load() { return new Promise(resolve => { finish = resolve; }); } createSendTransport() { creates++; } }
  const media = new MediaLab(attachment, { Device: FakeDevice }), opening = media.open();
  for (let i = 0; !finish && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(finish, 'Device.load reached'); media.closeTransports(); finish(); await assert.rejects(opening, /MEDIA_CANCELED/); assert.equal(creates, 0);
});
test('explicit media close drains a late open before a successor can reopen the peer', async () => {
  const attachment = new EventTarget(); attachment.readyState = 'attached'; let finish; const actions = [];
  attachment.media = async request => {
    actions.push(request.action);
    if (actions.length === 1) await new Promise(resolve => { finish = resolve; });
    return { epoch: 'epoch', value: { rtpCapabilities: {}, send: {}, recv: {} } };
  };
  class FakeDevice { async load() {} createSendTransport() { return { on() {}, close() {} }; } createRecvTransport() { return this.createSendTransport(); } }
  const media = new MediaLab(attachment, { Device: FakeDevice }), first = media.open();
  const canceled = assert.rejects(first, /MEDIA_CANCELED/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof media.close, 'function');
  const closing = media.close(), second = media.open(); finish();
  await canceled; await closing; await second;
  assert.deepEqual(actions, ['open', 'closePeer', 'open']); assert.equal(media.state, 'ready');
});
test('producer polling is single-flight and stale transport callbacks cannot signal a new peer', async () => {
  const attachment = new EventTarget(); attachment.readyState = 'attached'; const actions = [], transports = [];
  let finish;
  attachment.view = () => new Promise(resolve => { finish = resolve; });
  attachment.media = async request => { actions.push(request.action); return { epoch: 'epoch', value: request.action === 'list' ? [] : { rtpCapabilities: {}, send: {}, recv: {} } }; };
  class FakeDevice {
    async load() {};
    createSendTransport() { const handlers = {}; const t = { on(event, handler) { handlers[event] = handler; }, close() {}, handlers }; transports.push(t); return t; }
    createRecvTransport() { return this.createSendTransport(); }
  }
  const media = new MediaLab(attachment, { Device: FakeDevice }); await media.open();
  const first = media.subscribe(), second = media.subscribe();
  assert.equal(first, second); finish({ view: { participantId: 'me' } }); await first;
  await media.open();
  const rejected = new Promise(resolve => transports[0].handlers.connect({ dtlsParameters: {} }, () => assert.fail('stale callback completed'), resolve));
  assert.match((await rejected).message, /MEDIA_CANCELED/);
  transports[0].handlers.connectionstatechange('failed'); assert.equal(media.state, 'ready');
  assert.deepEqual(actions, ['open', 'list', 'open']);
});
test('pending playback cannot hold polling or prevent a failed transport from exhausting rebuilds', async t => {
  const savedDocument = globalThis.document, savedStream = globalThis.MediaStream;
  t.after(() => { globalThis.document = savedDocument; globalThis.MediaStream = savedStream; });
  globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, play: () => new Promise(() => {}) }) };
  globalThis.MediaStream = class {};
  const attachment = new EventTarget(); attachment.readyState = 'attached'; attachment.view = async () => ({ view: { participantId: 'me' } });
  let opens = 0; const transports = [];
  attachment.media = async request => {
    if (request.action === 'open') opens++;
    return { epoch: 'epoch', value: request.action === 'list' ? [{ id: 'remote', participantId: 'other', source: 'camera' }] : { rtpCapabilities: {}, send: {}, recv: {} } };
  };
  class FakeDevice {
    async load() {};
    createSendTransport() { const handlers = {}; const transport = { connectionState: 'connecting', on(event, handler) { handlers[event] = handler; }, handlers, close() {}, async consume() { return { id: 'consumer', kind: 'video', track: {}, close() {} }; } }; transports.push(transport); return transport; }
    createRecvTransport() { return this.createSendTransport(); }
  }
  const model = new EventTarget(); model.attached = true; model.view = view(); model.state = model.view.observation.state;
  const media = new MediaLab(attachment, { Device: FakeDevice, container: { append() {} } });
  const controller = new ParticipantMedia(model, attachment, media, { schedule() {}, cancel() {} });
  t.after(() => controller.dispose());
  const started = controller.enable();
  assert.equal(await Promise.race([started.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('blocked'), 40))]), 'settled');
  assert.equal(media.healthy, false);
  for (let i = 0; i < 3; i++) { transports.at(-1).handlers.connectionstatechange('failed'); await controller.tick(); }
  assert.equal(opens, 3); assert.equal(controller.exhausted, true);
});
test('late playback rejection cannot override a later mute choice', async () => {
  const attachment = new EventTarget(); let reject;
  const media = new MediaLab(attachment);
  media.consumers.set('remote', { close() {}, element: { muted: true, remove() {}, play: () => new Promise((_, fail) => { reject = fail; }) } });
  const playing = media.play(); media.mute(); reject(new Error('NotAllowedError')); await playing;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(media.playback, 'muted');
});
