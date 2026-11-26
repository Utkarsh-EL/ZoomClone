# Retire the original application

**Goal:** Leave one current backend architecture and make session continuation explicit.

**Scope:** Remove original root application/demo TypeScript and HTML files, their exclusive tests and npm commands, and the two obsolete operational guides. Preserve configuration, the new backend, historical evidence and design records, and all Raft/PostgreSQL/runtime guarantees.

**Dependency finding:** Only `coordination/wire.ts` imports root application code: it uses `LamportClock` from `protocol.ts`. Extract that class unchanged to `coordination/logical-clock.ts` and retain its existing behavior test as `tests/logical-clock.test.ts`. No other legacy API is needed by the new backend.

- [x] Move the logical-clock regression, observe its missing-module failure, extract the unchanged clock, and redirect the control wire import.
- [x] Remove retired application files and exclusive tests, scripts, operational guides and stale README instructions. Tighten TypeScript source roots.
- [x] Update the spec/handoff to describe the actual tree, persist the request for final-message continuation prompts, and record verification.
- [x] Run current backend tests, type checks, import/reference checks and the real runtime integration. Deliver this coherent cleanup as a commit.

Verification: 41 current backend tests, type checks and all 15 real storage/recovery/runtime checks passed. The 54-case reduction removes only legacy-specific cases. See `evidence/retirement_run/result.json`.

**Next implementation:** Durable ClientSession credentials, immutable pending commands and replay cursors, followed by production participant join/chat/reconnect/replay.
