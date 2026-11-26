import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { emptyState, evaluate } from "../storage/engine.ts";
import { evaluateGroup, validateGroupOperation, type GroupState } from "../storage/group-engine.ts";

function fixture() {
  const [a, b, c, outsider] = Array.from({ length: 4 }, () => randomUUID());
  let meeting = emptyState();
  for (const [participantId, name] of [[a, "Alice"], [b, "Bob"], [c, "Charlie"], [outsider, "Outside"]])
    meeting = evaluate(meeting, participantId, randomUUID(), { type: "join", name }).state;
  meeting = evaluate(meeting, a, randomUUID(), { type: "request-share" }).state;
  const groupId = randomUUID();
  const group: GroupState = { id: groupId, name: "Project", members: [a], invitations: {} };
  return { a, b, c, outsider, meeting, groupId, group };
}

test("creating a group subscribes only its creator and does not change meeting or media state", () => {
  const f = fixture(), before = structuredClone(f.meeting), id = randomUUID();
  const result = evaluateGroup(null, f.meeting, f.a, id, { type: "group-create", name: "Private work" });
  assert.equal(result.code, "OK");
  assert.deepEqual(result.state, { id, name: "Private work", members: [f.a], invitations: {} });
  assert.deepEqual(result.event, { groupId: id, kind: "group-created", payload: { participantId: f.a, name: "Private work" } });
  assert.deepEqual(f.meeting, before);
});

test("invitations permit only the addressed participant to join and do not permit publishing", () => {
  const f = fixture(), invitationId = randomUUID(), before = structuredClone(f.group);
  const invite = evaluateGroup(f.group, f.meeting, f.a, invitationId,
    { type: "group-invite", groupId: f.groupId, participantId: f.b });
  assert.equal(invite.code, "OK");
  assert.deepEqual(invite.state!.members, [f.a]);
  assert.deepEqual(invite.state!.invitations, { [f.b]: invitationId });
  assert.deepEqual(invite.event, { groupId: f.groupId, kind: "group-invited", payload: { participantId: f.a, invitedParticipantId: f.b, invitationId } });
  for (const [participantId, operation] of [
    [f.c, { type: "group-join", groupId: f.groupId, invitationId }],
    [f.b, { type: "group-chat", groupId: f.groupId, content: "not a member yet" }],
    [f.b, { type: "group-join", groupId: f.groupId, invitationId: randomUUID() }],
  ] as const) {
    const denied = evaluateGroup(invite.state, f.meeting, participantId, randomUUID(), operation);
    assert.equal(denied.code, "GROUP_ACCESS_DENIED");
    assert.equal(denied.event, undefined);
    assert.deepEqual(denied.state, invite.state);
  }
  const joined = evaluateGroup(invite.state, f.meeting, f.b, randomUUID(), { type: "group-join", groupId: f.groupId, invitationId });
  assert.equal(joined.code, "OK");
  assert.deepEqual(joined.state!.members, [f.a, f.b]);
  assert.deepEqual(joined.state!.invitations, {});
  assert.deepEqual(joined.event, { groupId: f.groupId, kind: "group-joined", payload: { participantId: f.b } });
  assert.deepEqual(f.group, before, "invitation evaluation mutated its input");
  assert.deepEqual(invite.state!.invitations, { [f.b]: invitationId }, "join mutated the invitation input");
});

test("any member can invite: one publisher and two other subscribers share a private destination", () => {
  const f = fixture();
  let group: GroupState | null = f.group;
  for (const [inviter, recipient] of [[f.a, f.b], [f.b, f.c]]) {
    const invitationId = randomUUID();
    const invited = evaluateGroup(group, f.meeting, inviter, invitationId,
      { type: "group-invite", groupId: f.groupId, participantId: recipient });
    assert.equal(invited.code, "OK");
    const joined = evaluateGroup(invited.state, f.meeting, recipient, randomUUID(),
      { type: "group-join", groupId: f.groupId, invitationId });
    assert.equal(joined.code, "OK");
    group = joined.state;
  }
  const before = structuredClone(group), meetingBefore = structuredClone(f.meeting);
  const publication = evaluateGroup(group, f.meeting, f.a, randomUUID(), { type: "group-chat", groupId: f.groupId, content: "For this group only" });
  assert.equal(publication.code, "OK");
  assert.deepEqual(publication.state!.members, [f.a, f.b, f.c]);
  assert.deepEqual(publication.event, { groupId: f.groupId, kind: "group-chat", payload: { participantId: f.a, content: "For this group only" } });
  const denied = evaluateGroup(group, f.meeting, f.outsider, randomUUID(), { type: "group-chat", groupId: f.groupId, content: "intrusion" });
  assert.equal(denied.code, "GROUP_ACCESS_DENIED");
  assert.equal(denied.event, undefined);
  assert.deepEqual(group, before);
  assert.deepEqual(f.meeting, meetingBefore);
});

