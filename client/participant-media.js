// The browser supervises transient transports only. Snapshots can revoke local
// work; the production runtime/SQL bridge still authorizes every media effect.
export class ParticipantMedia extends EventTarget {
  enabled = false;
  attempts = 0;
  error = '';
  #working = false;
  #disposed = false;
  #timer;
  constructor(model, attachment, media, { schedule = cb => setTimeout(cb, 1500), cancel = timer => clearTimeout(timer) } = {}) {
    super(); Object.assign(this, { model, attachment, media, schedule, cancel });
    this.reconcile = () => {
      media.capture.reconcile(model.view, model.leaving || model.left);
      if (this.enabled && !this.eligible) this.disable();
      this.changed();
    };
    this.update = () => this.changed();
    model.addEventListener('change', this.reconcile);
    media.addEventListener('change', this.update);
    media.capture.addEventListener('change', this.update);
    this.reconcile();
  }
  get eligible() { return !this.#disposed && this.model.attached && !this.model.leaving && !this.model.left && !!this.model.state?.members[this.model.view?.participantId]?.joined; }
  get exhausted() { return this.attempts >= 3 && this.media.state !== 'ready'; }
  get canStart() { return this.enabled && this.eligible && this.model.canSubmit && this.attachment.ownsCapture && this.media.state === 'ready' && !this.#working; }
  changed() { if (!this.#disposed) this.dispatchEvent(new Event('change')); }
  enable() {
    if (!this.eligible) return Promise.resolve();
    this.enabled = true; this.attempts = 0; this.error = ''; return this.tick();
  }
  disable() {
    this.enabled = false; this.cancel(this.#timer); this.media.capture.revoke();
    if (this.media.close) void this.media.close().catch(error => { if (!this.#disposed) { this.error = `Media cleanup unconfirmed: ${error.message}.`; this.changed(); } });
    else this.media.closeTransports();
    this.changed();
  }
  async tick() {
    if (this.#working || !this.enabled || !this.eligible || this.exhausted) return;
    this.cancel(this.#timer); this.#working = true; this.changed();
    try {
      if (this.media.state !== 'ready') { this.attempts++; await this.media.reconnect(); }
      if (!this.enabled || !this.eligible) return;
      await this.media.subscribe();
      if (!this.enabled || !this.eligible) return;
      this.attempts = 0; this.error = '';
    } catch (error) {
      if (this.enabled && this.eligible) { this.error = `${error.message}. ${this.exhausted ? 'Choose Retry media to rebuild.' : 'Media will retry within three attempts.'}`; }
    } finally {
      this.#working = false; this.changed();
      if (this.enabled && this.eligible && !this.exhausted) this.#timer = this.schedule(() => { void this.tick(); });
    }
  }
  async start(source) {
    if (!this.canStart) return;
    const state = this.model.state;
    const grant = source === 'screen' && state.holder?.participantId === this.model.view.participantId
      ? { requestId: state.holder.requestId, grantVersion: state.grantVersion } : undefined;
    if (source === 'screen' && !grant) return;
    this.error = '';
    try { await this.media.start(source, grant); }
    catch (error) {
      if (error.message !== 'CAPTURE_REVOKED' && error.message !== 'MEDIA_CANCELED') {
        const explanations = { NotAllowedError: 'Permission was denied or selection canceled. Allow access in your browser, then try again.', NotFoundError: 'No matching device is available. Connect a device, then try again.', NotReadableError: 'The device is busy or unavailable. Close other capture apps, then try again.' };
        this.error = explanations[error.name] ?? `${error.message}. Check media connection and try again.`;
      }
    } finally { this.changed(); }
  }
  async stop(source) { await this.media.capture.stop(source, source === 'screen'); this.changed(); }
  dispose() {
    this.disable(); this.#disposed = true;
    this.model.removeEventListener('change', this.reconcile);
    this.media.removeEventListener('change', this.update);
    this.media.capture.removeEventListener('change', this.update);
  }
}
