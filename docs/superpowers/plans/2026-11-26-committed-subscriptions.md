# Committed subscriptions implementation plan

**ON HOLD — revise before execution.** Subsequent conversation establishes invite-only group chats as the preferred feature, allows additional public channels, and accepts simplifying to one supported protocol while retaining the journal and safety guarantees. This plan implements public delivery filters with parallel v1/v2 compatibility; it does not implement private membership permissions. Its task sequence and continuation instructions below are historical. Do not start task 1 from the old continuation. First resolve group-history visibility in conversation, then replace the design/plan with the smaller agreed scope. No implementation task has begun.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline. Steps use checkbox syntax for tracking. Stop at each task's review gate; do not combine the six increments into one unreviewed change.

**Goal:** Deliver prospective committed chat subscriptions with deterministic bounded replay through one durable participant session, preserving existing media and failure guarantees.

**Architecture:** Store immutable per-participant revision intervals alongside the existing SQL log; serialize changes and administrative activation under the meeting fence. Add explicit participant v2 and a transactional journal upgrade before connecting filtered replay. Isolate fresh media authorization first; snapshots, outcomes and replay never authorize media or move each other's cursors.

**Tech Stack:** Existing Node >=24.16, TypeScript, node:sqlite FULL-synchronous journal, PostgreSQL >=18, ws and ControlWire; existing Go coordinator and mediasoup remain unchanged. No new dependencies.

**Spec:** [Accepted subscription design](../specs/2026-11-26-committed-subscriptions-design.md), [main specification](../specs/2026-11-21-distributed-meeting-redesign.md), [handoff](../handoffs/2026-11-25-distributed-meeting-redesign.md). Baseline: `640ae13`; this checkpoint changes documentation only.

## Global constraints

- Revision zero remains unfiltered.
- Topic IDs match `[a-z][a-z0-9-]{0,31}`; at most 32 distinct IDs, duplicates invalid, sorted before durable submission. Empty topics excludes topic chat; all includes future topics; broadcast/control events always pass.
- One shared ClientSession/journal for browser and CLI. Preserve credentials, command JSON/IDs/ordinal order, outcomes, inbox, Lamport clock and persisted submission uncertainty. Never rebase or replace an uncertain command.
- Keep exact holder/request/grant release identity, release-review diagnostics, local capture lease revisions, cancellation, supervision, playback and shutdown drain guarantees.
- Preserve readiness/renewal values, retry jitter, SQL exact ACTIVE owner/incarnation/generation checks, SFU epoch/caller ordering and owner-scoped cleanup. No Raft metadata/storage-format change.
- `1 <= L <= 16` raw rows per v2 participant page; at most one own boundary per page; eight pages per ClientSession pass; 64 KiB participant request / 1 MiB envelope bounds and existing admission/deadlines/backpressure remain.
- New revision/boundary/cursor counters satisfy `0 <= n < Number.MAX_SAFE_INTEGER - 4`; exhaustion fails before mutation. Existing persisted outcomes/digests retain their interpretation.
- No topic widgets, historical backfill, inbox deletion/re-filtering, membership policy change, meeting-code entry, disconnect grace, supervisor/dashboard, deployment, credential revocation against a real environment, or automatic activation in this plan's implementation sessions.
- Maintenance prerequisites are an operational gate: drain traffic/handles, stop old runtime/recovery processes, revoke every old SQL login, terminate sessions and prove reconnection refusal before activation. An activation flag cannot enforce old-binary shutdown.

## Review focus

1. A queued media effect outlives its ingress authority or the participant leaves: fresh authorization must refuse publication while retaining narrowly authenticated exact-peer teardown (task 1).
2. A v1 request races activation, including an exact old command retry: SQL ordering must prevent incompatible work; v2 resolves the unchanged ID (tasks 2–3).
3. A newer snapshot arrives before an older stable outcome/boundary: display subscription state cannot regress and replay cannot jump (task 4).
4. Many changes commit before a delayed reader scans an empty topic window: the raw-window bound and every own boundary still apply (task 5).
5. Retained events have million-position gaps and a reload carries uncertain acceptance: local paging must stay bounded and preserve position/guard (task 6).

