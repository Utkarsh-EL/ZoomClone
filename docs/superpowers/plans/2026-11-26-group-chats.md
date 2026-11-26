# Invite-only group chats implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, one bounded increment at a time. No routine delegation. This replaces the superseded committed-subscriptions plan.

**Goal:** Deliver create/invite/join/publish/history/leave through the shared browser/CLI participant session while retaining meeting-wide chat.

**Architecture:** Keep private group state and contiguous group event sequences separate from `meeting_state`, `events` and the revision-zero meeting cursor. Group commands use the existing authenticated, fenced `MeetingStore.execute` transaction and original outcome key; the same SQLite journal gains scoped inboxes/cursors. A socket disconnect changes no membership.

**Tech stack:** Existing Node/TypeScript, PostgreSQL, SQLite, WebSocket, browser adapters; no broker or new dependency.

**Spec:** [Group-chat brief](../specs/2026-11-26-group-chats-design.md), [main spec §§8–10](../specs/2026-11-21-distributed-meeting-redesign.md), [handoff](../handoffs/2026-11-25-distributed-meeting-redesign.md). Base: `cecdef8`.

## Global constraints and engineering choices

- Joining is subscribing, sending is publishing, leaving is unsubscribing. Earlier history is available to current members, independently of meeting replay progress. Public chats and notification mute are follow-up work.
- Any current group member may invite a current meeting participant by durable participant ID. Invitations are identity-bound, consumed on joining, and replaced only by a fresh invite after leave; an inviter's departure does not revoke invitations already addressed to others. Creating joins the creator. Invited participants can see the invitation/group name, but no group roster/history until joining. There are no owner/admin roles, expiry timers or transferable bearer links.
- Meeting leave removes all that participant's group memberships and invitations in its existing transaction. Returning to the meeting does not restore them. Empty groups remain retained; no deletion/retention project.
- Preserve credentials, command IDs/content/order, stable issuer-authenticated original outcomes and the shared uncertainty guard. Outcome lookup remains after authentication and before fresh group authorization. Outcomes contain status/positions, never another participant's private messages.
- All new group operations and reads check current meeting/group membership. Serialize reads with membership/send decisions on the existing meeting fence. A read authorized before leave may finish afterward; no newly authorized reads/publications after effective leave. Polling is the durable subscription delivery path; no private socket fanout queue is needed.
- Keep revision-zero meeting replay **unfiltered**, contiguous and free of group bodies, names, membership/invitation metadata and notifications. Do not extend the public `MeetingState` with private groups. Media authorization remains a fresh fenced meeting membership/grant check, independent of group cursors; no media refactor is required.
- Preserve readiness/renewal, exact SQL owner/incarnation/generation checks, release identity/review, supervised capture/playback/recovery, SFU caller/epoch and local capture lease fences.
- Use one supported participant protocol, updated client/server together when wiring groups. Stop old processes for the coordinated upgrade; no live mixed-version deployment or parallel serving/adapters. Additive PostgreSQL migration and transactional SQLite format upgrade preserve existing rows. Old database binaries already reject newer migration versions on open; SQLite needs an explicit format gate before interpreting changed data, and incompatible participant handshakes must fail.
- Bounds: existing 128 live meeting participants, 200 UTF-8 byte names, 8192 UTF-8 byte messages. SQL group/catalog pages and local views bounded to 16 per wire response, at most eight total replay pages per session pass with fair group scheduling; retain admission/output/deadline limits. No unbounded history bootstrap.

## Review focus

- Invitation guessing/old invitations and third-party outcome IDs must yield no private bodies (increments 1–2).
- Leave racing an already authorized page versus a later page/publication must have the stated SQL ordering (increment 2).
- Group history must begin at zero on first join despite an advanced meeting cursor; one busy group must not starve others (increment 2).
- A lost join/leave/send reply followed by departure or takeover must resolve the issuer's original command without restoring membership (increment 2).
- Old binaries, interrupted format migration, malformed scoped pages and browser/CLI uncertainty must preserve original journal data and submission guards (increments 2–3).

