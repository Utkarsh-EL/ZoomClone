// Small capture lifecycle boundary shared by the native feasibility harness.
export class CaptureController extends EventTarget {
  tracks = new Map();
  #releaseAttempt;
  get releaseCommandId() { return this.#releaseAttempt?.commandId ?? null; }
  get releaseUncertain() { return !!(this.#releaseAttempt?.relevant && this.#releaseAttempt.uncertain); }
  get releaseNeedsReview() { return !!(this.#releaseAttempt?.relevant && this.#releaseAttempt.needsReview); }
  #revision = 0;
  #attempts = new Map();
  #pending = new Map();
  #view;
  #leaving = false;
  constructor(attachment, publish, closeProducer, release) {
    super();
    this.attachment = attachment; this.publish = publish; this.closeProducer = closeProducer;
    this.release = release ?? (async grant => (await attachment.submit({ type: 'release-share', requestId: grant.requestId })).commandId);
    let lease = attachment.captureState?.revision;
    attachment.addEventListener('capturechange', () => {
      if (!attachment.ownsCapture || lease !== attachment.captureState?.revision) this.revoke();
      lease = attachment.captureState?.revision;
    });
    attachment.addEventListener('close', () => this.revoke());
  }
  changed() { this.dispatchEvent(new Event('change')); }
  allowed(source, grant) {
    if (this.#leaving) return false;
    if (!this.#view) return true; // Standalone native feasibility API.
    const v = this.#view, state = v.observation?.state;
    if (v.left || v.connection === 'left' || !state?.members[v.participantId]?.joined) return false;
    return source !== 'screen' || (state.holder?.participantId === v.participantId && state.holder.requestId === grant?.requestId && state.grantVersion === grant?.grantVersion);
  }
  reconcile(view, leaving = false) {
    this.#view = view; this.#leaving = leaving;
    if (this.#releaseAttempt?.relevant && !this.allowed('screen', this.#releaseAttempt.grant)) {
      // Keep the original command ID observable even when the post-submit
      // refresh resolves the turn before its acceptance reply reaches us.
      this.#releaseAttempt.relevant = false; this.changed();
    }
    for (const [source, grant] of this.#pending) if (!this.allowed(source, grant)) void this.stop(source);
    for (const [source, entry] of this.tracks) if (!this.allowed(source, entry.grant)) void this.stop(source);
  }
  current(source, entry) {
    return this.tracks.get(source) === entry && this.attachment.ownsCapture && entry.track.readyState === 'live'
      && entry.leaseRevision === this.attachment.captureState?.revision && this.allowed(source, entry.grant);
  }
  async start(source, acquire, grant) {
    if (!this.attachment.ownsCapture) throw new Error('NOT_CAPTURE_OWNER');
    if (!this.allowed(source, grant)) throw new Error('CAPTURE_REVOKED');
    grant = grant ? { ...grant } : grant;
    const revision = this.#revision;
    const lease = this.attachment.captureState?.revision;
    const attempt = (this.#attempts.get(source) ?? 0) + 1; this.#attempts.set(source, attempt);
    const current = () => revision === this.#revision && attempt === this.#attempts.get(source) && this.attachment.ownsCapture && lease === this.attachment.captureState?.revision && this.allowed(source, grant);
    this.#pending.set(source, grant); this.changed();
    let stream;
    try { stream = await acquire(); }
    finally { if (attempt === this.#attempts.get(source)) this.#pending.delete(source); this.changed(); }
    const tracks = stream.getTracks();
    if (!current()) { tracks.forEach(t => t.stop()); throw new Error('CAPTURE_REVOKED'); }
    // Only one selected track per source. Stop any additional tracks immediately.
    const [track, ...extra] = tracks; extra.forEach(t => t.stop());
    if (!track) throw new Error('NO_CAPTURE_TRACK');
    await this.#stop(source);
    if (!current()) { track.stop(); throw new Error('CAPTURE_REVOKED'); }
    const entry = { track, grant, producer: null, leaseRevision: lease };
    // A new selected display supersedes review of a previously stopped one.
    // Canceled permission and unrelated sources leave that review intact.
    if (source === 'screen') this.#releaseAttempt = null;
    this.tracks.set(source, entry); this.changed();
    track.addEventListener('ended', () => { if (this.tracks.get(source) === entry) void this.stop(source, true); }, { once: true });
    try {
      entry.producer = await this.publish(source, track, grant);
      if (!current() || this.tracks.get(source) !== entry) {
        await this.closeProducer(entry.producer.id).catch(() => {}); track.stop(); throw new Error('CAPTURE_REVOKED');
      }
      this.changed(); return entry.producer.id;
    } catch (error) { track.stop(); if (this.tracks.get(source) === entry) this.tracks.delete(source); this.changed(); throw error; }
  }
  async stop(source, release = false) {
    this.#attempts.set(source, (this.#attempts.get(source) ?? 0) + 1);
    this.#pending.delete(source); this.changed();
    return this.#stop(source, release);
  }
  async #stop(source, release = false) {
    const entry = this.tracks.get(source); if (!entry) return;
    this.tracks.delete(source); entry.track.stop(); this.changed();
    // Persist the exact durable release before waiting for a failed SFU.
    if (release && source === 'screen' && entry.grant && this.attachment.ownsCapture) {
      const attempt = { grant: entry.grant, commandId: null, uncertain: false, needsReview: false, relevant: this.allowed('screen', entry.grant) };
      this.#releaseAttempt = attempt;
      // Settle only this attempt. Reconciliation or a later display/release can
      // supersede its status while the shared command acceptance is in flight.
      try { attempt.commandId = await this.release(entry.grant); attempt.needsReview = !attempt.commandId; }
      catch { attempt.uncertain = true; attempt.needsReview = true; }
      this.changed();
    }
    if (entry.producer) await this.closeProducer(entry.producer.id).catch(() => {});
  }
  get pending() { return new Set(this.#pending.keys()); }
  revoke() { this.#revision++; this.#pending.clear(); for (const source of this.tracks.keys()) void this.stop(source); this.changed(); }
}