## File and interface map

Follow the existing layout; add focused subscription modules rather than moving the current media/engine/session code wholesale.

| Files | Responsibility |
| --- | --- |
| `storage/subscriptions.ts` (new), `storage/engine.ts`, `storage/types.ts` | Selection validation/canonicalization, pure CAS evaluation, operation/event/outcome/replay types |
| `storage/migrations/003-subscriptions.sql` (new), `storage/database.ts`, `storage/meeting-store.ts` | Feature level, immutable intervals/current pointer, fenced commands/activation, fresh current read, bounded subscribed read |
| `coordination/participant-protocol.ts`, `coordination/participant-gateway.ts`, `client/participant-transport.ts`, `coordination/runtime-service.ts` | Explicit v1/v2 routing and DTOs; in-process administrative activation using current authority; media isolation |
| `client/replay-validation.ts`, `client/subscription-replay-validation.ts` (new), `client/types.ts`, `client/session-journal.ts`, `client/client-session.ts`, `client/participant-agent.ts` | Strict separate validators, explicit journal upgrade, atomic interval/cursor persistence, v2 transport selection |
| `client/browser-attachment.ts`, `client/browser-attachment.js`, `client/participant-model.js`, `client/browser-bootstrap.js` | Bounded sparse inbox pages, truthful revision/topic display through existing shared attachment |
| Existing tests plus `tests/subscriptions.test.ts`, `tests/subscription-replay.test.ts` (new); `package.json` | Deterministic selection/oracle verification and default-suite registration |
| `docs/client-sessions.md`, `docs/production-media.md`, spec/handoff/this ledger | Maintenance procedure, operator limits, verified results and continuation |

Exact interfaces to introduce (names below bind neighboring tasks):

```ts
type ParticipantVersion = 1 | 2;
type Selection = { mode: "all" } | { mode: "topics"; topics: string[] };
type Subscription = { revision: number; selection: Selection; boundarySeq: number };
type SubscriptionCursor = {
  clusterId: string; meetingId: string; participantId: string;
  subscriptionRevision: number; seq: number;
};
type SubscriptionOutcome = Outcome & { subscription?: Subscription };
type SubscriptionReplay = Observation & {
  fromCursor: SubscriptionCursor; nextCursor: SubscriptionCursor;
  scannedWatermark: number; events: MeetingEvent[];
  cursorSubscription: Subscription; currentSubscription: Subscription;
  nextSubscription: Subscription | null;
  transition: { eventSeq: number; subscription: Subscription } | null;
};
```

`nextSubscription` is the nearest following boundary descriptor, even if outside this page. It lets the journal reject omission/jumping of a known boundary; it is not permission to advance. Require boundary event payload to agree with previous revision, next revision/selection and own participant/command identity; the returned event seq is the boundarySeq. Wire scope is explicit even though identity is already bound locally. Trusted runtime completeness remains an assumption, not a cryptographic proof.

## Task 1: Separate fresh participant/media authorization from replay

**Files:** Modify `storage/meeting-store.ts`, `coordination/participant-gateway.ts`; tests `tests/storage.test.ts`, `tests/participant-gateway.test.ts`, `tests/media-production.test.ts`, `tests/media-room.test.ts`.

**Interfaces:** Produce `MeetingStore.currentParticipant(authority: Authority, credential: ParticipantCredential): Promise<Observation>`. It has no cursor, limit, event scan or selection. Task 2 adds an explicit version parameter when feature gating exists. `MediaContext.authorize(): Promise<MediaSnapshot>` stays structurally compatible.

