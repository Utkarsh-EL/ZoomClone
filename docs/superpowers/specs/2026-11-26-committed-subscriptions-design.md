# Committed subscriptions and replay revisions

Date: 2026-11-26
Baseline: `f6ffdd6`
Review baseline: `640ae13` (the proposal below was originally grounded in `f6ffdd6`).
Status: accepted with the engineering revisions recorded below, under the user's delegated approve-or-revise review. This records the reviewer's decisions, not separate user sign-off on every choice. The [bounded implementation plan](../plans/2026-11-26-committed-subscriptions.md) is written; no filtering, migration or product code is implemented.

## Intent and boundary

Define durable topic eligibility and cursor transitions before implementing topic filtering. A delayed reader must receive exactly the events eligible under the subscription in force at each event's committed position. A new filter must never reinterpret an acknowledged prefix. Revision zero remains unfiltered.

This task delivers a protocol proposal, worked interleavings and implementation acceptance criteria. It does not implement filtering, SQL/SQLite migrations, topic widgets, new media controls, meeting-code entry, disconnect grace, supervisor features or deployment. Topic subscriptions select durable chat delivery; they do not control membership, permissions, media subscription, capture or publication. Topics are not private channels or an access-control boundary.

Preserve one shared ClientSession/journal for browser and CLI, immutable pending commands and uncertainty, exact release identity, local capture leases, supervised media lifecycles, readiness/renewal and retry rules, SQL owner/incarnation/generation fences, and SFU epoch/caller fences. A snapshot or replay event never authorizes a media effect.

## What exists at the baseline

- `storage/engine.ts` supports join, meeting-wide chat, screen request/release and leave. There is no topic or subscription operation/state.
- `MeetingStore.execute` locks the meeting fence and atomically writes state, contiguous event sequence, command outcome and any media intention. It authenticates before outcome lookup. Matching retries return the original outcome before reevaluating current state.
- `MeetingStore.read` authenticates current membership and ACTIVE ownership in a short consistent read transaction. It returns a current snapshot watermark and an independently paged scanned watermark. It does not filter.
- `ParticipantConnection` sends revision zero; the gateway rejects other revisions and caps replay at 16 events. Participant body/subprotocol v1 and strict event DTO validation have no extension negotiation.
- `SessionJournal.recordReplay` requires contiguous events and atomically persists inbox, observation, Lamport clock and cursor. `ClientSession` processes pending commands before replay, with at most eight pages per pass. Browser display positions are separate from this durable network cursor.
- Production media authorization currently calls `store.read(..., 0, 1)` for a fresh SQL observation. Subscription replay must not turn that call into a filtered or historical authorization path.

These are constraints to preserve, not evidence that the proposed protocol is implemented.

## Approaches considered

| Approach | Tradeoff | Recommendation |
| --- | --- | --- |
| Apply the latest subscription to all replay after a numeric cursor | Small implementation, but a delayed reader changes meaning when a filter changes; newly selected historical events may already be behind its cursor | Reject |
| Reset/rebuild history for each new filter, with historical backfill | Can provide retrospective topic browsing, but needs independent backfill cursors, overlap/deduplication rules and more local history semantics | Defer to a separate explicit history feature |
| Commit immutable per-participant subscription intervals; scan them in order | Additional durable metadata and explicit boundary handling; preserves cursor prefixes and deterministic replay through restart/takeover | Recommend |

The accepted engineering choice is prospective delivery. Subscribing to a topic starts eligibility after that change commits. It does not fetch earlier messages in that topic. Previously delivered history remains in the shared inbox after unsubscribe. There is no automatic backfill or local removal/re-filtering of retained events.

## Topics and eligibility

The proposed new protocol supports:

```ts
type Selection = { mode: "all" } | { mode: "topics"; topics: string[] };
type SetSubscriptions = {
  type: "set-subscriptions";
  expectedRevision: number;
  selection: Selection;
};
// Extend chat with optional topic: string. Omission means meeting-wide broadcast.
```

