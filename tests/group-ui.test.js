import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParticipantModel } from '../client/participant-model.js';
import { GroupModel } from '../client/group-model.js';

class Attachment extends EventTarget {
  readyState = 'attached'; submissions = []; commands = []; catalog = [{ groupId: 'study', name: 'Study', membership: 'member' }];
  async view() { return { view: { clusterId: 'cluster', meetingId: 'meeting', participantId: 'alice', name: 'Alice', cursor: { seq: 90 }, events: [], commands: this.commands,
    observation: { state: { members: { alice: { name: 'Alice', joined: true }, bob: { name: 'Bob', joined: true } }, holder: { participantId: 'alice', requestId: 'screen' }, grantVersion: 7, queue: [] } } } }; }
  async groups() { return { catalog: { groups: structuredClone(this.catalog), nextAfter: null } }; }
  async groupHistory(groupId, after) { return { history: { groupId, name: 'Study', membership: this.catalog.find(g => g.groupId === groupId)?.membership ?? 'left', cursor: 35,
    events: Array.from({ length: 35 }, (_, i) => ({ seq: i + 1, kind: 'group-chat', payload: { participantId: 'bob', content: `private ${i + 1}` } })).filter(e => e.seq > after).slice(0, 16) } }; }
  async submit(operation) { this.submissions.push(operation); const commandId = 'command-' + this.submissions.length; this.commands.push({ id: commandId, operation, outcome: null }); return { commandId }; }
}
async function fixture() {
  const attachment = new Attachment(), participant = new ParticipantModel(attachment), groups = new GroupModel(attachment, participant);
  await participant.refresh(); await groups.refresh(); return { attachment, participant, groups };
}

test('group selection has separate bounded history and leaving a group never releases media or leaves the meeting', async () => {
  const f = await fixture();
  try {
    assert.equal(f.groups.selectedId, 'study'); assert.equal(f.groups.history.events[0].seq, 20);
    await f.groups.older(); assert.equal(f.groups.history.events[0].seq, 4); assert.equal(f.participant.after, 74);
    await f.groups.latest(); assert.equal(f.groups.history.events.at(-1).seq, 35);
    assert.equal(await f.groups.leave(), 'command-1');
    assert.deepEqual(f.attachment.submissions, [{ type: 'group-leave', groupId: 'study' }]);
    assert.equal(f.participant.state.holder.requestId, 'screen');
    assert.equal(await f.groups.send('after pending leave'), null);
  } finally { f.groups.dispose(); f.participant.dispose(); }
});

test('group commands share the persisted uncertainty guard and reject blank/oversized drafts before durable admission', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.groups.send(' '), null); assert.equal(await f.groups.create('x'.repeat(201)), null); assert.deepEqual(f.attachment.submissions, []);
    const submit = f.attachment.submit.bind(f.attachment);
    f.attachment.submit = async operation => { await submit(operation); throw new Error('LOST_REPLY'); };
    assert.equal(await f.groups.send('keep this draft'), null); assert.equal(f.participant.uncertain, true);
    assert.equal(await f.groups.create('another'), null); assert.equal(await f.groups.join(), null);
    assert.equal(f.attachment.submissions.length, 1);
    assert.deepEqual(f.attachment.submissions[0], { type: 'group-chat', groupId: 'study', content: 'keep this draft' });
  } finally { f.groups.dispose(); f.participant.dispose(); }
});

test('an addressed invitation allows explicit join only; retained departed history cannot publish', async () => {
  const f = await fixture();
  try {
    f.attachment.catalog = [{ groupId: 'study', name: 'Study', membership: 'invited', invitationId: 'invite-bob' }]; await f.groups.refresh();
    assert.equal(f.groups.canPublish, false); assert.equal(await f.groups.send('not admitted'), null);
    assert.equal(await f.groups.join(), 'command-1');
    assert.deepEqual(f.attachment.submissions[0], { type: 'group-join', groupId: 'study', invitationId: 'invite-bob' });
    f.attachment.catalog[0].membership = 'left'; delete f.attachment.catalog[0].invitationId; await f.groups.refresh();
    assert.equal(f.groups.canPublish, false); assert.equal(await f.groups.join(), null);
  } finally { f.groups.dispose(); f.participant.dispose(); }
});

test('switching destinations pauses publishing until matching history arrives and serializes navigation', async () => {
  const f = await fixture();
  f.attachment.catalog.push({ groupId: 'other', name: 'Other', membership: 'member' });
  const read = f.attachment.groupHistory.bind(f.attachment);
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.attachment.groupHistory = async (id, after) => { if (id === 'other') { entered(); await blocked; } return read(id, after); };
  try {
    const navigating = f.groups.select('other'); await arrived;
    assert.equal(f.groups.canPublish, false, 'old destination history cannot enable the new composer');
    assert.equal(await f.groups.send('wrong destination'), null);
    const back = f.groups.select('study'); release(); await Promise.all([navigating, back]);
    assert.equal(f.groups.selectedId, 'study'); assert.equal(f.groups.history.groupId, 'study');
    assert.deepEqual(f.attachment.submissions, []);
  } finally { release(); f.groups.dispose(); f.participant.dispose(); }
});

test('destination selection pauses mutations synchronously before even its catalog request starts', async () => {
  const f = await fixture();
  f.attachment.catalog.push({ groupId: 'other', name: 'Other', membership: 'member' });
  const catalog = f.attachment.groups.bind(f.attachment);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { entered = resolve; });
  f.attachment.groups = async () => { entered(); await blocked; return catalog(); };
  try {
    const navigating = f.groups.select('other');
    assert.equal(f.groups.canPublish, false);
    await arrived; assert.equal(await f.groups.send('intended for other'), null);
    release(); await navigating;
    assert.equal(f.groups.selectedId, 'other'); assert.deepEqual(f.attachment.submissions, []);
  } finally { release(); f.groups.dispose(); f.participant.dispose(); }
});