- [ ] Add regressions named `current participant authorization never reads events` (empty/corrupt replay rows do not change a fresh current observation), `queued media rechecks exact owner and readiness`, and `departed teardown authenticates before NOT_MEMBER`. Assert wrong credential/owner/unready never become the special departure cleanup path; valid departed closePeer can close only its admitted exact owner/epoch and cannot sync/produce. Use the real PostgreSQL fixture for the SQL guarantee and existing deterministic media fixtures for effect ordering.
- [ ] Run `node --test tests/participant-gateway.test.ts tests/media-production.test.ts tests/media-room.test.ts` and `npm run test:storage`; observe the new missing-method/call-path failures before implementation.
- [ ] Extract the current bounded repeatable-read observation/authentication checks into `currentParticipant`; check readiness at completion as today. Change the gateway's serialized media authorize callback to reacquire RuntimeAuthority and call it, preserving hello-before-auth and effects-after-transaction. Do not make replay depend on this refactor or change MediaRoom's departure exception.
- [ ] Run the targeted tests above, `npm test`, `npm run typecheck`, `npm run test:browser` and `npm run test:media`. All must pass; native results must verify actual controls, exact release, recovery, takeover and drain. Preserve sanitized evidence, with environment failures distinguished from passing runs.
- [ ] Review the diff for removed authority/membership checks; update production guide/ledger/handoff and commit `refactor: isolate fresh media authorization from replay`. **Stop here for the next bounded session.**

## Task 2: Durable subscription state, command semantics and feature activation

**Files:** Create `storage/subscriptions.ts`, `storage/migrations/003-subscriptions.sql`, `tests/subscriptions.test.ts`; modify `storage/engine.ts`, `storage/types.ts`, `storage/database.ts`, `storage/meeting-store.ts`, `coordination/runtime-service.ts`, `coordination/participant-gateway.ts`, `package.json`; tests `tests/meeting-engine.test.ts`, `tests/participant-gateway.test.ts`, `tests/storage.test.ts`, `tests/storage-faults.test.ts`, `tests/recovery.test.ts`.

**Interfaces:** Produce `canonicalSelection(input: unknown): Selection`, `evaluateSubscription(current: Subscription, expectedRevision: number, selection: Selection): {code: "OK" | "SUBSCRIPTION_CONFLICT"; changed: boolean; selection: Selection}` and `eligibleEvent(revision: number, selection: Selection, event: MeetingEvent): boolean` in `storage/subscriptions.ts`; export the interface-map types from `storage/types.ts`. Extend Operation with set-subscriptions and optional chat.topic. Extend `execute(authority, command, version: ParticipantVersion = 1)` and `currentParticipant(authority, credential, version: ParticipantVersion = 1)`; legacy `read` remains a v1 operation. Produce `activateSubscriptions(authority: Authority): Promise<{featureLevel: 2}>` and expose only `runtime.activateSubscriptions(meetingId: string)` in the returned in-process runtime composition, which reacquires current authority; no participant or public RPC operation.

