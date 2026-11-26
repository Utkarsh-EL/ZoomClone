// Small capture lifecycle boundary shared by the native feasibility harness.
export class CaptureController {
  tracks = new Map();
  releaseCommandId = null;
  releaseUncertain = false;
  #revision = 0;
  #attempts = new Map();
  constructor(attachment, publish, closeProducer) {
    this.attachment = attachment; this.publish = publish; this.closeProducer = closeProducer;
    attachment.addEventListener('capturechange', () => { if (!attachment.ownsCapture) this.revoke(); });
    attachment.addEventListener('close', () => this.revoke());
  }
  async start(source, acquire, grant) {
    if (!this.attachment.ownsCapture) throw new Error('NOT_CAPTURE_OWNER');
    const revision = this.#revision;
    const attempt = (this.#attempts.get(source) ?? 0) + 1; this.#attempts.set(source, attempt);
    const current = () => revision === this.#revision && attempt === this.#attempts.get(source) && this.attachment.ownsCapture;
    const stream = await acquire();
    const tracks = stream.getTracks();
    if (!current()) { tracks.forEach(t => t.stop()); throw new Error('CAPTURE_REVOKED'); }
    // Only one selected track per source. Stop any additional tracks immediately.
    const [track, ...extra] = tracks; extra.forEach(t => t.stop());
    if (!track) throw new Error('NO_CAPTURE_TRACK');
    await this.#stop(source);
    if (!current()) { track.stop(); throw new Error('CAPTURE_REVOKED'); }
    const entry = { track, grant, producer: null }; this.tracks.set(source, entry);
    track.addEventListener('ended', () => { if (this.tracks.get(source) === entry) void this.stop(source, true); }, { once: true });
    try {
      entry.producer = await this.publish(source, track, grant);
      if (!current() || this.tracks.get(source) !== entry) {
        await this.closeProducer(entry.producer.id).catch(() => {}); track.stop(); throw new Error('CAPTURE_REVOKED');
      }
      return entry.producer.id;
    } catch (error) { track.stop(); if (this.tracks.get(source) === entry) this.tracks.delete(source); throw error; }
  }
  async stop(source, release = false) {
    this.#attempts.set(source, (this.#attempts.get(source) ?? 0) + 1);
    return this.#stop(source, release);
  }
  async #stop(source, release = false) {
    const entry = this.tracks.get(source); if (!entry) return;
    this.tracks.delete(source); entry.track.stop();
    // Persist the exact durable release before waiting for a failed SFU.
    if (release && source === 'screen' && entry.grant && this.attachment.ownsCapture) {
      try { this.releaseCommandId = (await this.attachment.submit({ type: 'release-share', requestId: entry.grant.requestId })).commandId; }
      catch { this.releaseUncertain = true; }
    }
    if (entry.producer) await this.closeProducer(entry.producer.id).catch(() => {});
  }
  revoke() { this.#revision++; for (const source of this.tracks.keys()) void this.stop(source); }
}