## Increment 1: Pure group decisions (first bounded implementation)

**Files:** Create `storage/group-engine.ts`, `tests/group-engine.test.ts`; add the test to `package.json`.

**Interfaces:** Export `GroupOperation`, `GroupState`, `GroupEvaluation`, `validateGroupOperation(operation)`, and `evaluateGroup(input: GroupState | null, meeting: Pick<MeetingState, "members">, participantId: string, commandId: string, operation: GroupOperation): GroupEvaluation`.

Group operations: `group-create {name}`, `group-invite {groupId, participantId}`, `group-join {groupId, invitationId}`, `group-chat {groupId, content}`, `group-leave {groupId}`. Creation uses the original command ID as group ID; invite uses its command ID as invitation ID. State contains `id`, `name`, current member IDs and identity-bound invitations. Evaluation returns code/state and an optional **private group** event, never a meeting event or media effect. This permanent helper stays disconnected from participant ingress until durable authorization exists; no unsupported command enters a pending journal in this increment.

- [x] Write focused tests for creator subscription, identity-bound/consumed invites, stale-invite rejection after leave/reinvite, all-member invitation, duplicate membership, meeting-member eligibility, malformed/oversized fields, input immutability and one publisher/two subscribers plus a nonmember. Assert event destinations/payloads and that group decisions leave the meeting/share state untouched. A pure engine proves publication eligibility, not delivery or history privacy.
- [x] Run `node --test tests/group-engine.test.ts`; expect RED for missing group decisions, then implement only this helper and run the same command to GREEN. Result: **12/12**, including an additional assertion reproduced RED→GREEN for JSON-array type coercion found in inline review.
- [x] Run `npm test`, `npm run typecheck`, `git diff --check`; expect all green. Final default **142/142**, typecheck passed; inline self-review and handoff updated. No SQL/process/browser/native-media claim in this increment. Verified work committed with this plan.

## Increment 2: Fenced storage, one protocol and shared recovery

**Files:** `storage/migrations/003-groups.sql`, `storage/{database,engine,types,meeting-store}.ts`, `coordination/{participant-protocol,participant-gateway}.ts`, `client/{types,participant-transport,replay-validation,session-journal,client-session}.ts`; focused `tests/{group-storage,participant-gateway,client-session,participant-process}.test.ts` and `scripts/storage-check.ts` selection for group storage.

**Interfaces:** Extend `Operation` with increment 1's `GroupOperation` and dispatch it in `MeetingStore.execute` (never through meeting `evaluate`). Add `listGroups(authority, credential, afterGroupId, limit)` returning only memberships/invitations visible to that identity, and `readGroup(authority, credential, groupId, after, limit)` returning `{groupId, watermark, scannedWatermark, events}` with exact contiguous group sequences. Define typed catalog/page DTOs in `storage/types.ts`. `ParticipantTransport.listGroups/readGroup` mirror the store. `SessionJournal` adds scoped progress/page validation and bounded views; keep `cursor()/recordReplay()` revision zero unchanged. Wire storage, protocol and journal in this single coordinated increment: the shared operation validator otherwise enables new ingress commands before recovery/format protection exists.

