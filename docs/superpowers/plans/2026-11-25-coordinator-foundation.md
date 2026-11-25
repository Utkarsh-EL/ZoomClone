# Durable coordinator foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first redesign checkpoint: real, durable coordinator metadata replication with a TypeScript boundary and repeatable crash/restart evidence.

**Architecture:** Preserve the milestone-4 demonstrations. Add a separately runnable Go helper using HashiCorp Raft, Bolt log/stable storage, and file snapshots. A small authenticated, stamped HTTP protocol connects helpers and TypeScript. Reservations and proposed assignments are replicated; none of these records claim effective PostgreSQL ownership.

**Tech Stack:** Existing Node/TypeScript; Go; pinned HashiCorp Raft and raft-boltdb/v2. No Docker prerequisite for this batch.

**Spec:** [Distributed meeting redesign](../specs/2026-11-21-distributed-meeting-redesign.md), especially sections 5–8 and 17.

## Global constraints

- Five coordinator voters by default; four voters require three votes.
- Reachability never changes membership. Bootstrap is explicit; restart reuses durable identity and state.
- Raft assignments are proposals for the later SQL activation protocol, never proof of ready ownership.
- Application messages carry version, cluster/node/incarnation, request ID, and Lamport timestamp.
- Retain old demos until replacement evidence exists. No chat bodies or participant secrets in coordinator storage.
- First batch is loopback-only. LAN/TLS packaging, Chord integration, SQL, SFU, supervisor, and dashboard follow separately.

## Review focus

- A missing or mismatched durable identity must stop startup rather than bootstrap another cluster (task 2).
- A retry following an unknown commit must preserve its original outcome, including after snapshots (tasks 1, 3).
- A minority must fail authoritative reads/writes while retaining the configured denominator (tasks 2, 3).
- Stale configuration indices and delayed assignment attempts must not overwrite newer state (tasks 1, 2).
- Malformed, unauthenticated, cross-cluster, oversized, and mismatched replies must fail at the boundary (tasks 2, 3).

## Task 1: Deterministic coordinator metadata

**Files:** `services/coordinator/{go.mod,go.sum,metadata.go,metadata_test.go}`.

**Interfaces:** `Command`, `Result`, `State`, `newMetadata(clusterID)` implementing `raft.FSM`; commands reserve meeting codes, register runtime incarnations with expected revision, and assign a meeting with expected generation. Results retain Raft index and stable operation ID. `view()` returns a detached snapshot.

- [ ] Write tests for conflicting code reservations, stable retries/content conflicts, runtime revision checks, monotonic assignment generations, and snapshot/replay.
- [ ] Run `go test ./...` in `services/coordinator`; confirm missing implementation fails.
- [ ] Implement deterministic validation, state changes, outcomes, immutable views, bounded versioned snapshots.
- [ ] Run tests; commit the independently tested state machine.

## Task 2: Durable helper and stamped transport

**Files:** `services/coordinator/{wire.go,transport.go,node.go,main.go,node_test.go,transport_test.go}`.

**Consumes:** Task 1 FSM. **Produces:** loopback helper executable, authenticated stamped `/v1/control` and `/v1/raft` endpoints. Control operations: status, read, apply, configuration, add-nonvoter, promote, remove, snapshot. Configuration changes use the actual Raft configuration index. New-node initialization is explicit and exclusive; normal start cannot create missing identity/storage.

- [ ] Write real multi-node tests for five voters losing/recovering a leader, four voters losing quorum, same-directory restart, snapshots/catch-up, and guarded nonvoter admission/promotion/removal.
- [ ] Run to observe failure, then add durable startup and bounded transport. Use library consensus unchanged; explicitly disable optional append pipelining so all RPCs, heartbeats, votes, and snapshot streams use one stamped route.
- [ ] Add boundary tests for authentication, cluster mismatch, absent stamps, snapshot limits, and identity mismatch/loss; observe RED before each boundary implementation.
- [ ] Run Go tests and vet; commit.

## Task 3: TypeScript bridge and process crash evidence

**Files:** `coordination/{wire.ts,helper-client.ts}`, `tests/coordinator.test.ts`, `scripts/coordinator-demo.ts`, package scripts, README, `docs/coordinator-foundation.md`.

**Consumes:** Task 2 wire API. **Produces:** `HelperClient.call(operation, payload)` with request correlation and Lamport receive validation; a demo launching five independent helpers in an owned temporary lab, killing the leader, proving continued metadata, restarting/catching up, and reporting evidence.

- [ ] Write boundary tests for required stamps, reply correlation, remote clock progression, errors and bounds; run RED, implement, run GREEN.
- [ ] Write a process integration test that kills a real helper, resolves an original operation ID on the new leader, restarts the original node from its directory, and verifies snapshot catch-up.
- [ ] Run Go suite/vet, `npm test`, `npm run typecheck`, and the process demo. Record actual evidence and prerequisites, update handoff status without calling the full redesign complete, commit.

## Next batches (separate plans after evidence)

1. PostgreSQL migrations and fenced command/ownership races, including paused transactions; then headless recovery reconciliation.
2. Chord 128-bit discovery and coordinator/meeting-runtime integration, shared durable ClientSession and replay.
3. Local supervisor lifecycle and persisted scenario API, then dashboard/inspection views.
4. mediasoup two-browser feasibility and integration, screen-share media fencing, complete fault routing and acceptance evidence.

The current machine has Go/Node/PostgreSQL tools, but Docker's daemon is unavailable. This is a reason to sequence independent evidence first, not to replace the proposed database with an in-memory substitute. The user's current instruction authorizes implementation and routine engineering choices; the existing spec remains the architecture proposal, and this batch tests its first risk.
