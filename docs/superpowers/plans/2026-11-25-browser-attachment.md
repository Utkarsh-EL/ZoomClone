# Secured browser attachment implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task.

**Goal:** Attach a reloadable loopback browser to the participant agent's existing ClientSession, sharing identity, pending work and inbox with its CLI.

**Architecture:** A separate local HTTP/WebSocket adapter delegates submit/view directly to ClientSession. A random process-lifetime capability authenticates the WebSocket after exact loopback Host/Origin validation. Socket-bound attachment revisions and a compare-and-set capture revision fence replacement and stale disconnects. Runtime authority remains entirely in the existing participant transport and SQL path.

**Tech stack:** Node HTTP, ws, native browser modules, existing SQLite journal and ControlWire.

**Spec:** ../specs/2026-11-21-distributed-meeting-redesign.md, sections 6 and 10; ../handoffs/2026-11-25-distributed-meeting-redesign.md at 5482a89.

## Global constraints

- One existing ClientSession; no browser-created identity, resume secret or second journal.
- Preserve Raft metadata, SQL fences, readiness and retry jitter; runtime routes remain provisioned.
- Subscription revision zero is unfiltered. Capture leases are local attachment state, not SQL screen-share grants.
- Bind literal loopback only. Token never in HTTP query/path or ordinary session views.
- Bound frames, output, attachments and authentication/idle deadlines. Close adapters before closing the journal.

## Review focus

- Cross-site WebSockets, absent/null Origin, rebinding Host and invalid tokens must fail before session access.
- Reload while a command is pending must preserve its ID and inbox; stale attachment requests cannot submit.
- Concurrent capture claims and delayed disconnects must leave exactly one current owner.
- Unauthenticated/slow/oversized clients must not retain unbounded resources.
- Agent shutdown or failed browser startup must release both listeners and journal resources.

### Task 1: Secured attachment service

Files: create client/browser-attachment.ts and tests/browser-attachment.test.ts; update package.json.

Interfaces: serveBrowserAttachment(session, {address, wire?, timeoutMs?, maxClients?}) returns {origin, url, close}; requests use ControlWire, version-1 bodies and socket-bound {id, revision}. Capture claim/release requires the observed capture revision.

- [x] Write and run failing security, shared-session, reload, revision and capture-race tests.
- [x] Implement bounded HTTP/WebSocket service with static browser assets and shared session delegation.
- [x] Run targeted tests and typecheck; commit verified service increment (`e64be83`).

### Task 2: Agent composition and native browser adapter

Files: client/browser-attachment.js, client/browser-bootstrap.js, client/participant-agent.ts, scripts/participant-agent.ts; tests/browser-native.test.ts, tests/browser-attachment.test.ts and tests/participant-process.test.ts.

Interfaces: optional browser configuration on ParticipantAgentConfig; agent.openBrowser() composes exactly its session and wire, idempotent close owns lifecycle. Executable reports the private fragment URL on startup. BrowserAttachment exposes view/submit/capture and never retries uncertain submissions.

- [x] Write and run failing CLI/browser process tests.
- [x] Implement native browser adapter, reload credential handling and agent lifecycle composition.
- [x] Verify actual Chromium browser reload with the same CLI process, pending IDs, inbox and capture replacement; commit.

### Task 3: Regression evidence and handoff

- [x] Run npm test, npm run typecheck and npm run test:runtimes; inspect outputs.
- [x] Obtain a fresh whole-change review, fix important findings with regressions and rerun affected checks. Review returned two confirmed findings before its final report was interrupted; author completed the remaining pass.
- [x] Update docs/client-sessions.md, current spec, handoff and evidence; commit.

## Execution ledger

- Baseline: clean milestone-5 at 5482a89; npm test 56/56. Work in the existing authorized checkout.
- Decision: capture replacement uses an explicit compare-and-set claim; attaching/reloading alone never starts capture. Old owner receives a revocation notification; future media must also validate the current lease.
- Decision: serve a diagnostic attachment page for native-browser verification. Full meeting UI/media remains the next increment.
- Task 1 complete: e64be83; targeted attachment tests 4/4 and typecheck passed after missing-module RED.
- Task 2 complete: native Chromium 1/1 after missing-startup-URL RED; npm test 61/61 and typecheck passed. Docker suite 16/16 in zoom-storage-3d5bbaba includes attachment submissions, reload, pending outcome and recovered SQL inbox comparison. Native browser subprocesses require sandbox elevation on this host.
- Ruling: use an 8 MiB bounded local reply and 16-event pages to include all 128 pending command contents under worst-case JSON escaping; the runtime gateway's 1 MiB bound is unchanged.
- Final review: independent reviewer reproduced browser clock exhaustion and rejected-upgrade shutdown retention. Both were verified RED→GREEN and fixed. The reviewer did not deliver a final full assessment; author completed a final lifecycle/protocol pass. No other findings are claimed from that review.
- Final fixes: reject browser Lamport jumps more than 1024 ahead before shared-clock observation; contain reply/event failure. Destroy rejected upgrades after response flush, track every raw TCP socket through shutdown and enforce an absolute pre-upgrade deadline. Regression tests cover all three paths and an 8 MiB reply with 128 command records/16 escaped events. One raw-socket test initially treated an expected ECONNRESET as failure; it now waits for close directly.
- Final verification: npm test 65/65; attachment 9/9; typecheck passed; native Chrome 1/1; repeated real runtime suite 16/16. Production Raft/SQL/readiness/retry paths were not modified.
- Task 3 complete: fixes committed in 5091488; final lab zoom-storage-193ce937; checked transcripts and limits in evidence/browser_attachment_run/result.json. Documentation relative links, JSON parse and diff whitespace passed. Handoff names the exact UI integration continuation; branch remains milestone-5 as requested.