test("leaving removes the subscription and old invitations cannot undo leave or replace a fresh invitation", () => {
  const f = fixture(), oldInvite = randomUUID();
  let group = evaluateGroup(f.group, f.meeting, f.a, oldInvite, { type: "group-invite", groupId: f.groupId, participantId: f.b }).state;
  group = evaluateGroup(group, f.meeting, f.b, randomUUID(), { type: "group-join", groupId: f.groupId, invitationId: oldInvite }).state;
  const before = structuredClone(group);
  const left = evaluateGroup(group, f.meeting, f.b, randomUUID(), { type: "group-leave", groupId: f.groupId });
  assert.equal(left.code, "OK");
  assert.deepEqual(left.state!.members, [f.a]);
  assert.deepEqual(left.event, { groupId: f.groupId, kind: "group-left", payload: { participantId: f.b } });
  assert.deepEqual(group, before);
  for (const operation of [
    { type: "group-chat", groupId: f.groupId, content: "after leave" },
    { type: "group-join", groupId: f.groupId, invitationId: oldInvite },
    { type: "group-invite", groupId: f.groupId, participantId: f.c },
  ] as const) {
    const denied = evaluateGroup(left.state, f.meeting, f.b, randomUUID(), operation);
    assert.equal(denied.code, "GROUP_ACCESS_DENIED");
    assert.equal(denied.event, undefined);
  }
  const newInvite = randomUUID();
  group = evaluateGroup(left.state, f.meeting, f.a, newInvite, { type: "group-invite", groupId: f.groupId, participantId: f.b }).state;
  const stale = evaluateGroup(group, f.meeting, f.b, randomUUID(), { type: "group-join", groupId: f.groupId, invitationId: oldInvite });
  assert.equal(stale.code, "GROUP_ACCESS_DENIED");
  assert.deepEqual(stale.state!.invitations, { [f.b]: newInvite });
  const rejoined = evaluateGroup(group, f.meeting, f.b, randomUUID(), { type: "group-join", groupId: f.groupId, invitationId: newInvite });
  assert.equal(rejoined.code, "OK");
  assert.deepEqual(rejoined.state!.members, [f.a, f.b]);
});

test("repeated invitations and already joined members do not duplicate subscriptions or replace invitations", () => {
  const f = fixture(), invitationId = randomUUID();
  const invite = { type: "group-invite", groupId: f.groupId, participantId: f.b } as const;
  const group = evaluateGroup(f.group, f.meeting, f.a, invitationId, invite).state;
  const repeated = evaluateGroup(group, f.meeting, f.a, randomUUID(), invite);
  assert.equal(repeated.code, "OK");
  assert.equal(repeated.event, undefined);
  assert.deepEqual(repeated.state!.invitations, { [f.b]: invitationId });
  const join = { type: "group-join", groupId: f.groupId, invitationId } as const;
  const joined = evaluateGroup(group, f.meeting, f.b, randomUUID(), join).state;
  for (const [actor, operation] of [[f.b, join], [f.a, invite]] as const) {
    const again = evaluateGroup(joined, f.meeting, actor, randomUUID(), operation);
    assert.equal(again.code, "OK");
    assert.equal(again.event, undefined);
    assert.deepEqual(again.state, joined);
  }
});

test("group decisions require current meeting membership, including creation and an invited join", () => {
  const f = fixture(), invitationId = randomUUID();
  const invited = evaluateGroup(f.group, f.meeting, f.a, invitationId, { type: "group-invite", groupId: f.groupId, participantId: f.b }).state;
  const departed = evaluate(f.meeting, f.b, randomUUID(), { type: "leave" }).state;
  for (const operation of [
    { type: "group-create", name: "No longer here" },
    { type: "group-join", groupId: f.groupId, invitationId },
    { type: "group-chat", groupId: f.groupId, content: "not in meeting" },
    { type: "group-invite", groupId: f.groupId, participantId: f.c },
    { type: "group-leave", groupId: f.groupId },
  ] as const) {
    const denied = evaluateGroup(operation.type === "group-create" ? null : invited, departed, f.b, randomUUID(), operation);
    assert.equal(denied.code, "NOT_MEMBER");
    assert.equal(denied.event, undefined);
  }
  const unknown = evaluateGroup(null, f.meeting, randomUUID(), randomUUID(), { type: "group-create", name: "Unknown" });
  assert.equal(unknown.code, "NOT_MEMBER");
  for (const recipient of [randomUUID(), f.b]) {
    const denied = evaluateGroup(f.group, departed, f.a, randomUUID(), { type: "group-invite", groupId: f.groupId, participantId: recipient });
    assert.equal(denied.code, "INVITEE_NOT_MEMBER");
    assert.equal(denied.event, undefined);
  }
});

