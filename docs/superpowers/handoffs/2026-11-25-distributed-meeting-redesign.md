# Distributed meeting redesign handoff

Date: 2026-11-25
Status: coordinator and PostgreSQL storage foundations implemented on `milestone-5` from `milestone-4`. Reproduced Raft safety failures block live ownership integration. The full redesign remains in progress.

## Implementation update

The user subsequently authorized implementation judgment, branch selection, commits, and tools. The [first implementation plan](../plans/2026-11-25-coordinator-foundation.md) scopes an independently testable durable coordinator checkpoint; [the guide](../../coordinator-foundation.md) documents commands, evidence, dependency findings, and limits. The original assignment/spec content is preserved as design input.

Implemented in this checkpoint: deterministic reservation/runtime/candidate metadata, durable HashiCorp Raft helpers, stamped authenticated loopback transport, guarded nonvoter admission/promotion/removal, TypeScript bridge, and checked independent-process crash/restart/snapshot/quorum scenarios. Existing participant/peer/media demos remain separate. Candidate assignment is not effective PostgreSQL ownership.

An independent code review's RPC validation, lost-store identity, and durable-clock findings were fixed with failing-then-passing regressions. Final verification: 57 Node tests, 19 Go test functions plus subcases, Go vet/race detector, TypeScript checks, five-process integration, and standalone demo. The guide links the recorded timeline and explains the remaining dependency/failure-model limits.

Important review finding: pinned Raft `GetConfiguration().Index()` returns zero. Use the library's committed `ConfigurationStore` callback and snapshot that index; never disable membership version guards with zero. Open upstream log/snapshot safety reports require evaluation and adversarial suffix evidence before external ownership integration. See the guide for links. No broad consensus-safety proof is claimed.

Docker is installed but its daemon was unavailable during this checkpoint. PostgreSQL fencing, recovery reconciliation, Chord integration, ClientSession persistence/replay, SFU feasibility, complete proxy routing, supervisor, and dashboard remain future batches. The next evidence should cover dependency log/snapshot safety and PostgreSQL ownership races; follow with headless activation recovery. Do not mistake the new helper for a migrated meeting application.

The user then enabled Docker and authorized continued implementation. Docker is reachable; an isolated PostgreSQL 18.7 Compose lab and fencing checkpoint are underway ([plan](../plans/2026-11-25-postgresql-fencing.md)). The parallel dependency audit **reproduced three Raft v1.8.0 safety failures**; see the coordinator guide for the opt-in failing regressions and upstream links. Live Raft-to-SQL ownership activation remains disabled. Do not equate the ordinary test suite (which explicitly skips the known-failing audit) with dependency safety.

The PostgreSQL checkpoint is now implemented and independently reviewed: see [guide and evidence](../../postgresql-fencing.md). It covers versioned migrations/cluster identity, fenced command/activation/closure paths, stable outcomes, contiguous events, FIFO screen-share handoff plus transactional media intentions, participant snapshot reads and restricted inspection. Real Docker tests pause a lock-holding client, restart PostgreSQL with its volume, and verify failed-startup cleanup affects only its owned lab. Review regressions also cover participant turnover and immutable in-flight command/owner inputs. This is an in-process storage boundary with explicit test assignments, not a deployed meeting service or active recovery controller.

Next priority: replace or safely update the consensus dependency and make the three safety regressions plus live partition tests pass before connecting external ownership. Then implement activation intent/readiness metadata, headless reconciliation and failure suspicion. Docker no longer blocks independent feasibility work.

## Read first

1. [Current design](../specs/2026-11-21-distributed-meeting-redesign.md): authoritative design proposal, including ownership/recovery mechanics and acceptance evidence.
2. [Assignment requirements](../../assignment-reqs.txt): actual milestone wording.
3. This handoff: conversation decisions, scope, and next action.

The current design replaces its earlier SQLite/certificate architecture. The 2026-09-10 video MVP design is historical. Do not combine incompatible old designs or reconstruct decisions from a long conversation when the current spec answers them.

## Confirmed decisions

