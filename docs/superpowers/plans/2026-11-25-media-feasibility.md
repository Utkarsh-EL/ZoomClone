# Bounded capture/SFU feasibility implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Track verification and decisions below.

**Goal:** Prove two native browser participants can capture and exchange real RTP through mediasoup, including capture failures, stop, local revocation and SFU restart.

**Architecture:** Keep the existing participant page and durable session protocol. An explicitly enabled experimental attachment media bridge calls a serialized host media adapter; it authenticates through fresh `MeetingStore.read(RuntimeAuthority, credential)` before each new control. A private Linux container owns transient mediasoup workers/transports. Its internal control endpoint accepts only the adapter capability and stamped envelopes. No SQL transaction spans an SFU call.

**Tech Stack:** Existing Node/TypeScript, PostgreSQL, Go Raft helpers, Chromium CDP, pinned mediasoup 3.32.2, mediasoup-client 3.26.0, esbuild 0.28.2.

**Spec:** `docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md`, sections 7, 9–11; continuing `cbc3a47` and its handoff.

## Global constraints

- One ClientSession/journal per participant shared by browser and CLI; preserve pending IDs, inbox and uncertain acceptance.
- Subscription revision zero remains unfiltered. Runtime routes/incarnations stay provisioned.
- No Raft storage, SQL schema, readiness or retry-jitter changes.
- New work checks exact ACTIVE SQL ownership and membership. Screen publication additionally binds committed holder request/grant version and the attachment capture lease.
- Serialize media fences and effects. Close old screen before successor; fresh checks and media effects are not one distributed transaction.
- Capture is explicit. Permission denial/cancel and late capture completion must stop cleanly. Local capture replacement stops old tracks without releasing another tab's logical SQL grant.
- This is an opt-in feasibility adapter/harness, not full participant media integration, a supervisor or school-network proof.

## Review focus

Check late permission completion after revocation, in-flight publish/revoke ordering, stale grant/runtime requests, unavailable authorization and SFU epoch changes. Check shutdown/backpressure, capability/credential exposure and exact stop-release command identity.

### Task 1: Serialized authority adapter

Files: `media/room.ts`, `tests/media-room.test.ts`, package test command and TypeScript include.

- [x] Write and observe failing tests for fresh authorization, exact grant/lease, ordered revocation/fencing, denied reads and bounded admission.
- [x] Implement `MediaRoom.handle(context, request)` and `revoke(peerId)` with bounded serialized work and no cached authorization.
- [x] Run targeted tests, default suite and typecheck; commit verified increment.

### Task 2: Native capture and mediasoup kernel

Files: `services/media/`, `media/kernel-client.ts`, `client/media-lab.js`, experimental additions to browser attachment and tests, `scripts/media-build.ts`.

- [x] Verify attachment media is absent by default and invalidated peers cannot publish; implement opt-in bounded async bridge and capture cleanup.
- [x] Implement private stamped/capability-protected mediasoup control, per-room fences, producer bounds and epoch reporting; build container and browser bundle.
- [x] Exercise two real Chromium contexts against SQL/runtime authorization, including denied camera permission, canceled display picker, display track ended, lease replacement, SFU crash/restart and independent chat.
- [x] Verify received audio bytes and decoded video frames in both browsers; commit verified increment.

### Task 3: Evidence and continuation

- [ ] Run default/typecheck/browser/runtime checks appropriate to changed paths; retain exact native evidence and limits.
- [ ] Review whole diff with a fresh reviewer, fix reproduced important issues, update handoff/spec/guide and commit.

## Execution ledger

Existing handoff delegates implementation judgment, tools and verified commits. Work continues in place on `milestone-5`; no additional worktree. The user requests a bounded feasibility increment, so the existing approved architecture supplies the design. The implementation choice is the proposed mediasoup service plus an opt-in harness, leaving full product media UI for a later increment.

Interfaces: Task 2 consumes Task 1's `MediaRoom` and supplies an effect client. Task 3 verifies their integration. Media effects remain transient and never enqueue or replay domain commands automatically.

Task 1 complete: 3 adapter tests failed with the unimplemented adapter, then passed. Default suite 78/78 and typecheck passed. Revocations bypass ordinary admission so a full queue cannot drop cleanup. Container dependency build also succeeded; native transport feasibility is still pending.

Task 2 complete: `npm run test:media` passed with two distinct native Chromium processes, real SQL/helper/runtime authorization, inbound audio bytes/decoded camera and display frames, native permission denial/dialog rejection/source-ended release, stale grant rejection, server and local lease revocation, SFU crash with successful concurrent chat, explicit transport reconstruction/new epoch, unchanged identity/commands/revision zero, and stopped-runtime refusal. Native body 24.85s, owned storage lab `zoom-storage-b4e2faf1`. Default 86/86, existing native participant UI 1/1 and typecheck passed. The kernel image built successfully.

Observed failures and fixes: DevTools does not accept top-level await in ordinary evaluation (use dynamic import continuation); current-tab dialog selection differs from selected-tab capture (test each native path explicitly); esbuild ancestor reads require elevation in this sandbox. Compressed renewal scheduling exposed explicit pre-effect NOT_READY; the adapter client retries only that rejection with a bound and jitter (RED→GREEN). The harness uses existing production-default 500ms renewal/2000ms readiness, with no production scheduler changes. Compose health can observe the temporary initialization server; the harness now probes the published SQL TCP path before migrations, without replaying any migration or domain command. Explicit stop during pending permission and repeated revocation were reproduced RED→GREEN and fixed with per-source attempts and coalesced cleanup.