Topic IDs are case-sensitive ASCII strings matching `[a-z][a-z0-9-]{0,31}`. No implicit case conversion, whitespace trimming or Unicode normalization. A selection holds at most 32 distinct IDs. Validate duplicates as invalid; sort valid sets for canonical persisted command content. Normalize once before journal persistence, never mutate an already pending command. No topic registry, topic creation transaction or wildcard syntax is required. Empty `topics` selects no topic chat; `all` includes present and future topic IDs. Meeting-wide chat is always delivered, including under an empty selection. Legacy chat without a topic remains meeting-wide broadcast; it is not assigned a hideable default topic.

For participant `p`, revision `r` and event `e` in that revision's interval:

```text
eligible(p, r, e) =
  true                                       if r == 0
  true                                       if e is meeting-wide chat
  selection[r] matches e.topic                if e is topic chat
  true                                       if e is a supported control event
```

Supported control events include join, leave, screen changes and subscription changes. They cannot be filtered out, including changes concerning other participants. Unknown event kinds or malformed payloads are protocol failures; do not silently skip them. Topic changes cannot hide membership/grant observations or command outcomes. Membership is checked at read time as today; this introduces no historical membership restriction. A currently joined participant can still replay pre-join history subject to its revision timeline.

## Committed subscription state and commands

Revisions are monotonically increasing safe integers per `(cluster, meeting, participant)`, independent of runtime generation, attachment revision, capture lease revision, grant version and wire protocol version. An existing/new participant starts with implicit revision `0`, selection `all`, beginning at sequence zero. Never repurpose revision zero as a filtered selection.

Persist an indexed SQL revision history keyed by `(meeting_id, participant_id, revision)`, with immutable `selection`, `boundarySeq` and `commandId`, plus a current-revision pointer. Revision zero can be represented implicitly. Positive revisions and their boundary events are retained for the meeting lifetime, as are events/outcomes. The nearest following boundary is found by indexed lookup, not by loading the entire history into a response. Only constant-size current/cursor/next metadata is sent. Revisions survive runtime replacement, detach, leave and any later low-level rejoin of that identity; the existing ClientSession remains permanently left after confirmed leave.

For an authenticated `set-subscriptions` command, inside the existing locked meeting transaction:

1. Perform existing owner/readiness, credential and original outcome/digest checks first. A matching retry returns the original outcome even if later revisions or leave have committed. Changed contents under the same ID remain `ID_CONFLICT`.
2. Require joined membership and compare `expectedRevision` with the durable current revision. A mismatch yields a persisted `SUBSCRIPTION_CONFLICT` outcome without changing the selection or allocating an event sequence. It never automatically rebases/retries as a new command.
3. From revision zero, even explicitly selecting `all` creates revision one. This records deliberate entry into committed revision semantics. For a positive current revision, selecting its identical canonical selection is a successful no-op: persist its stable result, create no event and do not increment revision.
4. Otherwise, allocate revision `r + 1` and the next transactional meeting sequence `B`. Atomically persist the new immutable row/current pointer, and a `subscription-changed` event containing `participantId`, `commandId`, `previousRevision`, `revision` and canonical `selection`. The event sequence itself is the boundary. No media intention is created.
5. Persist a stable subscription-specific outcome with the resulting revision, selection and boundary (and ordinary outcome fields). For conflicts it reports the current revision/selection/boundary observed during that failed command; these may already be historical when read later. Non-subscription outcomes keep their existing semantics. Counters fail before mutation on exhaustion; no wrap/reset.

The new selection applies to events strictly after `B`. The transition event at `B` is delivered while completing the previous interval, and advances the cursor into the new one. Other participants' subscription events are ordinary always-visible controls and do not change this participant's cursor revision. A later return to `all` creates another positive revision, never revision zero.

