# Repeatable single-computer demo implementation plan

**Goal:** A tested local launch, status, shutdown and rehearsal covering media, meeting chat, private-group pub/sub and runtime recovery.

**Authority:** User's persistent-goal request on 2026-11-26 supersedes earlier per-increment stops and medium-effort recommendations. Implement inline; independent review for substantial authorization, journal, recovery and fencing work. Preserve the current `milestone-5` checkout and all existing safety guarantees. No push, merge or deployment.

**Design:** Build on the existing distributed architecture and agreed group-chat design. One supported coordinated participant protocol, one upgraded durable journal. Retain local demo state across stop/start. Launch controls own only their recorded processes/resources, report readiness and partial failures, and never reset identities to repair a failure. Optional public groups, internet deployment and a broader dashboard are outside this demo goal.

## Completion checklist

- [x] Fenced SQL private groups/history, one supported protocol and transactional shared-journal upgrade, preserving original commands, credentials, outcomes and revision-zero meeting replay.
- [x] Browser/CLI create, invite, accept, send, earlier history and leave; multiple member subscribers and nonmember payload exclusion.
- [ ] Repeatable single-computer start, readiness/status and bounded shutdown with retained state and owned-resource cleanup.
- [ ] Media, meeting chat and private-group controls work together; participant restart and runtime takeover recover without invented commands or authority.
- [ ] Relevant default/typecheck, real PostgreSQL/recovery/process, browser/media and coordinator/consensus regression suites pass; substantial changes independently reviewed and findings resolved.
- [ ] Tested launch procedure, full rehearsal evidence, honest limitations, verified commits and progress records.

## Milestones and order

1. Execute remaining increment 2 in `2026-11-26-group-chats.md` at high effort: storage, protocol, journal and fair recovery together. Add tests before implementation; run focused SQL/journal/gateway/process checks and default/typecheck. Independent review before checkpoint commit.
2. Execute increment 3: usable shared-session browser/CLI group flows and nonmember acceptance. Independent review for substantial changes. Reassess effort based on observed risks.
3. Implement local demo orchestration using the existing provisioned coordinator/discovery/runtime/media/participant entry points. Test startup/restart/status/shutdown, partial failure and resource ownership. Prefer a small command interface over an optional dashboard; provide meeting entry through launched participant pages.
4. Run required broad regression suites and rehearse from the documented launch procedure. Cover camera/microphone/display reception, queue handoff, meeting and group chat, leave/unsubscribe, participant restart and runtime failure/takeover. Record exact commands, results, limits and commits. Physical devices/audible output must be reported as unverified unless actually observed.

## Progress

- Inspection: base `ac0e70f`, clean `milestone-5`; pure group engine and existing supervised media already complete. Existing plans/spec/handoff reviewed; superseded subscription plan will not execute. Docker 29.8.2 and Go 1.26.1 available with required sandbox elevation; Node 26.1.0 present.
- Milestone 1 complete: SQL/protocol/journal integration; default 148/148 and typecheck; real storage16/16; recovery/runtime/process19/19 at its run; independent review's two minor gaps addressed and verified. See current handoff for exact evidence and limitations.
- Milestone 2 complete: group UI5/5, default153/153, typecheck, four-session native group1/1, existing browser1/1, native media1/1. Independent Important destination-switch issue fixed RED→GREEN; no deferred findings. See handoff for diagnosed harness/readiness/Windows-port failures and evidence.
- Current: milestone 3, persistent local demo orchestration. Initial real lifecycle acceptance passed; harden authorization/status/cleanup then independent review. Milestone4 broad regressions and actual launch rehearsal remain.
