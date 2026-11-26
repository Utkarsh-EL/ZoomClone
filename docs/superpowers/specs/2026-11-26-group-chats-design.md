# Group chats: agreed product direction and implementation handoff

Date: 2026-11-26
Status: conversational product decisions recorded; technical planning and implementation remain. Supersedes the public-topic filtering proposal and its six-increment plan. This is a concise product brief, not a claim that a replacement technical plan or group-chat code exists.

## Decisions established in conversation

- Keep the existing main meeting chat. Add invite-only group chats as the useful pub/sub feature. Additional public chats are reasonable but optional follow-up, not a prerequisite for private groups.
- Group membership is the subscription: creating/joining a group subscribes; sending publishes to the group; leaving unsubscribes. There is no independent subscription-selector or unsubscribe-while-still-a-member action. Muting notifications, if added later, does not change membership or message receipt.
- An invitation permits joining; membership then permits receiving messages and reading history. Reject attempts to join a private group without a valid invitation. Do not distribute private message bodies to nonmembers and rely on UI hiding.
- Prefer earlier group history visible to a newly joined member. The user explicitly permits a simpler history policy if necessary, but do not silently substitute future-only delivery merely because the obsolete proposal specified it. Start planning with full earlier history available to current members.
- Leaving ends subsequent delivery and further server history access. Already downloaded messages may remain in the local journal; no retroactive erasure guarantee is made. An invitation alone is not access to message bodies before joining.
- Use one supported participant protocol. Update client/server together and use regression tests; clearly reject incompatible software. A format version may change, but parallel v1/v2 serving, temporary compatibility adapters and a rolling-upgrade framework are not requirements.
- Keep the recovery journal: it persists identity, original pending commands/results, received history and replay progress. Browser and CLI remain adapters to the same participant session, not separate identities or sessions.
- The user converses and does not read plans/specs. Explain consequential behavior, privacy, scope and substantial-cost choices in conversation. Documents record agreements; creating or editing one is not user approval of additional product choices.

## Pub/sub mapping

Each group is a named publication destination managed by the meeting service. The sender addresses the group; the service delivers to its authorized member subscriptions, including multiple independent participants. Joining and leaving visibly change who receives publications. Stored messages provide history/reconnect recovery; history is not supplied by pub/sub alone. A socket disconnect does not by itself mean leaving the group.

This demonstrates selective pub/sub separately from the existing meeting-wide chat. The assignment does not require an extra broker service, arbitrary topic strings, threads/replies, or student-written storage replication. Do not add those solely to make the example more elaborate.

## Bounded starting scope and explicit assumptions

Plan text group chats among existing participants of one meeting, using existing durable participant identities. Public, if implemented, means open to participants of that meeting, not an internet directory. These are implementation scope assumptions consistent with the discussion; explain a material change to them in conversation. No cross-meeting messaging, new accounts, private audio/video rooms, moderation-role hierarchy or end-to-end encryption project is included.

Private means access-restricted inside the application; the server/database still handles contents. Avoid exposing private message bodies through meeting-wide replay, subscription notifications, snapshots, another participant's outcomes, or ordinary participant metadata. Choose the smallest invitation rule/UI that supports the agreed workflow and state its user-visible behavior when presenting the implementation. Do not turn unspecified invitation administration into a separate project.

Deliver an actual user flow: create group, invite, join, send/receive, read earlier messages, leave. Browser and CLI use the same durable commands and outcomes. Public chats and notification mute can follow separately; the private-group feature should not depend on them.

## Correctness constraints to carry into the technical plan

