import { Device } from 'mediasoup-client';
import { CaptureController } from './media-capture.js';

/** Transient media only. All effects use the existing production attachment. */
export class MediaLab extends EventTarget {
  state = 'idle';
  epoch = null;
  consumers = new Map();
  producers = new Map();
  playback = 'muted';
  #revision = 0;
  #openTail = Promise.resolve();
  #subscribing;
  #playRevision = 0;
  #sound = false;
  constructor(attachment, { Device: DeviceClass = Device, release, container } = {}) {
    super(); this.Device = DeviceClass; this.container = container;
    this.attachment = attachment;
    this.capture = new CaptureController(attachment, (source, track, grant) => this.publish(source, track, grant), id => this.closeProducer(id), release);
    attachment.addEventListener('close', () => this.closeTransports());
  }
  changed() { this.dispatchEvent(new Event('change')); }
  setState(state) { this.state = state; this.changed(); }
  current(revision) { return revision === this.#revision && this.attachment.readyState !== 'closed'; }
  check(revision) { if (!this.current(revision)) throw new Error('MEDIA_CANCELED'); }
  get healthy() {
    return this.state === 'ready'
      && (!(this.capture.tracks.size || this.producers.size) || this.send?.connectionState === 'connected')
      && (!this.consumers.size || this.recv?.connectionState === 'connected');
  }
  async call(request, opening = false, revision = this.#revision, epoch = this.epoch) {
    const retryUntil = performance.now() + 4000;
    for (let attempt = 0; ; attempt++) {
      try {
        this.check(revision);
        const reply = await this.attachment.media({ ...request, ...(!opening ? { epoch } : {}) });
        this.check(revision);
        if (!opening && epoch && reply.epoch !== epoch) throw new Error('SFU_RESTARTED');
        if (opening) this.epoch = reply.epoch;
        return reply.value;
      } catch (error) {
        // The adapter reports NOT_READY only before any SFU effect. Renewal
        // deliberately drops readiness briefly; don't phase-lock onto it.
        this.check(revision);
        if (['NOT_READY', 'MEDIA_ROUTE_UNAVAILABLE'].includes(error.message) && attempt < 63 && performance.now() < retryUntil) { await new Promise(resolve => setTimeout(resolve, 15 + Math.floor(Math.random() * 46))); continue; }
        this.setState('unavailable'); throw error;
      }
    }
  }
  closeTransports() {
    this.#revision++; this.#disposeTransports(); this.setState('idle');
  }
  close() {
    this.closeTransports();
    // Queue teardown behind an admitted open and ahead of any later reopen.
    // Attachment shutdown has its own agent-side drain when the socket closes.
    const work = this.#openTail.then(async () => {
      if (this.attachment.readyState !== 'closed') await this.attachment.media({ action: 'closePeer' });
    });
    this.#openTail = work.catch(() => {}); return work;
  }
  #disposeTransports() {
    this.#playRevision++; this.playback = this.#sound ? 'starting' : 'muted';
    this.send?.close(); this.recv?.close();
    for (const consumer of this.consumers.values()) { consumer.close(); consumer.element?.remove(); }
    this.consumers.clear(); this.producers.clear(); this.send = null; this.recv = null; this.#subscribing = null;
  }
  open() {
    const revision = ++this.#revision;
    this.#disposeTransports(); this.setState('connecting');
    const work = this.#openTail.then(async () => {
      this.check(revision);
      const options = await this.call({ action: 'open' }, true, revision);
      const device = new this.Device(); await device.load({ routerRtpCapabilities: options.rtpCapabilities }); this.check(revision);
      const send = device.createSendTransport(options.send), recv = device.createRecvTransport(options.recv), epoch = this.epoch;
      this.device = device; this.send = send; this.recv = recv;
      for (const [direction, transport] of [['send', send], ['recv', recv]]) {
        transport.on('connect', ({ dtlsParameters }, done, fail) => { this.call({ action: 'connect', direction, dtlsParameters }, false, revision, epoch).then(done, fail); });
        transport.on('connectionstatechange', state => { if (this.current(revision) && ['failed', 'closed', 'disconnected'].includes(state)) this.setState('unavailable'); });
      }
      send.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
        this.call({ action: 'produce', kind, rtpParameters, ...appData }, false, revision, epoch).then(done, fail);
      });
      this.setState('ready');
    }).catch(error => { if (this.current(revision)) this.setState('unavailable'); throw error; });
    this.#openTail = work.catch(() => {}); return work;
  }
  async publish(source, track, grant) {
    const revision = this.#revision, send = this.send, epoch = this.epoch;
    if (!send) throw new Error('MEDIA_NOT_READY');
    const producer = await send.produce({ track, stopTracks: false, appData: { source, ...grant } });
    if (!this.current(revision) || this.send !== send) {
      producer.close();
      // Never address a successor peer with an old callback. Opens are ordered
      // after prior signaling; a same-epoch reopen closes that old peer itself.
      if (this.current(revision)) await this.call({ action: 'closeProducer', producerId: producer.id }, false, revision, epoch).catch(() => {});
      throw new Error('MEDIA_CANCELED');
    }
    this.producers.set(producer.id, producer); return producer;
  }
  async closeProducer(id) {
    this.producers.get(id)?.close(); this.producers.delete(id);
    await this.call({ action: 'closeProducer', producerId: id });
  }
  start(source, grant) {
    const acquire = source === 'screen'
      ? () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      : () => navigator.mediaDevices.getUserMedia({ video: source === 'camera' ? { width: 320, height: 240, frameRate: 10 } : false, audio: source === 'mic' });
    return this.capture.start(source, acquire, grant);
  }
  subscribe() {
    if (this.#subscribing) return this.#subscribing;
    const work = this.#subscribe().finally(() => { if (this.#subscribing === work) this.#subscribing = null; });
    this.#subscribing = work; return work;
  }
  async #subscribe() {
    const revision = this.#revision, recv = this.recv, device = this.device;
    const view = await this.attachment.view(), id = view.view.participantId; this.check(revision);
    const producers = await this.call({ action: 'list' }, false, revision);
    for (const producer of producers) {
      if (producer.participantId === id || this.consumers.has(producer.id)) continue;
      const options = await this.call({ action: 'consume', producerId: producer.id, rtpCapabilities: device.recvRtpCapabilities ?? device.rtpCapabilities }, false, revision);
      const consumer = await recv.consume(options);
      if (!this.current(revision)) { consumer.close(); throw new Error('MEDIA_CANCELED'); } consumer.source = producer.source;
      const element = document.createElement(consumer.kind === 'video' ? 'video' : 'audio');
      element.autoplay = true; element.muted = !this.#sound; element.playsInline = true; element.controls = consumer.kind === 'video'; element.setAttribute('aria-label', `Remote ${producer.source}`);
      element.srcObject = new MediaStream([consumer.track]); (this.container ?? document.body).append(element);
      consumer.element = element; this.consumers.set(producer.id, consumer);
      await this.call({ action: 'resume', consumerId: consumer.id }, false, revision);
      void this.#playElement(element);
      this.check(revision);
    }
    for (const [id, consumer] of this.consumers) if (!producers.some(p => p.id === id)) { consumer.close(); consumer.element.remove(); this.consumers.delete(id); }
    this.changed(); return producers;
  }
  #playElement(element) {
    const revision = this.#revision, intent = this.#playRevision;
    let playback;
    try { playback = element.play(); } catch (error) { playback = Promise.reject(error); }
    return Promise.resolve(playback).then(() => {
      if (this.current(revision) && intent === this.#playRevision && this.#sound && this.playback !== 'blocked') { this.playback = 'playing'; this.changed(); }
      return true;
    }, () => {
      if (this.current(revision) && intent === this.#playRevision) { this.playback = 'blocked'; this.changed(); }
      return false;
    });
  }
  play() {
    this.#playRevision++; this.#sound = true; this.playback = 'starting';
    for (const consumer of this.consumers.values()) { consumer.element.muted = false; void this.#playElement(consumer.element); }
    this.changed();
  }
  mute() { this.#playRevision++; this.#sound = false; this.playback = 'muted'; for (const consumer of this.consumers.values()) consumer.element.muted = true; this.changed(); }
  async stats() {
    const values = [];
    for (const consumer of this.consumers.values()) {
      for (const stat of (await consumer.getStats()).values()) if (stat.type === 'inbound-rtp') values.push({ kind: consumer.kind, source: consumer.source, bytes: stat.bytesReceived, frames: stat.framesDecoded ?? 0 });
    }
    return values;
  }
  async reconnect() {
    const retained = [...this.capture.tracks.entries()];
    await this.open();
    const revision = this.#revision;
    for (const [source, entry] of retained) {
      this.check(revision);
      if (!this.capture.current(source, entry)) continue;
      const producer = await this.publish(source, entry.track, entry.grant);
      if (this.current(revision) && this.capture.current(source, entry)) entry.producer = producer;
      else { producer.close(); entry.track.stop(); if (this.current(revision)) await this.closeProducer(producer.id).catch(() => {}); }
    }
    this.changed();
  }
}