Two browser/CLI submissions using the same expected revision can both enter the shared durable queue. The first effective change wins in committed order; the other gets a stable conflict, unless it is an exact retry of the original command. No adapter invents a replacement command or clears the shared submission uncertainty guard. A no-op does not consume a revision, so a later command using the same expected revision may still succeed.

For new subscription commands, compute a deterministic digest over fixed semantic fields, including expected revision, selection mode and the canonical topic list; JSON object-key insertion order must not create conflicts. Preserve the existing digest interpretation for already persisted command types/outcomes. For no-op/conflict outcomes, ordinary `seq` remains the meeting watermark at evaluation, while a distinct `boundarySeq` identifies the reported subscription revision's installation; these numbers need not match.

Subscription metadata is separate from the roster/grant `MeetingState`; do not load every participant's revision history into state or snapshots. A subscription-specific outcome adds `subscription: { revision, selection, boundarySeq }` only when an authenticated member reaches subscription evaluation (OK/no-op/conflict). A NOT_MEMBER outcome keeps the ordinary outcome shape. Keep existing outcome bytes and legacy operation digests unchanged. New revision/boundary/cursor counters use the current client validator's representable range, `0 <= n < Number.MAX_SAFE_INTEGER - 4`; reject exhaustion before mutation rather than committing a value the journal cannot accept.

## Cursor meaning and transitions

The network cursor is `(clusterId, meetingId, participantId, subscriptionRevision, seq)`. Cluster and participant may remain implicit in the authenticated session/journal binding, but are always validated. It means: all meeting event positions through `seq` have been examined, and every event eligible for this participant in that prefix has been durably recorded locally. It does not acknowledge browser rendering, current membership, media effects or snapshot freshness.

Let `B[r]` be the commit sequence that installed positive revision `r`, and let `B[0] = 0`. Events evaluated under `r` lie in `(B[r], B[r+1]]` when a next boundary exists. Valid cursors carrying `r` lie in `[B[r], B[r+1])`; at the next boundary the emitted cursor already carries `r+1`. For the newest revision there is no upper boundary. Validate sequences against the snapshot watermark as well.

Consequences:

- A cursor at `(r, c)` cannot be relabeled to the latest revision. Return `INVALID_CURSOR` for wrong scope, unknown revision, `c < B[r]`, or `c >= B[r+1]`. Do not repair it by jumping to a snapshot watermark or resetting to zero.
- A cursor in an old revision remains valid even when the current snapshot is many revisions ahead. The server reads that historical selection and stops at its next boundary. It never responds only with `REVISION_CHANGED` and strands the unread prefix.
- The response that scans boundary `B[r+1]` includes the exact transition event and advances directly to `(r+1, B[r+1])`. It never emits the intermediate invalid `(r, B[r+1])`. A lost reply simply causes the old valid cursor to be retried.
- A successful subscription command outcome may arrive before replay reaches its boundary. Save the outcome; do not change the replay cursor, discard unread events, or install its selection as the historical replay selection.

## One bounded replay page

Use an explicitly negotiated participant protocol v2 with its own DTO/validator. A read carries the full scoped cursor and a bounded limit. Within one fresh read-only consistent SQL view:

1. Validate readiness, exact ACTIVE owner/incarnation/generation, credentials and current membership using the existing fences. Capture snapshot watermark `W`, current state and this participant's latest subscription metadata from that same view.
2. Validate input cursor `(r, c)` against durable boundaries visible in that view. Look up the next boundary `N`, if any. Do not infer revision from current state alone.
3. Examine the contiguous raw event window through `S = min(W, c + L, N)` (omit `N` when absent), with `1 <= L <= 16` at the participant gateway. This is a raw-event bound, not a visible-event target. Verify the log contains every position in `(c, S]`; a missing durable row is a consistency failure, never an eligible gap to skip.
4. Apply revision `r`'s eligibility predicate to those rows; return the eligible subsequence in increasing global sequence order. At `S = N`, include the always-visible transition and exact next-revision descriptor. Otherwise return no transition. A page crosses at most one of this participant's boundaries.
5. Return exact `fromCursor`, `nextCursor`, `scannedWatermark: S`, cursor-revision selection/boundary metadata, the nearest following subscription descriptor (or null, even when beyond this page), the optional transition, snapshot `watermark: W`, current subscription metadata and the current roster/grant snapshot. The next descriptor is validation metadata, never permission to advance. `nextCursor` has revision `r+1` only at the boundary, otherwise `r`. `scannedWatermark` equals `nextCursor.seq`.

