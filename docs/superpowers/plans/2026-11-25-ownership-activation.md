# Ownership activation implementation plan

> **For agentic workers:** Use superpowers:executing-plans; continue inline under the handoff's existing implementation authorization.

**Goal:** Connect durable coordinator assignments to PostgreSQL ownership with resumable activation and headless failure suspicion.

**Architecture:** Extend assignment metadata with intent/readiness and renewal revision. A leader-local recovery controller reconciles SQL stages through the trusted storage boundary. A runtime authority gate renews through committed commands and expires using monotonic local time. The controller and runtime libraries remain independent of the dashboard and original participant demos.

**Tech stack:** Existing Go/Raft helpers, TypeScript and PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-11-21-distributed-meeting-redesign.md`, section 7.

## Global constraints

- SQL fence commit defines storage cutover; no Raft calls inside SQL transactions.
- All transitions bind exact generation, runtime incarnation and attempt. Readiness also needs SQL ACTIVE.
- Suspicion is local and conditional on renewal revision; leadership changes reset grace. Membership never changes on timeout.
- Missing established meeting state fails closed. Preserve existing demos.
- Work in the authorized milestone-5 checkout. Do not change global Git settings.

## Review focus

Late superseded work, uncertain replies, renewal versus expiration races, leadership changes and missing durable storage must fail safely. Tests below cover these boundaries; external media and participant reconnect remain later checkpoints.

## Task 1: Durable activation metadata

Files: `services/coordinator/metadata{,_test}.go`, `coordination/helper-client.ts`.

- [x] Add failing tests for intent-before-ready, exact assignment matching, renew revision CAS, expiration versus renewal and snapshot restoration.
- [x] Implement `activation-intent`, `confirm-ready`, `renew`, and `assign` renewal revision guard. New assignments start CANDIDATE with revision zero.
- [x] Run Go metadata tests (expected pass), then coordinator checks.

## Task 2: Recovery and runtime authority

Files: `coordination/recovery-controller.ts`, `coordination/runtime-authority.ts`, `storage/meeting-store.ts`, `tests/recovery.test.ts`.

- [x] Add failure-first integration tests using real helpers and PostgreSQL, interrupting after each durable transition and resuming with a fresh controller.
- [x] Implement leader reconciliation, conditional suspicion with fresh leader grace, consistent candidate preparation and runtime readiness/renewal gating.
- [x] Test superseded activation, missing established state, expired/uncertain renewal, stable command retry after takeover and quorum refusal.
- [x] Typecheck and run relevant integration tests (expected pass).

## Task 3: Evidence and review

Files: recovery runner/package scripts, `docs/ownership-activation.md`, handoff/spec/README.

- [x] Run project tests, coordinator checks and real PostgreSQL integration; record actual limits and results.
- [x] Obtain independent review of this checkpoint, address important findings with regressions and update handoff.

## Execution record

Implemented and reviewed as one integrated checkpoint. `npm test`: 62 passed. `npm run test:recovery`: 13 passed across storage/fault/recovery files. Coordinator checks and typecheck passed. The independent review's two important findings and the stop-during-renewal race each have a failing-then-passing regression. See [checkpoint evidence](../../../evidence/recovery_run/result.json) and [guide](../../ownership-activation.md). Commits are grouped by the durable helper protocol and the consuming integration rather than each test cycle.
