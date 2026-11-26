# Durable ClientSession and participant recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline under the existing implementation authorization. Track the steps below; use test-driven development and verification before completion.

**Goal:** Persist participant credentials, immutable pending commands and replay progress, and exercise production join/chat across runtime failure and restart.

**Architecture:** A local SQLite journal commits credentials and command contents before transmission, and commits received events with its meeting/revision cursor. ClientSession serializes callers and retries the exact pending commands. A bounded versioned WebSocket participant gateway delegates every operation to the existing readiness and PostgreSQL fences; helper metadata supplies replacement routes without giving clients database credentials.

**Tech Stack:** Existing TypeScript/Node (>=24.16), built-in SQLite, PostgreSQL and Go/Raft; pinned `ws` for WebSocket framing.

**Spec:** `docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md`, especially sections 7, 8, 10 and 15; current handoff and retirement commit `ed460ba`.

## Global constraints

- Continue in the authorized clean `milestone-5` checkout. No global Git configuration changes.
- Preserve Raft storage version 3, effective SQL ownership cutover, PostgreSQL fencing and RuntimeAuthority readiness.
- Persist UUID/resume secret, initial join ID and every command's immutable contents before sending. Uncertainty survives process restart.
- Cursors bind cluster/meeting and subscription revision. This increment supports unfiltered revision 0 only; topic changes require their own committed-order protocol.
- Replay pages and scanned watermarks are stored atomically in a local inbox. UI/CLI can read that shared inbox without depending on network publication.
- Literal loopback deployment and the trusted local backend remain the current transport scope. Browser attachment security, GUI/media, topics and deployment remain later work.

## Review focus

- Lost join/chat replies and restart must preserve credentials and retry exactly once at SQL.
- Mutation of caller inputs and simultaneous local submissions must not alter pending contents or reorder join/leave.
- A wrong meeting/revision, malformed page or regressing cursor must not advance replay.
- Snapshot/replay boundaries and bounded pages must retain every committed event, including when no live connection existed.
- Stale runtime incarnation, expired readiness, absent quorum and the SQL fence must reject participant traffic.

## Task 1: Durable journal and shared session

Files: `client/session-journal.ts`, `client/client-session.ts`, `client/types.ts`, `tests/client-session.test.ts`, package/TypeScript inclusion.

Interfaces: `SessionJournal.open(path, target)`, `enqueue(operation)`, `pending()`, `complete(id, outcome)`, `recordReplay(after, page)`, `view()`, `close()`; `ClientSession.step()` and abortable `run()` consume a `ParticipantTransport` resolver with `execute(command)` and `read(credential, after, limit)`.

- [x] Write and run failing tests for reopen, lost replies, mutation, concurrent submissions, scoped cursors, paginated local inbox and abort/retry state.
- [x] Implement transactional FULL-synchronous SQLite persistence, bounded pending work, validation and serial session operations.
- [x] Run focused tests, `npm test` and `npm run typecheck`; commit the verified journal/session increment.

## Task 2: Production participant transport

Files: `client/participant-transport.ts`, `coordination/participant-gateway.ts`, runtime composition/configuration, `tests/participant-gateway.test.ts`.

Interfaces: `serveParticipants(agent, store, options)` exposes `/v1/participant` WebSockets; `ParticipantConnection` implements the task 1 transport; a helper-backed resolver pins READY owner/runtime/incarnation from provisioned participant routes.

- [ ] Write and run failing real-socket tests for authentication, framing, strict owner binding, domain errors, bounds/deadlines and reconnect routing.
- [ ] Implement stamped request/reply messages using the runtime's shared wire; bound payloads, clients, in-flight work and output buffers; check existing authority on every request.
- [ ] Compose the gateway into `startMeetingRuntime` and close it with the runtime. Run default tests/typecheck and commit.

## Task 3: Real process recovery and handover

Files: participant agent executable, `tests/participant-process.test.ts`, storage runner, checkpoint documentation/evidence and current handoff.

- [ ] Add a production-path process test using real helpers, restricted PostgreSQL runtime pools, runtime processes and durable session process restart. Cover join/chat, uncertain replies, takeover/replay, old incarnation and quorum refusal.
- [ ] Run `npm run test:runtimes`, `npm test`, `npm run typecheck` and diff checks; review the complete change and reproduce/fix important findings.
- [ ] Document configuration, guarantees, observed evidence and material limits; update handoff and commit verified increments.

## Execution ledger

Baseline: `ed460ba`; branch `milestone-5`; clean checkout; `npm test` 41/41 and typecheck passed.

Ruling: retain the existing authorized branch and work in place, as the preceding checkpoint plans and handoff explicitly authorize. No additional worktree is needed.

Ruling: use a transactional local inbox, so advancing a network cursor never depends on a browser/CLI remaining attached. SQLite holds participant secrets locally; Windows inherits the session directory's ACLs. No encryption-at-rest claim.

Pre-flight: Task 2 consumes Task 1 transport signatures; Task 3 consumes Task 2 runtime gateway configuration. All serve the same SQL-authenticated participant identity and revision-0 replay contract.

Task 1 complete: failure-first session tests 5/5, full suite 46/46, typecheck and diff whitespace passed. Local journal uses transactional DELETE journals and FULL synchronization. WebSocket dependencies installed with registry access after sandbox denial; no vulnerabilities reported.