- [ ] Write pure tests asserting regex/32-topic/duplicate limits, deterministic canonical digest despite nested key order, broadcast/controls, unknown/malformed event rejection, `(r0, all) -> r1`, positive no-op, return-to-all, expected-revision conflict and exhaustion. Assert no-op does not consume a revision. Preserve tests for byte-identical legacy digests; topic-bearing chat adds its topic to command identity.
- [ ] Write PostgreSQL tests asserting revision row/pointer/event/outcome atomicity and rollback, no media intention, retry after later revision/leave returns original outcome, wrong secret precedes lookup, changed ID content conflicts, and two expected-revision writers serialize. Assert NOT_MEMBER returns ordinary shape; conflict/no-op seq differs from boundarySeq when appropriate.
- [ ] Write migration/activation tests: preexisting data unchanged; original migration digests unchanged; feature defaults to 1; v2 extended operations at level 1 throw FEATURE_DISABLED with no outcome/mutation; level 2 refuses v1 reads/executes/currentParticipant even on exact retry. Race activation against an execute using the real fence; stale/unready owner activation fails; activation retries and takeover preserve level/history without events or revisions. Baseline Database.open must reject the newer schema in an isolated old-reader test.
- [ ] Run `node --test tests/subscriptions.test.ts tests/meeting-engine.test.ts` and `npm run test:recovery`; confirm meaningful failures before implementing.
- [ ] Add `feature_level` (1 or 2) to meeting_fences; only the maintenance/admin pool may update it. Add `subscription_revisions(meeting_id, participant_id, revision, boundary_seq, command_id, selection)` with participant credential/event foreign keys, revision PK and unique `(meeting_id,participant_id,boundary_seq)` index; add `participant_subscriptions(meeting_id,participant_id,current_revision)` referencing a revision row. Absence means implicit r0/all/B0. Runtime role gets history SELECT/INSERT and pointer SELECT/INSERT/UPDATE, no history UPDATE/DELETE and no feature-level UPDATE. Never copy histories into MeetingState. Register migration 003 without editing 001/002.
- [ ] Implement canonical subscription evaluation inside execute's existing locked transaction, preserving legacy digest/outcome interpretation and auth-before-lookup. Check protocol feature gate after credentials and before lookup, then matching retries before membership/CAS. Keep the v1 grammar strict in the gateway despite the expanded domain Operation union: v1 cannot submit topic-bearing chat or set-subscriptions. Allocate sequence and row only for an effective change; store optional subscription result under `outcome.subscription`. Activation uses the admin pool, exact ACTIVE authority, same fence, and readiness checks before/after. The in-process activation capability is an explicit operator call, never startup/renewal behavior; document an embedding example rather than adding a dashboard/admin listener.
- [ ] Run targeted/default/typecheck plus `npm run test:runtimes` (includes storage/recovery). Update ledger and commit `feat: persist fenced subscription revisions and activation`. Gate: no participant extension or filtering exposed yet; baseline v1 behavior remains unchanged at default feature level 1.

## Task 3: Explicit v2 transport and transactional journal upgrade

**Files:** Modify protocol/gateway/transport/types/agent/journal files in the map; create `client/subscription-replay-validation.ts`; tests `tests/participant-gateway.test.ts`, `tests/client-session.test.ts`, `tests/participant-process.test.ts`, `tests/browser-attachment.test.ts`; update `docs/client-sessions.md`.

**Interfaces:** Consume task 2's `ParticipantVersion`, `SubscriptionCursor`, `SubscriptionReplay` types. Add `protocolVersion?: ParticipantVersion` to ParticipantAgentConfig, default 1; explicitly selecting 2 requests the journal upgrade and v2 route. Keep the v1 transport/validator signatures unchanged for old tests; introduce `ParticipantConnectionV2` with `execute(command): Promise<SubscriptionOutcome>`, `read(credential, cursor: SubscriptionCursor, limit: number): Promise<SubscriptionReplay>`, `media(...)`, `close()`. Use a discriminated v1/v2 transport union in ClientSession rather than number/cursor casts. Add `SessionJournal.open(path, target, options?: {protocolVersion: ParticipantVersion})` and persist protocol choice; reopening an upgraded journal in v1 fails.

