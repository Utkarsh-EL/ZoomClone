# Supervised participant media controls

Continues `9240bce` plus the effort guidance in `5bf5067`, the updated handoff and distributed meeting spec sections 9–11. Execute inline on the authorized `milestone-5` checkout. Existing production bridge, shared ClientSession/journal, readiness, SQL ownership, SFU epoch/lease fences and unfiltered revision zero remain authoritative.

## Lifecycle decisions

One supervised media controller per browser attachment. Opening/rebuilding transports has a monotonically increasing operation revision; serialize opens so a late server open cannot replace a newer peer. Every transport callback binds its transport, operation revision and epoch. Invalidate synchronously on shutdown, membership loss and departure. Ignore stale results and close late browser resources. Reconnect retains only the exact live capture entry and lease revision; permission is never requested automatically.

Capture tracks and pending permission requests reconcile against the latest observed membership and exact screen request/grant version. A changed local lease revision cancels even same-tab loss/reclaim. Snapshot observations only cancel work; fresh runtime/SQL authorization still admits every effect. A failed backend read alone does not claim physical revocation. Stop remains available during command uncertainty.

Screen ended/explicit Stop releases the captured request through ParticipantModel's persisted single-flight uncertainty guard. If that guard is busy, uncertain, stale or a shared release/leave is pending, stop locally and retain an explicit release-needs-review status; never auto-submit later or invent a replacement command. A lost reply preserves the original command review across reload.

Supervision has one nonoverlapping tick, bounded reconnect attempts and explicit retry after exhaustion. It polls current producer availability, rebuilds transports without rejoining and distinguishes transport readiness, actual publication and muted/blocked playback. Capture starts only on explicit interaction; remote playback is initially muted with an explicit play/unmute action.

## Tasks and verification

1. **Lifecycle and cancellation:** add deterministic RED regressions in media-capture tests for changed grants/membership, lease ABA, stopped reconnect and overlapping opens/callbacks. Implement capture reconciliation and serialized revision-bound MediaLab operations with injectable Device for deterministic interleavings. Run targeted tests, full default suite and typecheck; commit.
2. **Participant controls and supervision:** add model/controller regressions for ended-release uncertainty, busy guard, leave and bounded reconnect. Integrate optional media configuration with the participant page, explicit mic/camera/display stop/start, playback and status using existing design. Extend native production media acceptance to operate real controls and recover automatically. Run default/typecheck, native media and native participant browser checks; commit.
3. **Review and handoff:** one independent read-only review of the full increment; reproduce/fix Important findings RED→GREEN. Retain exact sanitized verification evidence and limits, update production guide, spec and handoff; commit verified changes. No deployment/push/merge requested.

## Execution ledger

Baseline: clean `5bf5067`, default 107/107 passed. Read handoff, spec, production guide/plan, capture/transport/model/attachment and native acceptance. Repository safe.directory is command-local due to sandbox account ownership; no global Git settings changed. Existing plan authorizes working in place.

Pre-flight: task 1 provides cancellation/reconciliation and events consumed by task 2; task 2 supplies guarded release callback rather than a second domain submission path. Existing media harness remains supported through the default callback. UI changes preserve DESIGN.md tokens and existing page structure. Impeccable launcher unavailable (cache write/network); read existing design directly.

Task 1: complete. Five new deterministic regressions reproduced missing reconciliation, same-tab lease revision ABA, overlapping opens and canceled Device.load, then passed with revision-bound serialized opens and capture reconciliation. Targeted 14/14; default 112/112; typecheck passed. Browser transport callbacks pin the original operation revision/epoch. Reconnect retains exact capture entries and checks them again after publication. No native acceptance claimed for this increment. RED harness initially retained an unbounded wait after the expected Device injection failure; bounded that wait and stopped only its two owned Node processes.