An empty filtered page may advance `S`. It cannot jump beyond the examined raw window. At the tail `S == c == W`, an empty unchanged cursor is valid; otherwise successful pages must make progress. Snapshot state may be ahead of the scanned cursor, and current subscription metadata may be ahead of the cursor revision; label/retain these independently. No whole-history read, unbounded scan for a matching topic, persistent SQL snapshot or per-message Raft call is added. Wakeups remain hints to perform another durable read. Keep the existing eight-page-per-pass ClientSession budget, transport admission, deadlines and backpressure.

The 16-row cap remains an upper bound; future DTO sizing must account for bounded topic/subscription metadata as well as maximum escaped chat, roster and queue. Verify the serialized envelope bound rather than assuming a new field is free. Slow receivers disconnect and retry their last durable cursor; no in-memory queue becomes the source of truth.

## Shared local persistence and validation

Migrate the existing journal transactionally, preserving credentials, pending JSON command records/IDs/order, outcomes, Lamport clock, inbox and numeric scanned position. The upgraded journal records a format version that old binaries reject, including an identity version they already fail closed on. A revision-zero journal becomes `(0, existingSeq)`; it does not rejoin or reset. Upgrade/deployment ordering below ensures no unrecorded subscription boundary can exist behind that cursor.

For each v2 reply validate exact scope, owner binding, requested `fromCursor`, nonregressing snapshot watermark/generation, safe counters, DTO bounds and all supported state/event schemas before persistence. Verify events are strictly increasing, unique and within `(c, S]`; they match the cursor revision's known selection; and required returned boundary metadata/event agree exactly. Revision zero still requires every position in the window, with no filtering or relaxed contiguity. Positive revisions permit gaps only under the explicit v2 scanned-window contract; a gap alone is never proof of a subscription transition. The trusted authenticated runtime computes eligibility; no cryptographic completeness proof is introduced.

One local SQLite transaction stores eligible inbox rows, historical revision metadata/transition, latest observation, observed subscription state, Lamport maximum and `nextCursor`. Either all commit or none do. Replayed boundary metadata must agree with retained metadata; conflicting events at the same global sequence are errors. A reply whose start cursor no longer equals the journal's current cursor cannot advance or overwrite it. An exactly repeated already-applied reply may be ignored after identity/content checks; stale data must not replace the current observation. A crash before local commit repeats the same cursor; a crash after it resumes with the new revision. Neither case loses eligible events or duplicates inbox rows.

Command completion remains a separate local transaction from replay. It never moves a cursor. A lost command reply retains the original pending command; the successor resolves the same SQL outcome. An acknowledged change updates the displayed committed subscription state, while history progress may still show an older revision. Merge subscription observations from outcomes, snapshots and replay by revision: lower revisions remain historical, equal revisions must agree on selection/boundary, and only a higher revision replaces the displayed committed selection. This merge cannot freshen a roster/grant snapshot or authorize media. A conflict outcome's ordinary seq is not the observation watermark. Browser/CLI use that same state and guard. Tab history remains a view of the union of already eligible inbox events; display positions stay separate and cannot acknowledge/reset network progress. Any display-key migration carries the existing global display position explicitly and cannot trigger a backfill or second session.

