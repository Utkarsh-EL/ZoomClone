// Display state only. The participant agent owns identity, pending commands,
// replay and retries. Nothing in this model advances its durable cursor.
export class ParticipantModel extends EventTarget {
  view = null;
  after = 0;
  followLatest = true;
  busy = false;
  paging = false;
  captureBusy = false;
  uncertain = null;
  error = "";
  readFailed = false;
  lastCommandId = null;
  #attachment;
  #load;
  #save;
  #key;
  #refreshing;
  #disposed = false;
  #changed = () => this.#emit();

  constructor(attachment, { load = () => null, save = () => {} } = {}) {
    super(); this.#attachment = attachment; this.#load = load; this.#save = save;
    attachment.addEventListener("close", this.#changed);
    attachment.addEventListener("capturechange", this.#changed);
  }
  get events() { return this.view?.events ?? []; }
  get attached() { return !this.#disposed && this.#attachment.readyState === "attached"; }
  get leaving() { return this.view?.commands.some(c => c.operation.type === "leave" && !c.outcome) ?? false; }
  get left() { return this.view?.left || this.view?.connection === "left"; }
  get canSubmit() { return !!this.view && this.attached && !this.readFailed && !this.busy && !this.uncertain && !this.leaving && !this.left; }
  get state() { return this.view?.observation?.state; }
  get ownShare() {
    const id = this.view?.participantId;
    return [this.state?.holder, ...(this.state?.queue ?? [])].find(r => r?.participantId === id) ?? null;
  }
  get sharePosition() { return this.state?.queue.findIndex(r => r.participantId === this.view?.participantId) + 1 || 0; }
  get sharePending() { return this.view?.commands.some(c => !c.outcome && ["request-share", "release-share"].includes(c.operation.type)) ?? false; }

  #emit() { if (!this.#disposed) this.dispatchEvent(new Event("change")); }
  #persist() {
    if (!this.#key) return;
    // Storage may be disabled/full. In-memory mutation gates still apply.
    try { this.#save(this.#key, { after: this.after, followLatest: this.followLatest, uncertain: this.uncertain }); } catch {}
  }
  refresh() {
    if (this.#disposed || !this.attached) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#read().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }
  async #read() {
    try {
      let after = this.after;
      let { view } = await this.#attachment.view(after, 16);
      if (this.#disposed) return;
      if (!this.#key) {
        this.#key = `zoom.participant-ui:${view.clusterId}:${view.meetingId}:${view.participantId}:0`;
        let saved;
        try { saved = this.#load(this.#key); } catch {}
        if (saved && Number.isSafeInteger(saved.after) && saved.after >= 0 && saved.after <= view.cursor.seq && typeof saved.followLatest === "boolean") {
          this.after = saved.after; this.followLatest = saved.followLatest;
        }
        if (saved?.uncertain === true) this.uncertain = true;
      }
      const desired = this.followLatest ? Math.max(0, view.cursor.seq - 16) : this.after;
      if (after !== desired) { after = desired; ({ view } = await this.#attachment.view(after, 16)); }
      if (this.#disposed) return;
      this.after = after; this.view = view;
      if (this.readFailed) this.error = "";
      this.readFailed = false; this.#persist(); this.#emit();
    } catch (error) { if (!this.#disposed) { this.readFailed = true; this.error = `Unable to refresh shared commands: ${error.message}. Actions are paused until a view is available.`; this.#emit(); } }
  }
  async #navigate(position) {
    if (this.paging || this.#disposed) return;
    this.paging = true; this.#emit();
    try {
      await this.refresh();
      if (this.#disposed) return;
      position(); this.#persist(); await this.refresh();
    } finally { this.paging = false; this.#emit(); }
  }
  older() { return this.#navigate(() => { this.followLatest = false; this.after = Math.max(0, this.after - 16); }); }
  newer() { return this.#navigate(() => { this.followLatest = false; this.after = Math.min(Math.max(0, (this.view?.cursor.seq ?? 0) - 1), this.events.at(-1)?.seq ?? this.after); }); }
  latest() { return this.#navigate(() => { this.followLatest = true; }); }

  async submit(operation) {
    if (!this.canSubmit) return null;
    if (operation.type === "chat" && (!operation.content.trim() || operation.content.includes("\0") || new TextEncoder().encode(operation.content).length > 8192)) {
      this.error = "Enter a message of 1–8192 UTF-8 bytes without null characters."; this.#emit(); return null;
    }
    if (operation.type === "request-share" && (this.ownShare || this.sharePending)) return null;
    if (operation.type === "release-share" && (operation.requestId !== this.ownShare?.requestId || this.sharePending)) return null;
    this.busy = true; this.error = ""; this.#emit();
    // Persist before sending: a reload can interrupt the local acceptance reply.
    this.uncertain = true; this.#persist();
    try {
      const { commandId } = await this.#attachment.submit(operation);
      this.lastCommandId = commandId; this.uncertain = null; this.#persist();
      // A poll may have snapshotted before local acceptance. Drain it, then
      // observe the accepted command before reopening mutation controls.
      await this.#refreshing;
      await this.refresh(); return commandId;
    } catch (error) {
      this.error = `${error.message}. The operation may already be saved. Review commands before trying again.`;
      return null;
    } finally { this.busy = false; this.#persist(); this.#emit(); }
  }
  reviewUncertain() { if (!this.busy) { this.uncertain = null; this.error = ""; this.#persist(); this.#emit(); } }
  async capture(action) {
    if (!this.canSubmit || this.captureBusy) return;
    this.captureBusy = true; this.error = ""; this.#emit();
    const revision = this.#attachment.captureState.revision;
    try {
      if (action === "claim") await this.#attachment.claimCapture(revision);
      else if (action === "release") await this.#attachment.releaseCapture(revision);
    } catch (error) { this.error = `${error.message}. Capture ownership changed; check its current owner before trying again.`; }
    finally { this.captureBusy = false; await this.refresh(); this.#emit(); }
  }
  dispose() {
    this.#disposed = true;
    this.#attachment.removeEventListener("close", this.#changed);
    this.#attachment.removeEventListener("capturechange", this.#changed);
  }
}
