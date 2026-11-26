# Participant UI implementation

Continue the authorized design in [the redesign spec](../specs/2026-11-21-distributed-meeting-redesign.md), sections 9–10, and the [handoff](../handoffs/2026-11-25-distributed-meeting-redesign.md), at `e4ded77` on `milestone-5`. Execute inline in the existing checkout; implementation choices and verified commits are already authorized. No new dependencies.

## Design and boundaries

Operate surface: quiet warm-neutral background, white conversation area, restrained green actions, system sans typography. Desktop conversation plus a roster/share sidebar; narrow screens stack sections. Show actual retained state, explicit empty states, keyboard labels/focus and readable long content. No pretend media tiles or capture permissions.

Use only `BrowserAttachment`: no second identity, journal, join, backend connection or retry loop. Separate local attachment connectivity from the agent's connection state and snapshot freshness. Render all revision-zero event kinds, ordered by sequence. Pages contain at most 16 events; tab-local page positions never modify the durable replay cursor. Follow latest is explicit and history browsing stays put through polling/reload. Retain uncertain submission warnings across reload, never automatically submit again, and require deliberate review to clear the warning. Surface original command IDs, contents and outcomes. Share release/cancel binds the observed request ID; local capture actions use the observed capture revision. Leave is an explicit durable command; tab close is only detach.

## Task 1: bounded state and actions

Add `client/participant-model.js` with `ParticipantModel(attachment, {load, save})`, `refresh`, `older`, `newer`, `latest`, `submit`, `capture`, `reviewUncertain`, and `dispose`. Dispatch change events. Keep only one bounded event page and serialize reads; gate writes while busy, left, leaving or uncertain. Expose derived own share and pending status for the renderer. Save only display position/uncertainty in tab storage, scoped by cluster/meeting/participant/revision zero.

Write `tests/participant-ui.test.js` first, exercise multi-page replay, live tail, reload position, delayed read ordering, single submit, uncertainty/reload/manual review, CLI pending leave and stale capture. Run RED then GREEN, add to `npm test`, run full suite and typecheck, commit.

## Task 2: usable participant interface

Replace diagnostic bootstrap with a DOM renderer/controller using the model. Add fixed HTML/CSS/modules to the attachment asset allowlist; extend CSP only for same-origin stylesheet. Text content uses DOM text nodes. Show roster, all history event types, older/newer/latest controls, composer with UTF-8 byte validation, pending/outcome details, exact share queue/request/release, explicit leave and capture owner/replacement/release. Show snapshot observation and page range separately from connection status. Preserve `globalThis.attachment` for native integration diagnostics.

Extend native Chrome tests to operate real controls, reload, inspect commands from the CLI, page history, race capture ownership, submit leave and verify close never implies leave. Include long/untrusted content and desktop/mobile screenshots in a bounded inspection round. Run native tests, default suite and typecheck, commit.

## Task 3: review and evidence

Fresh reviewer checks `e4ded77..HEAD`, the spec/handoff and this plan, including UI screenshots. Fix material findings with reproduced regressions. Run appropriate full checks including existing runtime process suite if available. Document exact scope and limits in `docs/client-sessions.md`, current spec status and the handoff; record checked evidence and commits. Do not claim media, subscriptions, disconnect grace or deployment complete. Commit docs/evidence and finish with a copyable continuation and model/effort.

## Review focus

- Lost submit reply after local journal commit; do not create a replacement operation.
- Delayed page reads, new events during history browsing, reload positions and bounded memory.
- CLI-issued pending leave/request/release and changes from another browser tab.
- Long names/content, untrusted text, keyboard operation and mobile overflow.
- Capture replacement/revocation, stale compare-and-set and exact share request identity.

## Execution record

- Baseline: `npm test` 65/65; `npm run typecheck` passed. Clean checkout at `e4ded77`. No repository AGENTS.md or existing PRODUCT.md/DESIGN.md found. Impeccable context launcher unavailable because engine cache is not installed; project context read directly.
- Task 1: complete. New model tests RED (missing model) → GREEN 8/8; full `npm test` 73/73, typecheck and diff whitespace passed. Uncertain-submit guard is saved before sending, so interruption during the acceptance reply remains visible after reload. Tab close still only detaches.
- Task 2: complete. Native UI assertion RED on diagnostic page → GREEN after implementation. `npm test` 73/73, typecheck, native Chrome 1/1 and diff whitespace passed. Native coverage includes retained 49-event paging/reload, untrusted text, CLI IDs, queue cancellation, capture replacement/release, explicit pending leave, resolved request/grant/release/leave through a deterministic engine transport, interrupted UI reply across reload, and manual review without resubmission. Desktop 1440px and mobile 390px captures under `evidence/participant_ui_run` were opened and inspected in two bounded rounds. Latest now scrolls to the newest event even when its page contents did not change. The initial native test assumed the wrong offline state, and its old CLI comparison used 200 events against a 16-event browser page; both assertions now reflect the existing contracts. A stalled background-tab screenshot run was stopped; bounded CDP calls and foreground capture prevent that harness hang. No backend protocol changed.
- Final review: independent read-only code/UI review of `e4ded77..5da8e94` found two Important issues and no Critical issues. The visual composition was suitable at the two supplied viewport sizes; disposition **fix**, requiring the two behavioral fixes, with no rebuild or further screenshot round warranted.
- Final: fixed pre-acceptance read reuse — `accepted submit waits for a post-acceptance view before enabling another share request` RED→GREEN. Drain an old read and require a fresh view before clearing the write gate. Related `failed post-acceptance view keeps actions disabled until shared commands can be inspected` also RED→GREEN. Full `npm test` 75/75 and typecheck passed.
- Final: fixed collapsing command details/lost keyboard focus during CLI traffic — native Chrome regression RED→GREEN. Reconcile retained command nodes by ID instead of replacing the list; open state/focus remain intact. Native browser suite 1/1 passed. Existing real Docker suite passed 16/16 in `zoom-storage-4378ecef` at `5da8e94`; later fixes affect browser display/model JavaScript only, so no later runtime rerun is claimed.
- Final: minor (deferred): departed authors may display a short participant ID because the live snapshot omits departed names. A bounded historical-name source needs a later read/API design; current attribution remains identity-correct.
- Final: Ruling: media/capture/SFU/playback remain follow-up work, as explicitly scoped — logical grants/leases are labeled accurately; cost if mistaken is missing full media acceptance, not weakened fencing.
- Final: Ruling: subscriptions and disconnect grace remain separate, as explicitly scoped — keep revision zero unfiltered and do not add eviction timers; cost is incomplete broader design functionality.
- Final: Ruling: screenshots demonstrate synthetic retained state only — real SQL/runtime behavior is separately covered by the 16-test suite; cost is no live-SQL visual-integration claim.
- Final: Ruling: full screen-reader announcements and keyboard traversal were not independently exercised — native regression covers command-summary focus and semantic labels/focus styles are implemented; cost is residual accessibility coverage risk.
- Final: Ruling: Impeccable detector did not run because its engine is unavailable — two manual screenshot rounds and independent UI review stand; cost is possible unreported automated design findings.
- Final: Ruling: subsequent fixes are verified by reproduced regressions and full tests, not a second independent review — cost is no independent endorsement of the final fix diff.
