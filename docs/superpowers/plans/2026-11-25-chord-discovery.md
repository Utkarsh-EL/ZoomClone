# Chord discovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Supply an executable discovery service for the new backend with namespaced 128-bit routing and expiring placement/service hints.

**Architecture:** Discovery has its own authenticated, stamped loopback transport and no storage or coordinator mutation capability. Iterative Chord lookups share one deadline/attempt budget across fingers, successor fallbacks and bootstrap routes. An authoritative meeting resolver independently checks a Raft barrier read and the SQL owner fence.

**Tech stack:** Node TypeScript, built-in HTTP, existing ControlWire and HelperAccess.

**Spec:** `docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md`, sections 5 and 7; latest user clarification permits retiring legacy application layers.

## Constraints and review focus

- Preserve Raft metadata, SQL fences, runtime readiness, authentication, and direct Raft transport.
- Hexadecimal IDs on the wire; bigint arithmetic internally. Domain separate cluster, peers, services and meetings.
- Failed bootstrap must fail; only explicit initialization starts a singleton overlay.
- Bound attempts, hops, total time, frames, hint counts and TTLs. Churn may make discovery unavailable; never invent authority.
- Test actual finger shortcuts, consecutive successor failure, foreign cluster/malformed messages, expired hints and stale placement hints.

## Task 1: Routing and hints

Files: `coordination/discovery-id.ts`, `coordination/discovery.ts`, `tests/discovery.test.ts`.

- [x] Write and run failing regressions for namespace separation, canonical hex IDs, four-plus peer join, finger shortcuts, fallback, budget exhaustion and hint expiry.
- [x] Implement `DiscoveryNode` with predecessor/successor/finger maintenance, iterative `locate`, `publish`, `lookup`, bounded replicated hints, and explicit `join`/`initialize`.
- [x] Run routing regressions and type checks.

## Task 2: Transport and authoritative resolution

Files: `coordination/discovery-rpc.ts`, `coordination/discovery-client.ts`, `coordination/discovered-helpers.ts`, `coordination/meeting-resolver.ts`, `coordination/runtime-service.ts`, `scripts/discovery-peer.ts`, discovery tests, runtime process test and package config.

- [x] Write and run failing tests using real HTTP peers, authentication, wrong incarnation, multiple bootstraps, malformed/oversized input and unavailable dependencies.
- [x] Implement authenticated stamped RPC, a scheduled executable peer and an independent Raft/SQL resolver. Discovery never reports an authoritative ready owner.
- [x] Run targeted tests, full `npm test`, and `npm run typecheck`.

## Task 3: Review and handoff

- [x] Review the final diff for safety and failure bounds; address reproduced findings with regressions.
- [x] Update handoff and discovery documentation with actual evidence, limits, superseded migration policy and exact next action.

## Execution record

Ruling: Work in the current authorized `milestone-5` checkout; no worktree or global Git configuration changes. The user requested continuation with engineering judgment and no routine confirmation.

Ruling: This increment completes discovery before implementing ClientSession and participant transport. It must expose a running peer and a readiness resolver, so the next increment can integrate rather than duplicate discovery.

Ruling: Add a bootstrap-only client, periodic configured service announcements and optional discovered helper routing to runtime composition. The independent review identified that overlay primitives alone would leave the executable disconnected from backend consumers.

Completed: routing, transport, resolver, runtime consumer, independent review regressions and handoff. Final checks: `npm test` 95/95; `npm run typecheck` passed; `npm run test:runtimes` 15/15 with actual PostgreSQL and child Raft/runtime processes. See `evidence/discovery_run/result.json`. Deliver this coherent increment as a commit on `milestone-5`.
