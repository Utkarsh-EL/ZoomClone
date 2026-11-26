# Ownership activation checkpoint

The `milestone-5` redesign connects committed Raft candidate assignments to PostgreSQL fences through a headless reconciliation library. The original participant/peer/video demos have been retired to Git history. This checkpoint is not a deployed meeting service.

Run with Node.js 24.16+, installed npm dependencies, Go 1.26+ and Docker Desktop:

```sh
npm run test:recovery
npm run test:coordinator
npm test
npm run typecheck
```

`test:recovery` builds the helper and provisions an isolated persistent PostgreSQL lab. It runs the eleven storage/fault checks followed by the recovery integration tests. Only owned processes and Compose services are stopped; database volumes and per-helper stores/traces under `.local/` remain available. `scripts/recovery-step.ts` is a bounded crash-evidence child, not a production runtime. Credentials remain in ignored lab files/environment, outside evidence summaries.

## Activation stages

| Durable state | Reconciliation action |
| --- | --- |
| Raft reservation without assignment | Conditionally choose a registered runtime incarnation and unique attempt; advance generation. |
| CANDIDATE, first generation without SQL meeting | Create the initial SQL meeting idempotently. |
| CANDIDATE, older SQL fence | Install the exact candidate's RECOVERING fence. This SQL commit cuts off the old owner's write prefix. |
| CANDIDATE, matching RECOVERING fence | Candidate prepares from a bounded consistent SQL snapshot; conditionally record INTENT in Raft. |
| INTENT, matching RECOVERING fence | Prepare again after restart, then enable SQL ACTIVE. |
| INTENT, matching ACTIVE fence | Prepare and conditionally confirm READY in Raft. |
| READY | Require matching SQL ACTIVE before reporting ready; runtime must separately renew before serving commands. |

The controller advances one durable stage per tick. Each retry starts from a committed Raft barrier read and a fresh SQL observation. A lost reply is uncertainty: the next tick resolves durable state before repeating a stage. Same-generation SQL installation and activation are idempotent. Higher SQL generations reject late old activation; higher Raft generations reject late readiness confirmation. No Raft or runtime call runs inside a SQL transaction.

Only first-generation CANDIDATE creation may initialize an absent meeting. Missing durable state for an established meeting fails closed, including missing state behind an otherwise valid ACTIVE fence. Durable events, outcomes and media intentions remain in PostgreSQL and are read on demand; preparation does not copy them into coordinator state or rebuild an empty room.

## Runtime readiness and failure suspicion

`RuntimeAuthority` starts unready. A successful refresh reads the current exact READY assignment, commits a revision-guarded renewal, and checks the matching SQL ACTIVE fence. Readiness expires against a local monotonic deadline measured from the start of that work. An uncertain renewal clears readiness immediately. Calling `stop()` invalidates in-flight refreshes so late replies cannot re-enable service. Every command still validates the SQL fence within its own transaction; local readiness is not a certificate or a cross-machine lease.

`RecoveryController.run` runs without the dashboard. Its leader-local suspicion timer observes assignment generation, phase and committed renewal revision. Duplicate renewal IDs resolve their original result and do not advance the revision again. A timeout proposes a replacement with the observed generation and renewal revision; a newer renewal rejects that stale proposal. Leadership identity includes helper incarnation and Raft term. A new leader or uncertain leadership starts fresh grace. Candidate/storage failures preserve suspicion under confirmed unchanged leadership, allowing an unavailable candidate to be replaced. No timeout changes voter membership.

Defaults are a 5 s suspicion interval, 2 s runtime readiness window and 100 ms reconciliation loop interval. These are configurable demo observations, not measured service-level guarantees. The later [remote runtime checkpoint](remote-runtimes.md) supplies authenticated provisioned candidates and runtime registration/renewal scheduling. `Candidate.prepare` adapters must finish or fail within a bounded interval; the supplied SQL preparation is bounded by database timeouts. Automatic discovery remains a later integration boundary.

## Evidence and review

The real three-helper/PostgreSQL scenario kills a recovery child with SIGKILL after each of ASSIGNED, CREATED, FENCED, INTENT, ACTIVE and READY, then resumes from a new process. It verifies retained participant state and stable command outcomes after takeover, rejection of the returning owner, candidate failure replacement, elapsed readiness, stop during refresh, leader change with fresh grace, a headless run-loop tick, missing durable state refusal and quorum-loss refusal. A second real-helper/SQL test loses replies after each Raft/SQL commit, verifies retry of the same attempt, and checks that uncertain renewal cannot retain readiness.

The independent review found two important issues, reproduced and fixed: candidate preparation errors continuously resetting suspicion, and periodic renewal outcomes filling the 1 MiB authority reply. Authority reads now project current metadata without attempt/outcome history; snapshots retain that history for retry resolution. A Go regression checks authority-read size with 5,000 retained outcomes. The stop-during-refresh regression also failed before its fix. See [recorded results](../evidence/recovery_run/result.json) for checked commands and coverage limits.

## Compatibility and remaining boundaries

Coordinator store version is **3**. Preserve version 1/2 directories; do not edit identity markers to reuse incompatible histories. Start fresh helpers for this checkpoint. The envelope remains version 2, so wire compatibility does not establish a supported rolling mixed-version upgrade.

Retained command outcomes still grow in coordinator snapshots, whose existing maximum is 32 MiB. This checkpoint fixes authority reply growth, not long-term history retention/garbage collection. At the theoretical JavaScript safe-integer limit, renewal transition and restore bounds differ by one; this is a deferred minor issue.

This checkpoint's candidate adapters and storage calls are trusted in-process boundaries. Its tests use real independent helpers and a real database, with process crashes of the headless recovery driver. The subsequent [remote runtime checkpoint](remote-runtimes.md) adds authenticated loopback runtime processes and scheduling. Neither establishes participant reconnect, media recovery, automatic discovery/placement health, arbitrary adapter cancellation or full failure-detector behavior under injected network partitions. There is no media readiness claim. Complete gateway routing, 128-bit Chord, durable ClientSession replay, SFU feasibility and supervisor/dashboard remain later work.