- Preserve the existing Raft/PostgreSQL/runtime foundations, exact ACTIVE SQL owner/incarnation/generation checks, readiness/renewal and retry rules. Group operations use the existing fenced command/outcome transaction discipline.
- Preserve immutable pending command IDs/content/order, stable issuer-authenticated original outcomes after uncertain replies, credential authentication before lookup, and the shared submission uncertainty guard. Group membership changes do not invent retries or replacement commands. New group reads and new operations check current authorization; resolving the issuer's original outcome is not permission to read another participant's messages.
- Preserve one shared ClientSession/journal, atomic inbox/clock/cursor persistence, bounded pages/pass/admission/output/deadlines and reconnect without rejoining the meeting or group.
- Preserve current revision-zero unfiltered replay for the existing meeting-wide event domain. This is not permission to expose private group data: group authorization precedes any delivery, including legacy reads. Do not put private bodies in an unrestricted old replay path or relax existing contiguity validation to accept arbitrary gaps.
- Full earlier group history means joining must not skip it because the meeting-wide cursor is already ahead. Plan bounded group-scoped history/progress, or an equally explicit correct approach, inside the same journal. Do not require the obsolete per-participant topic-selection revision intervals/CAS merely to implement membership subscriptions.
- Authorize subscription admission, reconnect and every history read against current group membership. Serialize membership/send decisions under existing SQL ordering. Test leave versus queued/in-flight delivery and bound the guarantee honestly: data already delivered or authorized in flight cannot be recalled; no new publication/history authorization after effective leave.
- Retain the existing local copy of previously received messages when leaving unless a separately agreed product policy changes that. No new unbounded history fetch, retention/garbage-collection scheme, automatic rejoin or automatic resubscription after deliberate group leave.
- Preserve exact holder/request/grant release identity, release-review diagnostics, supervised capture/playback/recovery, local capture lease revisions, SQL/SFU epoch/caller fences and successor-safe cleanup/drain. Group changes cannot authorize capture, release a share turn, mute playback or rebuild media.
- Fresh media authorization must remain a current fenced SQL membership/grant check, independent of group history/cursors. Extract a focused current-state method if needed; the obsolete plan's media-refactor task is not an automatic prerequisite or an approved task sequence.
- No second protocol running alongside the supported one. Preserve the current journal/credentials/pending commands through any required coordinated schema/format upgrade; simplifying compatibility does not authorize resetting participant data or weakening fences. Prevent incompatible old programs from using changed data, without building a general deployment subsystem.

## What the next session should do

1. Read this brief, main spec sections 8–10, the current handoff, and the relevant source. Treat the old subscription spec/plan as superseded records, not instructions.
2. Write a concise replacement implementation plan grounded in current code. Resolve schema, scoped replay/history, invitation commands and UI/CLI boundaries as engineering choices; do not ask the user to design those internals. State user-facing defaults in ordinary language. Ask only if a new material product/privacy decision blocks progress.
3. Prefer one coherent group-chat path over multiple compatibility stages. Do not prebuild temporary adapters or a generic pub/sub platform. Keep first work bounded and reviewable, with a clear usable end state across the increments.
4. The user authorizes the next session to plan or implement this clarified feature. Once the replacement plan is concrete and no material product question blocks it, implementation may start with its first bounded increment inline. Do not make the user read/approve technical documents as a condition of progress.
5. Add focused regressions for the changed behavior: authorized membership/invites; private message/history exclusion; history on join despite an advanced meeting cursor; publish/leave ordering; original-ID retry after lost replies; restart/takeover and shared browser/CLI progress. Test at least one publisher and multiple member subscribers plus a nonmember. Existing journal/release/media safeguards remain regressions.
6. Run targeted/default/typecheck checks as appropriate, real PostgreSQL/process checks for changed durable authorization/replay, and browser acceptance for the user flow. Run the broader native media suite when a media authorization/lifecycle path changes or at the integration gate; avoid repeatedly rerunning it for documentation or isolated unrelated changes. Keep exact evidence and limits; historical tests do not prove private groups.
7. Commit verified bounded work and update the handoff with what actually exists, remaining work and the next action. No deployment/push/merge or real-credential revocation is requested.

## Current status and continuation

No group-chat commands, schema, private permissions, subscriptions or group UI are implemented. The existing app has meeting-wide chat and provisioned supervised microphone/camera/display/playback; meeting-code entry, disconnect grace, supervisor/dashboard and broader network/device deployment remain unfinished. Existing localhost browser/process evidence is not proof of physical-device audio or independent-host resilience.

Recommended next model/effort: **GPT-6.1, medium**. Product direction is settled enough to start bounded technical planning; use high only for a specific unresolved authorization/replay/failure interleaving, not automatically because the application is distributed. Work inline and keep verification proportional; no routine multi-agent fan-out is requested.

Continuation: "Continue from the group-chat clarification checkpoint. Read docs/superpowers/specs/2026-11-26-group-chats-design.md and the current handoff/main spec. Replace the superseded topic-filter plan with a concise plan for invite-only group chats: joining is subscribing, sending is publishing, leaving is unsubscribing; current members should preferably see earlier history. Public chats are optional follow-up. Use one supported protocol and preserve the shared recovery journal, original uncertain commands and all existing release/media/readiness/SQL/SFU/local-lease guarantees. Keep revision-zero meeting replay unfiltered without exposing private data. Plan from current code, then implement the first bounded increment inline if no material user-facing question blocks it. Explain consequential choices in conversation; I do not read specs/plans. Use GPT-6.1 medium, focused verification and verified commits; do not execute the old six-task subscription plan."
