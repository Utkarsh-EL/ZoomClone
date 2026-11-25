# Distributed meeting redesign handoff

Date: 2026-11-25
Status: coordinator, consensus repair, PostgreSQL storage foundations and headless ownership activation implemented on `milestone-5` from `milestone-4`. Remote runtime integration and participant migration are next. The full redesign remains in progress.

## Implementation update

The user authorized implementation judgment, branch selection, commits and tools, then enabled Docker and asked to continue. That authorization persists. No further user decision is needed to continue routine implementation. The [first plan](../plans/2026-11-25-coordinator-foundation.md) and [coordinator guide](../../coordinator-foundation.md) document the durable helper foundation. The original assignment/spec content is preserved as design input.

Implemented: deterministic reservation/runtime/candidate metadata, durable Raft helpers, stamped authenticated loopback transport, guarded nonvoter admission/promotion/removal, TypeScript bridge, and checked independent-process crash/restart/snapshot/quorum scenarios. Existing participant/peer/media demos remain separate. Candidate assignment is not effective PostgreSQL ownership.

Independent review findings around RPC validation, lost-store identity and durable clocks were fixed with failing-then-passing regressions. Raft `GetConfiguration().Index()` returns zero in this version: use the committed `ConfigurationStore` callback and snapshot its index; never disable membership guards with zero.

The [consensus checkpoint](../../consensus-safety.md) now repairs the three reproduced upstream log/snapshot failures using an auditable local module replacement. Original safety tests are always enabled. The patch preserves an interrupted transfer's possibly committed logs, reconciles durable snapshot/log state before service and on startup, retains matching pending configuration and fails closed on uncertain cleanup or failed leader writes. Source checksums, original proposed PRs and the actual production delta are retained in `third_party/hashicorp-raft`. A live five-voter 2/3 TCP partition tests minority refusal, majority progress, snapshot catch-up, healing, restart and removal to four voters. Real child-process crashes cover both sides of snapshot publication. Storage/envelope version 2 rejects old histories/helpers; preserve old directories instead of editing their version markers. This is bounded failure evidence, not a broad consensus-safety proof.

Docker is working. The independently reviewed [PostgreSQL checkpoint](../../postgresql-fencing.md) covers versioned migrations/cluster identity, fenced command/activation/closure paths, stable outcomes, contiguous events, FIFO screen-share handoff plus transactional media intentions, participant snapshot reads and restricted inspection. Eleven real Docker tests pause a lock-holding client, restart PostgreSQL with its volume, and verify owned-lab cleanup. Review regressions cover participant turnover and immutable in-flight command/owner inputs. Those separate storage tests use explicit assignments; the headless controller integration is covered by the later checkpoint below.

The [ownership activation checkpoint](../../ownership-activation.md) now implements conditional INTENT/READY metadata, revision-guarded renewal, monotonic runtime readiness, a headless leader reconciliation loop and failure suspicion. Real helper/PostgreSQL tests SIGKILL a recovery child after each durable transition and lose replies after Raft/SQL commits; they verify retained outcomes/state, late owner rejection, candidate failure replacement, fresh leader grace and quorum refusal. Independent review found and fixed candidate failures resetting suspicion and renewal history exceeding the authority reply limit. A stop-during-refresh race was also reproduced and fixed. Coordinator storage version is now **3**; preserve old directories and start fresh helpers, with no rolling mixed-version upgrade claim.

Next priority: connect authenticated remote runtime adapters and registration/renewal scheduling, then 128-bit Chord discovery and durable ClientSession identity/replay. Continue SFU feasibility, complete whole-system proxy routing, supervisor and dashboard. Current Candidate adapters are a trusted in-process boundary, and the original participant demos are not migrated. Retained coordinator outcomes still have the existing 32 MiB snapshot capacity limit; long-term garbage collection is deferred. See checkpoint documentation and `evidence/recovery_run/result.json` for actual evidence and limits.

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

## Suggested continuation prompt

> Read docs/assignment-reqs.txt, docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md, and docs/superpowers/handoffs/2026-11-25-distributed-meeting-redesign.md. Implementation is already authorized on milestone-5. Inspect current code and ownership activation evidence, then connect authenticated remote runtime adapters and renewal scheduling before participant migration and discovery. Keep work incremental with meaningful failing-then-passing tests; use engineering judgment for routine choices. Do not restore the superseded SQLite/certificate or per-meeting Raft architecture.
