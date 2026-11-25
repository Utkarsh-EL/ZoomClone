# Remote runtime implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline under the existing implementation authorization.

**Goal:** Connect authenticated runtime preparation, guarded registration and scheduled ownership renewal without changing the Raft/SQL activation protocol.

**Architecture:** Keep `Candidate` and `RuntimeAuthority` as the integration boundaries. Add provisioned loopback runtime routes using the existing version 2 stamped envelopes, a bounded HTTP adapter, and a runtime agent that registers once with a supplied revision and reconciles READY assignments. Read-only helper discovery may try configured routes; mutations are never automatically replayed after uncertainty.

**Tech stack:** Existing Node.js/TypeScript, Go helpers and PostgreSQL; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md`, sections 5–7 and 12.

## Global constraints

- Continue in the clean, authorized `milestone-5` checkout; preserve old demos and coordinator storage version 3.
- SQL fence commit remains the ownership cutover. No network call inside a SQL transaction.
- Runtime replies and requests bind cluster, runtime ID, incarnation and exact owner attempt. Authentication is provisioned control-plane trust, not participant authorization.
- Registration retries retain the exact command ID and expected revision. A replaced incarnation cannot continuously reclaim its registration.
- Stop/abort invalidates readiness immediately, including in-flight refreshes. Failures never grant readiness.
- Routes remain literal loopback initially, matching the helper boundary. Chord, participant traffic, media and complete proxy routing remain later work.

## Review focus

- Stale incarnation at a reused endpoint must not acknowledge preparation.
- Malformed, unauthorized, oversized or stalled requests must be bounded and fail before storage work.
- Lost registration replies and returning old processes must not overwrite newer registration.
- Stop during registration/preparation/renewal must not create a late ready gate.
- Helper leader replacement and partial runtime failures must permit later recovery without replaying uncertain writes automatically.

## Task 1: Runtime scheduling

Files: `coordination/runtime-agent.ts`, `coordination/helper-route.ts`, minimal helper type extraction, `tests/runtime-agent.test.ts`.

Interfaces: `RuntimeAgent.tick()/run()/stop()/prepare(owner)/authority(meetingId)`; `LeaderRoute.call` implements the helper call interface. Runtime registration consumes a provisioned expected revision, READY gates consume `RuntimeAuthority` unchanged.

- [x] Write failure-first tests for periodic renewal, uncertain registration retry identity, revocation, stop races and routed helper mutation uncertainty.
- [x] Implement bounded sequential scheduling and fail-closed lifecycle handling.
- [x] Run `node --test tests/runtime-agent.test.ts` and `npm run typecheck`; expected pass.

## Task 2: Authenticated remote adapters

Files: `coordination/runtime-rpc.ts`, `coordination/wire.ts`, `tests/runtime-rpc.test.ts`.

Interfaces: `RemoteRuntime` implements `Candidate`, `availableRuntimes` probes provisioned routes, `serveRuntime` binds a literal loopback listener and an allowlist of controller IDs.

- [x] Write failing real HTTP tests for authentication, exact incarnation/owner correlation, bounded work, invalid framing and remote errors.
- [x] Implement request validation, stamped replies, size/time/concurrency limits and deadline-bounded client calls.
- [x] Run both new unit suites and typecheck; expected pass.

## Task 3: Independent-process integration and evidence

Files: `scripts/meeting-runtime.ts`, `tests/runtime-process.test.ts`, storage runner/package scripts, checkpoint guide, handoff and evidence.

- [x] Add a real helper/PostgreSQL test that starts independent runtimes, reconciles using remote adapters, observes scheduled renewals, crashes the owner and verifies takeover/retained outcomes and old-owner refusal.
- [x] Cover leader replacement and registration of a restarted incarnation with the observed revision. Run the new test through the owned storage lab; expected pass.
- [x] Run project tests, typecheck, coordinator and storage/recovery checks; obtain one independent review and fix important findings with regressions.
- [x] Record commands/results and remaining boundaries; update the handoff and leave a reviewable diff.

## Execution record

Completed on `milestone-5`. `npm test`: 75 passed; `npm run test:runtimes`: 15 passed (7 storage, 4 storage-fault, 2 ownership-recovery and 2 runtime-process); `npm run test:coordinator` and `npm run typecheck`: passed. Checkpoint documentation links and diff whitespace were checked.

Independent read-only review found incomplete HTTP header deadlines and independent clocks across adapters belonging to one controller incarnation. Each has a failing-then-passing regression and was fixed in one review pass. A further failing-then-passing regression covers silently suppressed terminal registration failure. No new minor findings were deferred. See [guide](../../remote-runtimes.md) and [evidence](../../../evidence/runtime_run/result.json).

Rulings retained from execution:

- Continue in the existing authorized `milestone-5` checkout; keep this checkpoint there for review rather than integrate another branch.
- Preserve current readiness invalidation during refresh. Process evidence retries the same command ID; later participant clients must handle transient refusal.
- Retain the documented existing storage cancellation boundary. Socket deadlines bound remote callers and admission, but a blackholed database connection can retain underlying work and delay shutdown.
- Participant migration, Chord, media and full proxy routing remain later checkpoints; this work provides provisioned loopback routes and runtime scheduling only.
- Evidence covers independent process crashes on one host; host-failure resilience remains unestablished.