- The main purpose is learning distributed systems; understanding agentic coding is secondary. Deliver an understandable, working meeting demo.
- Incremental migration; preserve useful old demonstrations until replacements have evidence.
- Backend Chord coordination peers, existing Raft implementation, Lamport clocks, and safe dynamic voter membership. Support even/odd counts; at least four peers, with five in the default preset.
- Reachability does not change voting membership. Restarts reuse durable voter identity; removal/readdition is an agreed membership operation.
- One active meeting runtime per meeting. Additional runtimes are replacement capacity, not concurrent participant-facing replicas of that meeting.
- Shared PostgreSQL over the network, managed with Docker Compose and persistent storage. Initially one database instance; automatic database failover is deferred.
- Remove custom chat replication, per-message coordinator certificates, and per-meeting data Raft groups. Raft replicates important coordinator metadata for the assignment.
- Keep GUI and CLI attached to one participant session, including reconnect identity, pending command IDs, and event cursors.
- Use an existing SFU for real audio/video, concurrent cameras/microphones, and one coordinated screen share. One SFU initially; media restart recovery is separate.
- Add an admin dashboard backed by a supervisor for lifecycle, inspection, creation, cleanup, faults, and scenario presets.
- Include restricted read-only PostgreSQL inspection. State changes keep the per-meeting fence lock; ordinary reads use bounded, consistent snapshots without an exclusive fence lock. Participant reads still check ownership and permissions; inspection does not authorize control actions.
- Draft scenario batches while the system runs; Apply dispatches the prepared actions. Individual node suspension is a fault with elapsed time continuing. Exact simultaneity, determinism, and global pause/clock adjustment are out of scope.
- Default Demo lab: five coordinators, three meeting runtimes, PostgreSQL, SFU, one meeting, three joined participant agents.
- Reliable single-computer demo; prepared group devices may connect over a reachable local network. School Wi-Fi may isolate clients. No public-internet deployment or audience installation requirement.

## Engineering proposals to review

The spec labels these as implementer choices rather than historical user selections:

- HashiCorp Raft in persistent Go helpers beside TypeScript peers.
- PostgreSQL fence row with row-locked commands and a resumable Raft-to-SQL activation handshake.
- A current-leader recovery worker independent of the dashboard.
- Linux containers for managed backend nodes and fault proxies, extending the agreed PostgreSQL containerization.
- mediasoup, Toxiproxy, and a local host supervisor. Dashboard remote-machine provisioning is deferred.

Do not claim these protocols are implemented or proven. The effective database ownership cutover is the SQL fence commit, not the earlier Raft assignment. All domain writes take the same fence lock. Media effects follow committed desired state and have their own serialized cutover; they are not part of an SQL/Raft/media ACID transaction.

## Original review-stage next action (superseded by the update above)

Present the revised design for review, including the material engineering proposals above. After approval, start a fresh planning thread, inspect current code and repository instructions, and produce a milestone-based implementation plan. Do not start product implementation merely because this handoff exists.

The early technical checkpoints are Go/Raft persistence and stamped transport, PostgreSQL ownership/commit races, stalled SQL transactions, SFU two-browser media on Windows/Docker, and complete fault-proxy routing. Build headless recovery and the supervisor API before relying on the dashboard or media to demonstrate correctness.

The existing spec's code-boundary observations came from the earlier review and must be verified before planning source changes. No product-code inspection, package installation, build, or runtime test was performed for this documentation revision.

An independent builder review of the initial revised design returned "nothing important left" to ask before planning. The user subsequently accepted the snapshot-read and database-inspector refinement now included in the spec. The builder check is planning review, not proof of protocol correctness. Documentation checks cover relative links, section/fence structure, and stale-architecture wording; implementation must still produce the failure evidence in the spec.

## Constraints and collaboration

- Ask or explain one substantive thing at a time. Do not send batches of unresolved design questions.
- Use engineering judgment for routine details; explain meaningful tradeoffs with concrete examples.
- Do not weaken ownership or durability guarantees through an undocumented shortcut.
- Existing database/SFU availability limits are intentional scope, not completed high availability.
- The assignment permits several consistency strategies and requires at least one important replicated dataset. Library acceptance is assumed from its wording, not confirmed by an instructor.
- Automated demo clients do not bypass browser capture permissions.
- Preserve user changes. At the start of this documentation task, both the assignment file and current spec were untracked; do not stage or commit them without checking scope.
- Git required a per-command safe.directory override in the sandbox. Do not change global Git settings to work around it.

## Suggested fresh-thread prompt

> Read docs/assignment-reqs.txt, docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md, and docs/superpowers/handoffs/2026-11-25-distributed-meeting-redesign.md. The revised design is the source of truth; verify whether user approval has occurred. Inspect applicable repository instructions and current code, then prepare the implementation plan. Keep work incremental and ask at most one substantive question at a time. Do not restore the superseded SQLite/certificate or per-meeting Raft architecture.