test("missing, different and inaccessible groups have the same access rejection", () => {
  const f = fixture();
  for (const [group, actor, id] of [[null, f.a, f.groupId], [f.group, f.a, randomUUID()], [f.group, f.outsider, f.groupId]] as const) {
    for (const operation of [
      { type: "group-chat", groupId: id, content: "private" },
      { type: "group-invite", groupId: id, participantId: f.b },
      { type: "group-join", groupId: id, invitationId: randomUUID() },
      { type: "group-leave", groupId: id },
    ] as const) {
      const denied = evaluateGroup(group, f.meeting, actor, randomUUID(), operation);
      assert.equal(denied.code, "GROUP_ACCESS_DENIED");
      assert.equal(denied.event, undefined);
      assert.deepEqual(denied.state, group);
    }
  }
});

test("the final member can leave without deleting retained group identity", () => {
  const f = fixture();
  const left = evaluateGroup(f.group, f.meeting, f.a, randomUUID(), { type: "group-leave", groupId: f.groupId });
  assert.equal(left.code, "OK");
  assert.deepEqual(left.state, { id: f.groupId, name: "Project", members: [], invitations: {} });
  const recreated = evaluateGroup(left.state, f.meeting, f.a, randomUUID(), { type: "group-create", name: "Replacement" });
  assert.equal(recreated.code, "GROUP_EXISTS");
  assert.equal(recreated.event, undefined);
  assert.deepEqual(recreated.state, left.state);
});

test("a creator leaving does not revoke an addressed invitation or grant administrative privileges", () => {
  const f = fixture(), invitationId = randomUUID();
  const invited = evaluateGroup(f.group, f.meeting, f.a, invitationId, { type: "group-invite", groupId: f.groupId, participantId: f.b }).state;
  const left = evaluateGroup(invited, f.meeting, f.a, randomUUID(), { type: "group-leave", groupId: f.groupId });
  assert.deepEqual(left.state!.members, []);
  const joined = evaluateGroup(left.state, f.meeting, f.b, randomUUID(), { type: "group-join", groupId: f.groupId, invitationId });
  assert.equal(joined.code, "OK");
  assert.deepEqual(joined.state!.members, [f.b]);
  assert.equal(evaluateGroup(joined.state, f.meeting, f.a, randomUUID(), { type: "group-chat", groupId: f.groupId, content: "former creator" }).code, "GROUP_ACCESS_DENIED");
});

test("group validation rejects malformed identities, extra fields and invalid UTF-8 byte budgets", () => {
  const f = fixture(), groupId = f.groupId;
  for (const operation of [
    null, [], { type: "toString" }, { type: "__proto__" },
    { type: "group-create" }, { type: "group-create", name: " " },
    { type: "group-create", name: "x\n" }, { type: "group-create", name: "é".repeat(101) },
    { type: "group-create", name: "Private", public: true },
    { type: "group-chat", groupId, content: "\0" }, { type: "group-chat", groupId, content: " " },
    { type: "group-chat", groupId, content: "é".repeat(4097) }, { type: "group-chat", groupId, content: 10 },
    { type: "group-chat", groupId: "bad", content: "text" },
    { type: "group-join", groupId }, { type: "group-join", groupId, invitationId: "bad" },
    { type: "group-invite", groupId, participantId: "bad" }, { type: "group-invite", groupId },
    { type: "group-leave", groupId, subscriptionRevision: 1 },
    { type: "chat", content: "public operation" },
  ]) assert.throws(() => validateGroupOperation(operation as never), /invalid/i, JSON.stringify(operation));
  for (const [participantId, commandId] of [["bad", randomUUID()], [f.a, "bad"]])
    assert.throws(() => evaluateGroup(f.group, f.meeting, participantId, commandId, { type: "group-leave", groupId }), /invalid/i);
});

test("group names and messages accept the existing byte boundaries and preserve message contents", () => {
  const f = fixture(), id = randomUUID();
  const created = evaluateGroup(null, f.meeting, f.a, id, { type: "group-create", name: "é".repeat(100) });
  assert.equal(created.code, "OK");
  const content = "é".repeat(4096);
  const published = evaluateGroup(created.state, f.meeting, f.a, randomUUID(), { type: "group-chat", groupId: id, content });
  assert.equal(published.code, "OK");
  assert.equal(published.event!.payload.content, content);
  const multiline = " first line\nsecond line ";
  assert.equal(evaluateGroup(created.state, f.meeting, f.a, randomUUID(), { type: "group-chat", groupId: id, content: multiline }).event!.payload.content, multiline);
});

test("JSON operation types cannot bypass validation through property-key coercion", () => {
  const groupId = randomUUID();
  for (const type of [["group-leave"], ["group-chat"], { toString: "group-leave" }, null, 1])
    assert.throws(() => validateGroupOperation({ type, groupId } as never), /invalid/i);
});