- [ ] Add negotiation tests for exact path/subprotocol/body versions and outer ControlWire version 2; v1 cannot submit new operations or decode extended DTOs. Tests assert v2 on feature level 1 can execute legacy operations and that FEATURE_DISABLED/UPGRADE_REQUIRED cause no fallback, new ID or journal loss. Exercise media over v2 with the same authority callback and separate admission budget.
- [ ] Seed a baseline v1 journal with pending JSON strings/order, outcomes, inbox, clock, observation and numeric cursor; upgrade to identity.version 2 plus journal format metadata in one BEGIN IMMEDIATE transaction. Compare preserved values byte-for-byte except explicit version/cursor-format metadata, and assert `(0, existingSeq)`. Inject failure before COMMIT and reopen the intact v1 journal; after COMMIT an isolated baseline reader rejects identity.version 2. Include a pending leave and uncertain screen release. Require offline upgrade before activation; do not silently upgrade a previously unknown v1 journal after positive boundaries exist.
- [ ] Run targeted negotiation/journal tests RED, then implement separate DTO validation and explicit agent selection. A v1 journal rejects new subscription/topic operations before enqueue rather than durably accepting an unsendable command. Add a temporary level-1 v2 r0 adapter that synthesizes scoped from/next cursors and r0 metadata from the unchanged contiguous read; refuse level-2 v2 replay with FEATURE_DISABLED until task 5 replaces it. On the client, the corresponding temporary r0 adapter requires exact scope/from/next and all subscription descriptors equal implicit r0, then delegates contiguous persistence to recordReplay; it never accepts a positive revision or gaps. Task 4 replaces that client adapter with atomic v2 persistence, and task 5 removes the server adapter. This keeps each increment testable without exposing an incomplete filtered path.
- [ ] Run `npm test`, `npm run typecheck`, `npm run test:runtimes`, `npm run test:browser`. Test maximum escaped chat/roster/queue/subscription descriptors within 1 MiB and request limits; slow receivers retain last durable cursor. Update the maintenance guide, ledger and commit `feat: negotiate participant v2 and upgrade session journals`. Gate: v1 stays strict, v2 is opt-in, no filtering yet.

## Task 4: Atomic revision-aware local replay and subscription observations

**Files:** Modify `client/subscription-replay-validation.ts`, `client/session-journal.ts`, `client/client-session.ts`, `client/types.ts`, `client/participant-transport.ts`; tests `tests/client-session.test.ts`, `tests/subscription-replay.test.ts` (new), `package.json`.

**Interfaces:** Produce `validSubscriptionReplay(value: unknown): value is SubscriptionReplay` and `SessionJournal.recordSubscriptionReplay(after: SubscriptionCursor, page: SubscriptionReplay): void`. Add `subscriptionCursor(): SubscriptionCursor` for v2; preserve v1 `cursor()` behavior until journal view selects the configured protocol. `complete(id, outcome)` accepts SubscriptionOutcome and merges subscription metadata atomically with that outcome only, never replay cursor or roster/grant observation. Journal view adds `subscription: Subscription` independently of its replay cursor and snapshot. A merge helper rejects equal-revision contradictions, ignores older subscription descriptors for display, and retains all interval metadata needed for validation.

- [ ] Add fixture tests for exact scope/fromCursor, nonregressing generation/watermark, wrong/missing transition, repeated/reordered/out-of-range events, own versus other participant controls, malformed payloads, returned ineligible topic, known boundary omission, counters and stale-start cursor. Assert r0 gaps still fail with unchanged existing regressions. For positive revision gaps require the explicit scanned-window contract and nearest-boundary metadata; do not infer a transition from a gap.
- [ ] Pin the canonical boundary example in a test: r0 cursor 39, change at 50, beta chat at 49 and 51; applying 40..50 yields cursor `(1,50)` and retains 49. An outcome reporting r3 before this page cannot advance its cursor; replaying r1 after observed r3 cannot replace displayed r3. Same-revision selection/boundary mismatch must roll back the entire local transaction.
- [ ] Inject failure before and after the atomic inbox/metadata/clock/observation/cursor commit, reopen and compare inbox IDs/cursor. Reject a reply whose start differs from current cursor; an exactly repeated applied reply may simply fail stale rather than require a retained page cache. Verify outcome completion and replay crash independently with original pending IDs intact.
- [ ] Run focused tests RED; implement the validator and SQLite transaction. ClientSession passes the entire v2 scoped cursor and limit 16, retains pending-before-replay order/eight-page budget, and checks progress on every non-tail successful page. No snapshot/outcome changes the network cursor; no transport exception synthesizes a command. Register new tests in npm test.
- [ ] Run focused/default/typecheck and browser attachment tests; update ledger and commit `feat: persist atomic subscription replay transitions`. Gate: no runtime filtering yet; local protocol is verified against explicit fixtures.

