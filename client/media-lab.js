import { Device } from 'mediasoup-client';
import { CaptureController } from './media-capture.js';

/** Opt-in feasibility API, loaded only by the media harness. No identity, join,
 * grant or uncertain command is invented here. Capture is always explicit. */
export class MediaLab {
  state = 'idle';
  epoch = null;
  consumers = new Map();
  producers = new Map();
  constructor(attachment) {
    this.attachment = attachment;
    this.capture = new CaptureController(attachment, (source, track, grant) => this.publish(source, track, grant), id => this.closeProducer(id));
    attachment.addEventListener('close', () => this.closeTransports());
  }
  async call(request, opening = false) {
    const retryUntil = performance.now() + 4000;
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await this.attachment.media({ ...request, ...(!opening ? { epoch: this.epoch } : {}) });
        if (!opening && this.epoch && reply.epoch !== this.epoch) throw new Error('SFU_RESTARTED');
        if (opening) this.epoch = reply.epoch;
        return reply.value;
      } catch (error) {
        // The adapter reports NOT_READY only before any SFU effect. Renewal
        // deliberately drops readiness briefly; don't phase-lock onto it.
        if (['NOT_READY', 'MEDIA_ROUTE_UNAVAILABLE'].includes(error.message) && attempt < 63 && performance.now() < retryUntil) { await new Promise(resolve => setTimeout(resolve, 15 + Math.floor(Math.random() * 46))); continue; }
        this.state = 'unavailable'; throw error;
      }
    }
  }
  closeTransports() {
    this.send?.close(); this.recv?.close();
    for (const consumer of this.consumers.values()) { consumer.close(); consumer.element?.remove(); }
    this.consumers.clear(); this.producers.clear();
  }
  async open() {
    this.closeTransports(); this.state = 'connecting';
    const options = await this.call({ action: 'open' }, true);
    this.device = new Device(); await this.device.load({ routerRtpCapabilities: options.rtpCapabilities });
    this.send = this.device.createSendTransport(options.send); this.recv = this.device.createRecvTransport(options.recv);
    for (const [direction, transport] of [['send', this.send], ['recv', this.recv]]) {
      transport.on('connect', ({ dtlsParameters }, done, fail) => { this.call({ action: 'connect', direction, dtlsParameters }).then(done, fail); });
      transport.on('connectionstatechange', state => { if (['failed', 'closed', 'disconnected'].includes(state)) this.state = 'unavailable'; });
    }
    this.send.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
      this.call({ action: 'produce', kind, rtpParameters, ...appData }).then(done, fail);
    });
    this.state = 'ready';
  }
  async publish(source, track, grant) {
    const producer = await this.send.produce({ track, stopTracks: false, appData: { source, ...grant } });
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
  async subscribe() {
    const view = await this.attachment.view(), id = view.view.participantId;
    const producers = await this.call({ action: 'list' });
    for (const producer of producers) {
      if (producer.participantId === id || this.consumers.has(producer.id)) continue;
      const options = await this.call({ action: 'consume', producerId: producer.id, rtpCapabilities: this.device.recvRtpCapabilities ?? this.device.rtpCapabilities });
      const consumer = await this.recv.consume(options); consumer.source = producer.source;
      const element = document.createElement(consumer.kind === 'video' ? 'video' : 'audio');
      element.autoplay = true; element.muted = true; element.srcObject = new MediaStream([consumer.track]); document.body.append(element);
      consumer.element = element; this.consumers.set(producer.id, consumer);
      await this.call({ action: 'resume', consumerId: consumer.id }); await element.play();
    }
    for (const [id, consumer] of this.consumers) if (!producers.some(p => p.id === id)) { consumer.close(); consumer.element.remove(); this.consumers.delete(id); }
    return producers;
  }
  async stats() {
    const values = [];
    for (const consumer of this.consumers.values()) {
      for (const stat of (await consumer.getStats()).values()) if (stat.type === 'inbound-rtp') values.push({ kind: consumer.kind, source: consumer.source, bytes: stat.bytesReceived, frames: stat.framesDecoded ?? 0 });
    }
    return values;
  }
  async reconnect() {
    const retained = [...this.capture.tracks.entries()].map(([source, entry]) => ({ source, track: entry.track, grant: entry.grant }));
    await this.open();
    for (const { source, track, grant } of retained) {
      if (!this.attachment.ownsCapture || track.readyState !== 'live') continue;
      const producer = await this.publish(source, track, grant);
      const entry = this.capture.tracks.get(source);
      if (entry?.track === track && this.attachment.ownsCapture) entry.producer = producer;
      else { producer.close(); track.stop(); await this.closeProducer(producer.id).catch(() => {}); }
    }
  }
}