Sparse inboxes require indexed local paging by retained rows, not `seq - 16` arithmetic or loops over empty global positions. Latest returns the last at most 16 retained rows; Older/Newer use retained-row anchors with bounded queries and increasing display order. Preserve browsing position and the persisted uncertainty guard across reload. Keep the existing revision-zero display-storage key as a stable legacy inbox key in this increment; it must not vary with the active subscription revision. No new topic-selection widget is required for protocol acceptance; browser attachment submissions and CLI use the same session.

## Protocol activation and media isolation

Protocol version and subscription revision are different axes. `zoom.participant.v1` cannot decode the new operations/events and must not receive modified v1 DTOs or silently filtered responses. Introduce v2 alongside an explicit durable meeting feature level. Existing v1-only meetings stay unchanged and unfiltered until deliberate activation. Before accepting topic chat or subscription changes for an activated meeting, require upgraded runtimes/gateways and upgraded participant agents/journals; v1 requests to that meeting fail clearly with `UPGRADE_REQUIRED`, including execute/read, rather than acknowledging incompatible history. No automatic fallback to v1 or automatic feature activation. Activation is a fenced, idempotent administrative step and produces no subscription revision.

Pin negotiation explicitly: `/v1/participant` + `zoom.participant.v1` + body version 1 retain their DTOs; `/v2/participant` + `zoom.participant.v2` + body version 2 use separate strict DTOs. Reject path/subprotocol/body mismatches. The outer ControlWire envelope remains version 2 for both. An upgraded v2 participant may read/execute legacy operations in a feature-level-1 meeting at revision zero; topic-bearing chat and set-subscriptions return `FEATURE_DISABLED` without executing or recording a command outcome until level 2 is activated. Participant configuration selects v2 explicitly; no negotiation failure silently downgrades or changes a pending command.

Enforce feature level in the same SQL view/transaction as each participant operation, including v1 media authorization. Execute holds the existing meeting fence lock; read uses its fresh consistent view. Check owner/readiness and credentials before exposing feature errors; reject v1 on level 2 before outcome lookup, even for an old command ID. The upgraded v2 agent then resolves that original pending command unchanged. A v1 read already ordered before activation may finish from its preactivation view, whose watermark cannot include new events. No gateway-only cached flag can authorize a postactivation v1 operation. Legacy numeric store reads are v1 reads and fail on activated meetings, never an unfiltered bypass.

Persist feature level 1 by default and permit only 1-to-2 activation. The separately authorized administrative operation takes current RuntimeAuthority, locks the same meeting fence, checks exact ACTIVE owner and readiness before and after work, and idempotently sets level 2 without allocating an event, outcome, revision, grant version or media intention. Participant ingress never exposes activation. Ownership preparation/takeover preserves feature level and revision history; it cannot reset them. Activation racing a command is wholly ordered by the fence. Maintenance must upgrade every retained journal before any positive boundary can commit; an unknown offline v1 journal cannot later be relabeled `(0, seq)` after activation without an explicit recovery design.

The first deployment uses an explicit maintenance upgrade, not mixed-version rolling operation:

1. Pause participant traffic, drain in-flight participant RPCs, and close agent journal handles before journal migration. Original pending command records survive this shutdown unchanged.
2. Drain/stop all runtime and recovery processes using this database. Disable/revoke their old database login credentials and terminate remaining sessions for every runtime/recovery SQL login, including privileged recovery connections. Verify old credentials cannot reconnect; stopping a process or changing a password alone is insufficient to terminate an existing session.
3. Apply the next versioned schema migration through the separately controlled maintenance account; migrate the existing participant journals. Provision replacement SQL credentials only to upgraded runtime/recovery processes, and retain only upgraded runtime routes/incarnations.
4. Start upgraded processes, regain readiness through the existing ownership/renewal protocol, explicitly activate the meeting feature, and resume upgraded agents. Activation refuses unready ownership. A paused old process is insufficient evidence of shutdown.

