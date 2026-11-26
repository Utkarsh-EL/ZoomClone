import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureController } from '../client/media-capture.js';
import { MediaLab } from '../client/media-lab.js';

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