## Task 5: Bounded durable filtering and failure-oriented acceptance

**Files:** Modify `storage/meeting-store.ts`, `coordination/participant-gateway.ts`; tests `tests/subscription-replay.test.ts`, `tests/storage.test.ts`, `tests/storage-faults.test.ts`, `tests/participant-process.test.ts`; use the existing storage lab runner.

**Interfaces:** Produce `MeetingStore.readSubscribed(authority: Authority, credential: ParticipantCredential, cursor: SubscriptionCursor, limit: number): Promise<SubscriptionReplay>`. Gateway v2 uses this method and projects live roster as v1 does. Remove task 3's temporary level-2 replay refusal and adapter. `readSubscribed` supports r0 at level 1 and all valid revision intervals at level 2; it never changes feature level or subscriptions.

- [ ] Write a simple independent committed-log oracle: for each event choose the last own boundary strictly before its seq and apply broadcast/control/topic eligibility. Generate deterministic schedules varying edits, chat, delayed scans and page sizes 1..16; assert delivered seqs exactly equal the oracle, once each. Include all-hidden pages, boundaries exactly at page end, many queued boundaries, future topic IDs, another participant's changes and return-to-all. Assert each scan spans <=16 raw positions and <=1 own boundary.
- [ ] Add real PostgreSQL tests for invalid interval/scope/revision/cursor, missing raw event row causing consistency failure, tail no-progress only at W, and concurrent read/commit yielding one consistent snapshot. At cursor `(1,60)` with boundaries 70/80 and W100 require `(2,70)` then `(3,80)`, never a jump. Assert snapshot/current metadata can be ahead while historical selection stays correct.
- [ ] Add actual participant process tests that drop subscription command/boundary replies, restart the journal, replace runtime, retry the original command after later revisions and resolve stable outcomes. Verify a v1 exact retry on activated meeting gets UPGRADE_REQUIRED then v2 resolves the same unchanged command; old owner/incarnation and unavailable quorum stay refused. Use real SQL and existing runtime lab; deterministic fixtures alone do not establish these guarantees.
- [ ] Run tests RED; implement indexed current/cursor/nearest-next lookups in one bounded repeatable-read transaction with current fences/auth/membership. Compute S without overflowing `c + L`, fetch every row `(c,S]`, verify raw contiguity before filtering, and include the boundary exactly once with matching descriptors. No scan-to-visible quota, SQL transaction held across reply/media, whole-history fetch or Raft call per event.
- [ ] Run default/typecheck and `npm run test:runtimes`. Record scan/envelope/slow-client bounds and actual results; update ledger and commit `feat: replay committed subscription intervals with bounded scans`. Gate: headless protocol acceptance passes before adapting browser history; do not activate real meetings yet.

## Task 6: Sparse shared inbox, media integration and maintenance acceptance

**Files:** Modify browser attachment/model/bootstrap files in the map, `client/session-journal.ts`, `client/client-session.ts`; tests `tests/participant-ui.test.js`, `tests/browser-attachment.test.ts`, `tests/browser-native.test.ts`, `tests/media-native.test.ts`, `tests/participant-process.test.ts`, `tests/storage-faults.test.ts`; update client/media guides, spec/handoff/ledger.

**Interfaces:** Add `InboxPageRequest = {direction: "after" | "before" | "latest"; anchor?: number; limit: number}` and `inboxPage(request): {events: MeetingEvent[]; after: number; older: boolean; newer: boolean}` to journal/session. Bound queries to limit+1 indexed retained rows (16 at browser ingress), return ascending order, and define `after` as a global exclusive lower display anchor, zero for the first page. Keep existing CLI `view(after,limit)` semantics. Add browser `history(request)` through the existing authenticated attachment; include the same current session view and capture state. Local attachment DTO additions are coordinated with its bundled client; backend participant v2 is a separate version axis.