The existing `Database.open` newer-schema guard prevents baseline binaries from restarting against the migrated database, but cannot stop an already-running old store. SQL access revocation and maintenance shutdown are required deployment preconditions, not guarantees of an activation flag. If the deployment cannot establish these conditions, leave the feature disabled and defer activation; do not invent a safe rolling-upgrade claim. No readiness/renewal interval or Raft metadata format needs to change to perform this maintenance upgrade.

Initial v2 participants remain revision zero and receive every event unfiltered until their own explicit subscription command. Already committed historical chat is unchanged. Rollback after activation is not a revision reset or journal downgrade. Keep v2 capability and disable new topic/subscription submissions if necessary; recovering data into old binaries requires a separate migration design.

Before connecting filtering to participant reads, give media controls a dedicated fresh current-state authorization read (or an equivalently separate internal method). Preserve the current credential/readiness/SQL owner/membership checks and bounded consistent view, including the existing narrowly authenticated departed-peer teardown path. This method must not consult a replay cursor or a topic selection, replay historical grants, bypass the runtime's current authority, or create domain commands. Preserve epoch negotiation before authorization, post-transaction SFU serialization, caller ordering, owner-scoped cleanup, local lease revisions and exact screen request/grant checks. Subscription changes create no media intentions and trigger no capture, release, mute, transport rebuild or playback action. Existing RTP and noninstantaneous revocation limitations remain unchanged.

## Worked interleavings

| Schedule | Required result |
| --- | --- |
| Cursor `(0, 39)`; revision 1 selecting `alpha` commits at 50; `beta` chat commits at 49 and 51 | Scan 40–50 unfiltered, including 49 and the boundary. Commit `(1, 50)`. Position 51 may be skipped under revision 1. |
| Revision 1 selects `alpha`; revision 2 adds `beta` at 70; beta chat at 69 and 71 | Position 69 stays ineligible even if not yet scanned when revision 2 commits. Position 71 is eligible. Old retained beta history from revision zero stays visible. |
| Cursor `(1, 60)`; changes at 70 and 80 already committed; snapshot `W=100` | Finish through 70 using revision 1 and emit `(2,70)`, then through 80 using revision 2 and emit `(3,80)`. The snapshot cannot jump the cursor to revision 3 or sequence 100. |
| Revision 2 page scans 71–79, all topic chat excluded, with a later boundary at 80 | Return no events and `(2,79)`. Next page includes 80 and atomically changes revision. |
| Reply containing boundary 70 lost before local commit | Retry the same prior cursor; receive/commit the same event and next cursor. No second subscription command. |
| Subscription SQL commit succeeds; command reply lost; runtime takeover; agent restarts | Preserve exact command ID/content/expected revision, obtain original stable outcome, then replay prior intervals normally under the replacement's fresh fences. |
| Two different commands expect revision 2; first installs revision 3 | Second yields stable conflict; no new ID, implicit rebase or selection change. A retry of the first returns its original revision-3 result even after revision 4. |
| Old-owner read overlaps takeover, then arrives late | A pre-cutover consistent read may be valid. Existing owner-binding checks and exact local cursor comparison prevent a stale page from overwriting later progress; the next request reacquires authority. |
| Grant/leave changes at the same time as subscription change | Meeting fence orders commands. Grant/control events remain eligible, and fresh snapshot/media checks still govern local reconciliation. Confirmed leave still stops ClientSession; no promise to drain unread history after departure is added. |

## Acceptance criteria for later implementation

These are required verification cases, not tests run by this documentation task:

