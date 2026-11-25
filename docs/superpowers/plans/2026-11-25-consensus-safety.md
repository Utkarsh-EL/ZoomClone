# Consensus safety implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve the reproduced coordinator consensus failures with auditable code and failure evidence before ownership integration.

**Architecture:** Carry a local Go-module replacement of the checksum-verified HashiCorp Raft v1.8.0 sources, retaining its license and upstream tests. Record the exact proposed upstream fixes and separately identified local corrections. Existing coordinator protocol and PostgreSQL components remain separate until this gate passes.

**Spec:** [Distributed meeting redesign](../specs/2026-11-21-distributed-meeting-redesign.md), especially durable consensus, membership and recovery evidence.

## Engineering choice

The user delegated library and implementation choices. A released fixed upstream dependency would be preferred; none is available. Simply importing open PRs #734/#735 leaves snapshot publication/deletion crash and error gaps, identified by an independent review. A local patch preserves the current persistent integration and has a small reviewable production delta. Switching to etcd/raft would require a new durable storage/message/membership driver; that larger adapter is not automatically safer. The cost of the chosen approach is carrying and reviewing a local fork until a suitable upstream release replaces it.

## Invariants and review focus

- A follower may advance commit only through the prefix proven by the particular append, and may not regress it.
- Snapshot preparation is read-only. A local commit index can lag global commitment, so a failed transfer must preserve the durable tail. Publish the replacement durably, then reconcile before service; startup repeats reconciliation before voting after any publication/cleanup crash.
- A failed cleanup must not permit subsequent appends/elections to reuse a conflicting snapshot/log state. Restore coherent log hints/configuration before any recoverable error path.
- An older snapshot must not rewind an already applied FSM or membership.
- A matching retained configuration suffix must remain represented in the library's pending configuration after snapshot restore.
- A failed leader log write must stop the node before another election. Failed membership persistence must not install an unwritten configuration or alter quorum/replicators.
- Pre-fix application histories are not repaired automatically. Fresh labs use explicit new identities; old stores must not silently enter ownership service.

## Task 1: Auditable dependency repair

- [x] Copy the complete pinned module (69 original files), including sources/tests, manifests and license, into `third_party/hashicorp-raft`; retain source checksums/provenance and a small production diff.
- [x] Add regression tests covering append commit bounds, older snapshots, matching configuration suffix, snapshot failure/deletion ordering and restart. Observe RED against unpatched code.
- [x] Apply the append correction proposed in PR #734. Adapt PR #735 with durable publication, post-publication cleanup, mandatory startup reconciliation, fail-closed errors and coherent configuration/log-hint handling. Run the new tests, upstream suite and race detector.
- [x] Switch `services/coordinator/go.mod` to the local replacement; make the original safety regressions unconditional. Require new application storage and envelope compatibility markers for pre-fix histories/helpers.

## Task 2: Live partition evidence

- [x] Add source-specific loopback route configuration to the helper transport, with tests proving all consensus/control peer requests use the route.
- [x] Build TCP fault proxies in test utilities and partition a real five-voter helper cluster into 2/3. Propose on the isolated old leader, prove majority progress and minority refusal, force snapshot catch-up, heal and restart the former owner without ghost outcomes.
- [x] Preserve configured membership; retain guarded admission/promotion tests and exercise removal to four voters after recovery. Verify normal helper and five-process tests.

## Task 3: Review and record

- [x] Independent review of the small local production diff, startup compatibility gate and new failure tests. Fix material findings with failing regressions, including synchronous failure of an unwritten membership change.
- [x] Run coordinator/upstream race, TypeScript/Node and process checks appropriate to the actual changed paths. Record limitations; a passing suite is evidence, not a consensus proof.
- [x] Update guide/handoff/README so normal tests include all resolved safety cases; commit on `milestone-5` and keep further ownership activation gated on its own reconciliation tests.

Final evidence: [consensus checkpoint](../../consensus-safety.md) and [recorded results](../../../evidence/consensus_run/result.json). The actual production delta changes five original files; original upstream tests remain intact. Full fork race suite passed in 131.883 s, helper race suite in 13.609 s, followed by vet/build/five-process checks. All 62 Node tests and TypeScript checks passed. Storage code was unchanged by this checkpoint; its eleven Docker cases passed in the preceding storage batch.