- [ ] Add sparse history tests with retained seqs `[1, 2, 1000000, 2000000]`: Latest returns all four, Older/Newer never loop through empty global windows, and pages with >16 retained rows have exact navigation flags/order. Assert fixed bounds, browsing position retained across refresh/reload, and the existing legacy storage key preserves uncertainty without using subscription revision as a new key. Prefer inbox anchors over arithmetic on the backend scanned cursor.
- [ ] Add shared browser/CLI tests for concurrent expected-revision submissions and stable conflict/no-op outcomes, command review across lost acceptance/reload, and committed subscription display ahead of replay. Render topic labels and subscription control events as text; show observed subscription revision separately from history cursor revision. Retain commands' stable DOM IDs and exact display release IDs; no topic widget or second session is introduced.
- [ ] Run tests RED; implement indexed local pages and minimal existing-page display changes. Use LIMIT-bound queries in each direction; do not read the entire inbox or re-filter retained rows. Preserve UI canSubmit/review behavior and existing capture/media callbacks.
- [ ] Extend native production media acceptance with explicit v2 agent/journal selection and an activated isolated fixture. Change subscription while replay deliberately lags and camera/display/playback are live: assert no new media effect, release, permission prompt, mute or rebuild is caused by the subscription; controls remain visible, then rerun exact source-ended release, lease ABA, takeover/SFU restart and successor-safe drain. Exercise the existing release-review and shared uncertainty regressions unchanged.
- [ ] In an owned storage lab, test maintenance prerequisites with disposable runtime/recovery logins and sessions only: terminate old sessions, prove revoked logins cannot reconnect, migrate, and show old Database.open/journal readers fail closed. Do not revoke the maintenance account or any real developer/service credentials. Document that this proves the fixture, while actual deployment still requires inventory of every journal/process/login and operator evidence; unknown offline journals block activation. Activation retry creates no event/revision; rollback retains v2 and existing revisions.
- [ ] Run `npm test`, `npm run typecheck`, `npm run test:runtimes`, `npm run test:browser`, `npm run test:media`. Retain sanitized exact commands/results and inspect desktop/mobile history captures if the display changed. Native tests require actual passing runs, not previous evidence. No separate consensus-only run is required unless coordinator code changes (outside scope).
- [ ] Review the full increment against design acceptance criteria 1–7; resolve material findings before claiming protocol completion. Update guides/spec/handoff with verified scope, native/maintenance limits, model/effort and next bounded action; commit `feat: integrate sparse subscription history with shared participants`. Deployment remains a separate authorized task.

## Review record and execution ledger

- Design review: accepts prospective eligibility, CAS, immutable intervals/boundary cursor and maintenance-only v2 activation. Revisions clarify in-transaction v1 gating, monotonic observations, representable counters and sparse display paging. User delegated the approve-or-revise decision; no separate user sign-off is asserted.
- Fresh read-only builder check of the revised design: "nothing important left". Plan review is the author's self-review below, not a second independent review claim.
- Plan self-review: design acceptance 1 maps to task 2; 2 to tasks 2/5; 3 to task 5; 4 to tasks 3/4/5; 5 to tasks 2/3/5/6; 6 to task 6; 7 to tasks 1/6. New test files must be registered in npm test. SQL tests run through the existing owned lab scripts, not bare tests lacking environment.
- Implementation status: all tasks unchecked. This documentation checkpoint runs document/link/scope checks only; historical passing test counts establish no filtering or activation guarantee.
- Documentation verification: 47 local Markdown links resolve, six task gates are present with no completed implementation checkbox, and `git diff --check` passes. Changes are confined to this plan, the subscription design, main spec and handoff; no product tests run for this documentation checkpoint.
- Recommended next model/effort: **GPT-6.1, medium**, task 1 inline. Raise to high only for a concrete newly unresolved protocol case. Continue one task per verified commit/review gate.