1. Pure engine/storage tests cover revision-zero default, topic validation/broadcast, empty/all selections, positive no-op, return-to-all, expected-revision conflicts, stable retries/digest conflicts, nonmember refusal and counter exhaustion without partial writes.
2. Real PostgreSQL checks prove boundary, state, selection row/pointer, event and outcome commit/rollback together under the existing fence. A replacement runtime retains intervals and resolves a lost reply; old owners and wrong incarnations remain refused. Do not substitute an in-memory fixture for this claim.
3. Replay tests compare delivered IDs against a simple committed-log oracle under many changes and delayed scans, including changes exactly at page ends, all-hidden windows, multiple preexisting boundaries, concurrent chat and snapshot/live wakeups. Verify no lost eligible event, ineligible topic event or duplicate inbox row.
4. Journal tests crash/reopen before and after local boundary persistence, and between SQL outcome and local completion. Reject wrong cluster/meeting/participant/revision, cursor outside its interval, fabricated jump, malformed transition, omitted boundary, duplicate/out-of-range events, missing raw rows, regressing observations and stale replies. Preserve the existing v1 revision-zero gap-rejection regressions unchanged.
5. Migration/protocol tests retain the exact journal identity, all original pending commands, uncertainty and inbox position; old readers fail closed. Prove activated meetings reject v1 and incompatible owners cannot serve them. Maximum escaped payloads plus new metadata fit bounded responses. All-hidden scans and slow clients retain page/pass/output bounds.
6. Browser/CLI integration uses the same journal and stable command outcomes across concurrent edits/reload; no adapter retries uncertain acceptance or resets history. Verify monotonic displayed subscription observations after historical outcomes and bounded sparse inbox paging across large global sequence gaps. Re-run release-review, exact display release and shared submission-guard regressions.
7. Once media authorization reads are separated, run the existing native participant and production media acceptance with topic changes while replay lags. Prove controls remain observed, no media action is caused by subscriptions, fresh SQL membership/grants govern controls, and local lease, takeover, SFU recovery and drain guarantees persist.

Run the existing default tests/typecheck and appropriate storage/runtime/native suites for the code actually changed. Do not claim historical evidence validates filtering or deployment. Keep schema migration, protocol/journal transition, filtering and UI integration as separately reviewable implementation increments after this proposal is approved and a plan is written.

## Review decisions and continuation

The proposal at `640ae13` had a fresh read-only builder review conditional on enforceable offline upgrade. This review accepts its prospective eligibility, broadcast/control visibility, expected-revision CAS, immutable intervals, old-interval boundary delivery and bounded raw-window scan. It retains explicit maintenance activation and revises its enforcement as specified above. Latest-filter replay, cursor relabeling/backfill and mixed-version rolling activation remain rejected/deferred.

Additional implementation decisions: separate subscription metadata from roster/grant state; merge displayed subscription observations monotonically without moving replay; preserve byte-identical legacy commands/digests; use counters the current journal can represent; replace dense-sequence display paging with indexed retained-row paging. The [plan](../plans/2026-11-26-committed-subscriptions.md) assigns these to explicit verification gates. No SQL/SQLite migration, feature activation, filtering or product verification has run in this review task.

A fresh read-only builder check of this revised design returned "nothing important left". This is a planning-readiness review, not an independent verdict on implementation, migration execution or deployment safety.

Recommended next model/effort: **GPT-6.1, medium** for plan task 1 (fresh media authorization isolation). Use high if implementation reveals a concrete unresolved activation/cursor interleaving; extra high is not the default. These are engineering judgments, not measured comparisons.

Suggested continuation: "Continue from the subscription review/plan checkpoint and updated handoff/spec. Read docs/superpowers/specs/2026-11-26-committed-subscriptions-design.md and docs/superpowers/plans/2026-11-26-committed-subscriptions.md. The design is accepted with recorded engineering revisions; no filtering or migration is implemented. Execute only task 1, fresh media authorization isolation, inline with GPT-6.1 medium. Preserve revision-zero contiguity, one shared ClientSession/journal, immutable pending commands and uncertainty, exact release identity, all media lifecycle/readiness/renewal and SQL/SFU/local lease fences. Run the task's targeted/default/typecheck/native verification, commit the verified increment and update the ledger/handoff. Stop at that review gate before schema/v2/filtering work."
