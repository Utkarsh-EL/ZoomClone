import { GroupModel } from '/group-model.js';

export function mountGroups(attachment, participant, participantName) {
  const model = new GroupModel(attachment, participant), $ = id => document.getElementById(id);
  const node = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const drafts = new Map(); let displayed = null, catalogSignature = '', memberSignature = '', historySignature = '';
  function render() {
    const catalog = model.catalog, selected = model.selected, history = model.history;
    const signature = JSON.stringify([catalog.groups, model.selectedId]);
    if (signature !== catalogSignature) {
      catalogSignature = signature;
      $('group-select').replaceChildren(...(catalog.groups.length ? catalog.groups.map(g => {
        const option = node('option', `${g.name} · ${g.membership === 'member' ? 'joined' : g.membership === 'invited' ? 'invitation' : 'left · retained'}`); option.value = g.groupId; return option;
      }) : [node('option', 'No groups or invitations yet')]));
      if (model.selectedId) $('group-select').value = model.selectedId;
    }
    if (displayed !== model.selectedId) {
      if (displayed) drafts.set(displayed, $('group-input').value);
      displayed = model.selectedId; $('group-input').value = drafts.get(displayed) ?? '';
    }
    const members = Object.entries(participant.state?.members ?? {}).filter(([id, m]) => m.joined && id !== participant.view?.participantId);
    const roster = JSON.stringify(members);
    if (roster !== memberSignature) {
      memberSignature = roster; const previous = $('group-invite-person').value;
      $('group-invite-person').replaceChildren(...members.map(([id, member]) => { const option = node('option', member.name); option.value = id; return option; }));
      if (members.some(([id]) => id === previous)) $('group-invite-person').value = previous;
    }
    $('group-select').disabled = !model.catalog.groups.length;
    $('groups-previous').disabled = !model.catalogAfter;
    $('groups-next').disabled = !catalog.nextAfter;
    $('group-name').disabled = !model.canAct; $('group-create').disabled = !model.canAct || !$('group-name').value.trim();
    $('group-input').disabled = !model.canPublish; $('group-send').disabled = !model.canPublish || !$('group-input').value.trim();
    $('group-invite-person').disabled = !model.canPublish || !members.length;
    $('group-invite').disabled = !model.canPublish || !members.length;
    $('group-join').hidden = selected?.membership !== 'invited'; $('group-join').disabled = !model.canAct || model.pending;
    $('group-leave').hidden = selected?.membership !== 'member'; $('group-leave').disabled = !model.canPublish;
    $('group-error').hidden = !model.error; text('group-error', model.error);
    text('group-status', !selected ? 'Create a group or wait for an invitation from a meeting participant.' : model.pending ? 'Group command pending. Its original outcome appears below.'
      : selected.membership === 'invited' ? 'You are invited. Accept to subscribe and read earlier group history.'
      : selected.membership === 'left' || participant.left ? 'You have left. This is downloaded history; future messages and server history are unavailable.'
      : 'Joined · subscribed to this group. Current members can read earlier messages.');
    text('group-message-label', selected ? `Message ${selected.name}` : 'Message the selected group');
    const events = history?.events ?? [], nextSignature = JSON.stringify([events, participant.state?.members]);
    if (historySignature !== nextSignature) {
      historySignature = nextSignature;
      $('group-history').replaceChildren(...(events.length ? events.map(e => {
        const li = document.createElement('li'), p = e.payload;
        if (e.kind === 'group-chat') { const heading = node('strong', participantName(p.participantId)); li.append(heading, node('p', p.content)); }
        else { li.className = 'system-event'; li.append(node('span', e.kind === 'group-created' ? `${participantName(p.participantId)} created the group` : e.kind === 'group-joined' ? `${participantName(p.participantId)} joined` : e.kind === 'group-left' ? `${participantName(p.participantId)} left` : `${participantName(p.participantId)} invited ${participantName(p.invitedParticipantId)}`)); }
        return li;
      }) : [node('li', selected?.membership === 'invited' ? 'Accept your invitation to receive group messages.' : 'No downloaded group messages yet.')]));
      if (model.followLatest) $('group-history').scrollTop = $('group-history').scrollHeight;
    }
    text('group-page-status', history ? `Downloaded through ${history.cursor} · ${model.followLatest ? 'following latest' : 'browsing history'}` : '');
    $('group-older').disabled = !history || model.after === 0;
    $('group-newer').disabled = !history || (events.at(-1)?.seq ?? 0) >= history.cursor;
    $('group-latest').disabled = model.followLatest || !history;
  }
  model.addEventListener('change', render);
  $('group-select').addEventListener('change', () => { void model.select($('group-select').value); });
  $('group-input').addEventListener('input', () => { if (displayed) drafts.set(displayed, $('group-input').value); render(); });
  $('group-name').addEventListener('input', render);
  $('group-create-form').addEventListener('submit', async event => {
    event.preventDefault(); const name = $('group-name').value, id = await model.create(name);
    if (id && $('group-name').value === name) $('group-name').value = ''; render();
  });
  $('group-form').addEventListener('submit', async event => {
    event.preventDefault(); const content = $('group-input').value, groupId = model.selectedId, id = await model.send(content);
    if (id && drafts.get(groupId) === content) drafts.delete(groupId);
    if (id && model.selectedId === groupId && $('group-input').value === content) $('group-input').value = ''; render();
  });
  $('group-invite-form').addEventListener('submit', event => { event.preventDefault(); void model.invite($('group-invite-person').value); });
  $('group-join').addEventListener('click', () => { void model.join(); });
  $('group-leave').addEventListener('click', () => { void model.leave(); });
  for (const [id, action] of [['group-older', 'older'], ['group-newer', 'newer'], ['group-latest', 'latest'], ['groups-previous', 'previousGroups'], ['groups-next', 'nextGroups']]) $(id).addEventListener('click', () => { void model[action](); });
  render(); return model;
}
