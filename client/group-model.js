// Group display/navigation only. All mutations use ParticipantModel's one
// persisted uncertainty guard; the agent alone owns scoped replay progress.
export class GroupModel extends EventTarget {
  catalog = { groups: [], nextAfter: null }; selectedId = null; history = null;
  after = 0; followLatest = true; catalogAfter = ''; error = ''; failed = false;
  #attachment; #participant; #refreshing; #disposed = false; #catalogStack = []; #navigation = Promise.resolve(); #navigating = 0;
  #changed = () => this.#emit();
  constructor(attachment, participant) {
    super(); this.#attachment = attachment; this.#participant = participant;
    participant.addEventListener('change', this.#changed);
  }
  #emit() { if (!this.#disposed) this.dispatchEvent(new Event('change')); }
  get selected() { return this.catalog.groups.find(g => g.groupId === this.selectedId); }
  get pending() { return this.#participant.view?.commands.some(c => !c.outcome && c.operation.groupId === this.selectedId) ?? false; }
  get canAct() { return this.#participant.canSubmit && !this.failed && this.#navigating === 0; }
  get canPublish() { return this.canAct && !this.pending && this.selected?.membership === 'member' && this.history?.groupId === this.selectedId && this.history?.membership === 'member'; }
  refresh() {
    if (this.#disposed || !this.#participant.attached) return Promise.resolve();
    return this.#refreshing ??= this.#read().finally(() => { this.#refreshing = null; });
  }
  async #read() {
    try {
      const { catalog } = await this.#attachment.groups(this.catalogAfter, 16);
      if (this.#disposed) return;
      this.catalog = catalog;
      if (!this.selectedId || !this.selected) { this.selectedId = catalog.groups[0]?.groupId ?? null; this.after = 0; this.followLatest = true; }
      let history = null;
      if (this.selectedId) {
        ({ history } = await this.#attachment.groupHistory(this.selectedId, this.after, 16));
        const desired = this.followLatest ? Math.max(0, history.cursor - 16) : this.after;
        if (desired !== this.after) { this.after = desired; ({ history } = await this.#attachment.groupHistory(this.selectedId, this.after, 16)); }
      }
      if (this.#disposed) return;
      this.history = history;
      if (this.failed) this.error = '';
      this.failed = false; this.#emit();
    } catch (error) { if (!this.#disposed) { this.failed = true; this.error = `Group history unavailable: ${error.message}. Retained messages remain in your agent; retry after reconnecting.`; this.#emit(); } }
  }
  #navigate(change) {
    this.#navigating++; this.#emit();
    const work = this.#navigation.then(async () => {
      await this.refresh(); if (this.#disposed) return;
      change(); this.history = null; this.#emit(); await this.refresh();
    }).finally(() => { this.#navigating--; this.#emit(); });
    this.#navigation = work.catch(() => {}); return work;
  }
  select(id) { return this.#navigate(() => { this.selectedId = id; this.after = 0; this.followLatest = true; }); }
  older() { return this.#navigate(() => { this.followLatest = false; this.after = Math.max(0, this.after - 16); }); }
  newer() { return this.#navigate(() => { this.followLatest = false; this.after = this.history?.events.at(-1)?.seq ?? this.after; }); }
  latest() { return this.#navigate(() => { this.followLatest = true; }); }
  nextGroups() { return this.#navigate(() => { if (this.catalog.nextAfter) { this.#catalogStack.push(this.catalogAfter); this.catalogAfter = this.catalog.nextAfter; this.selectedId = null; } }); }
  previousGroups() { return this.#navigate(() => { this.catalogAfter = this.#catalogStack.pop() ?? ''; this.selectedId = null; }); }
  #invalid(message) { this.error = message; this.#emit(); return null; }
  async #submit(operation) { const id = await this.#participant.submit(operation); if (id) { this.error = ''; await this.refresh(); } return id; }
  create(name) {
    if (!this.canAct) return Promise.resolve(null);
    if (typeof name !== 'string' || !name.trim() || /[\u0000-\u001f]/.test(name) || new TextEncoder().encode(name).length > 200) return Promise.resolve(this.#invalid('Enter a group name of 1–200 UTF-8 bytes without control characters.'));
    return this.#submit({ type: 'group-create', name });
  }
  send(content) {
    if (!this.canPublish) return Promise.resolve(null);
    if (typeof content !== 'string' || !content.trim() || content.includes('\0') || new TextEncoder().encode(content).length > 8192) return Promise.resolve(this.#invalid('Enter a message of 1–8192 UTF-8 bytes without null characters.'));
    return this.#submit({ type: 'group-chat', groupId: this.selectedId, content });
  }
  invite(participantId) { return this.canPublish ? this.#submit({ type: 'group-invite', groupId: this.selectedId, participantId }) : Promise.resolve(null); }
  join() { return this.canAct && !this.pending && this.selected?.membership === 'invited' ? this.#submit({ type: 'group-join', groupId: this.selectedId, invitationId: this.selected.invitationId }) : Promise.resolve(null); }
  leave() { return this.canPublish ? this.#submit({ type: 'group-leave', groupId: this.selectedId }) : Promise.resolve(null); }
  dispose() { this.#disposed = true; this.#participant.removeEventListener('change', this.#changed); }
}