- [ ] RED SQL tests: Alice publishes, Bob/Charlie join with invitations and each read earlier history; outsider/invitee-before-join cannot read; leave stops reads/sends, fresh invite allows return; meeting leave invalidates groups/invites. Authenticate before original-outcome lookup, including after leave; conflicting contents fail. Test SQL lock ordering, readiness/fencing, reopen/takeover and lost-reply original-ID retry. Assert public state/events/watermarks contain no group information and meeting sequences remain contiguous. Test bounded pages and restricted-role privileges.
- [ ] Add normalized `groups(meeting_id,group_id,name,seq)`, `group_members`, `group_invitations` and `group_events`, with foreign keys and runtime grants. Do not edit applied migrations. Under the existing meeting `FOR UPDATE` lock, load one bounded group, evaluate, persist private state/event and original outcome atomically. Group decisions never allocate meeting sequences or media intentions; add optional `groupId/groupSeq` to outcomes without rewriting originals. Delete group membership/invitations on meeting leave. Group reads take the same fence lock (bounded read-write transaction) before fresh authorization; catalog uses a bounded consistent view. No private data in public observations/prepare/read or another issuer's outcomes.
- [ ] RED tests for advanced meeting cursor plus new membership/history from group zero, concurrent browser/CLI progress, restart during uncertain group commands, malicious/gapped/wrong-group pages, leave during replay, multiple subscribers, and fair bounded recovery. Resolving a departed issuer's old outcome must not initiate rejoin or authorize history. Lost catalog/page responses must not erase the local inbox or create replacement commands.
- [ ] Replace the participant protocol/subprotocol and body version together; refuse old handshakes, retain only one handler. Add scoped read requests with strict schemas/current authority checks and the existing admission/deadline/output bounds. Extend outcome validation for scoped positions. Preserve meeting/media/release paths.
- [ ] Transactionally upgrade the existing SQLite journal with group inbox/cursor/catalog storage and a format gate old code rejects (existing identity version check), preserving identity/credentials and exact command/outcome JSON, ordering, meeting inbox/cursor and clock. Group pages atomically commit inbox, Lamport clock and scoped cursor; do not reset progress on reconnect or erase retained history on leave. Session catalog state controls which groups are polled, with fresh server authorization on every page. ClientSession submits through the existing ordered pending queue, then fairly schedules catalog/group recovery inside one bounded pass.
- [ ] Run isolated real PostgreSQL group/storage regressions, focused journal/gateway tests, real participant process recovery with PostgreSQL/takeover, default tests and typecheck; expect GREEN. Test schema/format upgrades preserving existing credentials, exact commands/outcomes, inboxes and cursors, interrupted upgrade rollback and rejection by old programs. Review, commit and record evidence. Run native media here only if media authorization/lifecycle code actually changes.

## Increment 3: Usable browser/CLI flow and integration gate

**Files:** `client/{browser-attachment.ts,browser-attachment.js,participant-model.js,browser-bootstrap.js,participant.html,participant.css}`, `scripts/participant-agent.ts`; participant UI/attachment/process/browser tests and user documentation.

**Interfaces:** Shared submit accepts the same `GroupOperation`; add bounded group/catalog views to local attachment and CLI, using the existing ClientSession rather than new identities/transports. UI displays meeting chat plus joined groups and addressed invitations; create/invite/accept/send/leave use the shared uncertainty guard and expose original outcomes.

- [ ] RED focused model/adapter tests, then implement accessible group selection, earlier-history paging, participant invitation, explicit group leave and retained-local-history status. Explain that joining shares earlier history and invites do not admit recipients until accepted. Group leave never invokes meeting leave, capture release or playback changes. Drafts clear only after durable admission; uncertain submission retains its original identity.
- [ ] Browser acceptance: three independent member sessions and one nonmember, create/invite/join, earlier message despite advanced meeting cursor, one publisher/multiple recipients, leave/no subsequent access, reconnect and shared CLI progress. Inspect nonmember payloads, not just hidden UI. Run default/typecheck plus real process and native browser/media acceptance once at the integration gate; record physical-device/deployment limits.
- [ ] Review, commit, update handoff/README with actual supported flow and remaining scope. No push, merge or deployment.

## Execution record

The user explicitly requested concise planning and the first bounded increment inline, without routine delegation or document approval. Work in the current clean `milestone-5` checkout from `cecdef8`; preserve existing branch context. Self-review each bounded diff; do not execute later increments in this session merely because they are listed here.
