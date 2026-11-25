# PostgreSQL fencing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the redesign's PostgreSQL ownership cutover and durable command invariants against real storage and process faults.

**Architecture:** Add an isolated Compose PostgreSQL service with a persistent named volume, pinned image and health check. A meeting store serializes all domain writes and ownership transitions on the same fence row. A deterministic engine manages membership, chat and screen-share FIFO handoff; state, contiguous events, stable outcomes and media intentions commit together. Normal reads use bounded repeatable-read snapshots without exclusive fence locks.

**Tech stack:** Existing TypeScript/Node; pinned `pg`; PostgreSQL 18.7 with server-side transaction, statement, idle and lock timeouts.

**Spec:** [Current redesign](../specs/2026-11-21-distributed-meeting-redesign.md), sections 7–10, 13 and 16.

## Global constraints

- SQL fence commit is the effective storage cutover. No network calls while holding the fence lock.
- Fence identity includes cluster, meeting, generation, runtime ID, incarnation and attempt ID. CLOSED is terminal.
- Lock before reading domain state/outcomes for any mutation; readiness and participant credentials must also match.
- Commit state, event sequence, stable command outcome and media intention atomically. A lost reply never justifies a new command ID.
- Ordinary reads take no exclusive fence lock. State and event watermark come from one bounded view.
- Normal restart cannot bootstrap missing durable state. Docker resource names/labels belong only to this lab; shutdown retains its volume.
- Current Raft v1.8.0 has reproduced upstream safety failures. This batch tests SQL independently. No live consensus-to-SQL activation, production recovery controller, or ready-owner advertising until dependency safety is resolved.

## Review focus

- A late old command must be wholly before fence cutover or rejected after it (task 2).
- A client paused while holding a transaction must lose its server-side lock within a bounded interval (task 3).
- Identical retries after takeover/restart return the original outcome; altered content fails (task 2).
- Stale activation, same-generation candidate mismatch and CLOSED transitions must fail (task 2).
- Read-only inspection must not expose resume verifiers, write data, or block takeover (tasks 1–3).

## Task 1: Persistent database and migrations

**Files:** `compose.yaml`, `.env.example`, `storage/migrations/001-meetings.sql`, `storage/database.ts`, `scripts/storage-lab.ts`, `tests/storage.test.ts`.

**Interfaces:** `Database.open({connectionString,clusterId,initialize})`; owned runtime/transaction pool with finite server timeouts. `migrate` verifies migration digests and durable cluster identity. Compose loopback port is configurable, credentials are environment inputs, volume is persistent. Restricted inspection views exclude verifiers and credentials.

- [ ] Write a real PostgreSQL test: repeated initialization preserves identity/schema; mismatched cluster and normal opening of a fresh database fail.
- [ ] Run RED, implement versioned migration/bootstrap and isolated Compose runner, run GREEN.
- [ ] Verify actual PostgreSQL version, fsync/synchronous_commit and timeout settings; commit.

## Task 2: Fenced store and deterministic screen-share transaction

**Files:** `storage/{engine.ts,meeting-store.ts,types.ts}`, `tests/meeting-engine.test.ts`, expand `tests/storage.test.ts`.

**Interfaces:** `MeetingStore.create`, `install`, `activate`, `close`, `execute`, `read`, `observe`. Controller methods accept explicit desired assignments at a trusted in-process boundary, never untrusted network payloads. `execute(authority, command)` includes immutable operation ID, participant ID/resume secret and operation. `authority.ready()` is a synchronous local observation; it is not a consensus certificate.

- [ ] Test engine FIFO request/cancel/release/leave, grant versions, invalid inputs, membership and duplicate requests. Watch RED, implement, GREEN.
- [ ] Test competing fences/old command races, late activation, same-generation mismatch, independent meetings, stable outcomes after takeover, command-ID content conflicts, rollback/no sequence gaps and atomic handoff/outbox.
- [ ] Test matching owner and authentication in consistent reads; read during held write lock; bounded replay and watermark. Observe RED, implement store using one connected client per transaction, GREEN.
- [ ] Commit tested store.

## Task 3: Failure evidence and restricted inspection

**Files:** `scripts/storage-check.ts`, `tests/storage-faults.test.ts`, `docs/postgresql-fencing.md`, recorded `evidence/storage_run/result.json`; update package scripts/README/handoff.

**Interfaces:** one explicit new versus resume lab runner, checked Docker operations scoped to its Compose project/container; separate small read-only inspection pool. Test runner records actual transitions and retains volume on shutdown.

- [ ] Test a real paused database client transaction, observe timeout/lock release, and verify no partial changes. No timeout bypass of fencing.
- [ ] Test PostgreSQL container restart with the same named volume; original state/outcomes and cluster identity survive, broken connections recover.
- [ ] Test inspector nonsuperuser privileges, excluded verifier fields, read-only bounded queries and separate pool behavior.
- [ ] Run Node suite, TypeScript checks, storage integration/fault evidence, coordinator suite and the explicitly opt-in known-failing Raft safety audit. Document the gate; independently review this batch and fix material findings with RED/GREEN regressions.
- [ ] Commit and leave `milestone-5` ready for the next dependency/recovery batch.

## Execution notes

User authorization persists: continue implementation on `milestone-5`; no new permission gate for routine choices. Docker is reachable with sandbox escalation. Keep PostgreSQL native protocol; application timestamps are persisted on command/events, without pretending to instrument the database internals.
