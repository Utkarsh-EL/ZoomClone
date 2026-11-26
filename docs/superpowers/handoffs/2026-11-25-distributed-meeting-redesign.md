# Distributed meeting redesign handoff

Date: 2026-11-25
Status: coordinator, consensus repair, PostgreSQL storage foundations, headless ownership activation, runtime renewal, discovery, durable production participant sessions and secured shared browser/CLI attachment integrated on `milestone-5`. Full participant UI and media are next. The full redesign remains in progress.

## Browser attachment update

Continued from `5482a89`. `startParticipant().openBrowser()` now serves a secured loopback HTTP/WebSocket attachment around that agent's existing ClientSession and shared ControlWire clock. Optional `browser: {address: "127.0.0.1:0"}` enables it in the executable; `participant.started.browser.url` contains the private capability URL. The page is a diagnostic view, not the finished meeting UI. See the [session/attachment guide](../../client-sessions.md) and [implementation plan](../plans/2026-11-25-browser-attachment.md).

Implemented: random process-lifetime 256-bit token, exact Host/Origin checks, tab-scoped fragment-token reload handling, versioned stamped messages, socket-bound attachment ID/revision, bounded requests/output and deadlines. Explicit compare-and-set capture claims allow one local owner; revocation events, owner-only release and exact attachment checks prevent stale releases/disconnects from revoking a successor. Revisions are listener-local and do not change subscription revision zero. There is no actual browser capture/SFU implementation yet; future track/media control must honor both this lease and the existing SQL grant/runtime fences.

Native headless Chrome reloads against a production participant executable with a seeded durable inbox while backend authority is unavailable. Browser/CLI share identity, join, both pending command IDs and inbox; reload does not resubmit. A second tab replaces capture ownership, and CLI shutdown closes both browser connections without domain leave. The real helper/PostgreSQL/runtime scenario separately submits through the attachment, reconnects, checks the original uncertain outcome, crashes two runtimes and compares recovered browser events/commands with the CLI. Runtime routes/incarnations remain provisioned.

Final verification: `npm test` **65/65**, attachment tests **9/9**, `npm run typecheck` passed, `npm run test:browser` **1/1**, `npm run test:runtimes` **16/16** in owned lab `zoom-storage-193ce937`. The final production participant scenario took 8.23 seconds. See [checked evidence and transcripts](../../../evidence/browser_attachment_run/result.json). Native browser and Docker checks required sandbox elevation. No separate consensus-only rerun is claimed.

Independent review reproduced two important findings: extreme browser Lamport time could exhaust the agent clock, and rejected raw upgrades could delay shutdown. Failing-then-passing regressions now reject implausible browser clock advancement before shared-clock observation, contain reply/event failures and destroy/track raw sockets through shutdown. A related reproduced regression now enforces an absolute partial-header deadline. A worst-case escaping test verifies all 128 pending command records plus a 16-event page fit the bounded local reply. The reviewer returned findings before its final report was interrupted; the author completed the remaining review pass. This is not a complete independent review verdict.

Verified increments: `e64be83` attachment service/security/capture leases; `4e96e63` native browser/executable/CLI integration and production attachment recovery; `5091488` review regressions and socket/clock fixes. This checkpoint changes no Raft metadata/storage version, PostgreSQL schema/fences, readiness or retry jitter. Local resume credentials remain plaintext; stdout now includes a private attachment capability. HTTP/WS stays literal loopback; subscription revision zero stays unfiltered.

Exact next action: build the participant UI on the existing browser adapter: roster, chat/history paging, pending/outcome and connection status, screen-share request/queue/release and explicit leave, with clear local capture-owner status. Keep one ClientSession, local display positions and uncertain command IDs. Actual capture/SFU feasibility and committed topic/subscription eligibility are separate follow-up increments; do not invent filtering under revision zero or present a logical share/capture lease as working media. Meeting-code entry, disconnect grace, supervisor/dashboard and complete proxy/network deployment remain unfinished. Continue verified commits and update this handoff. Recommended next session: **GPT sol, high effort** for the UI/session integration; use extra high for a later committed-order subscription or media-fencing protocol review.

### Earlier ClientSession checkpoint (historical)

The [ClientSession checkpoint](../../client-sessions.md) implements a FULL-synchronous local SQLite journal, durable UUID/resume secret and initial join, immutable pending command IDs/contents, retained outcomes and an atomic replay inbox/cursor scoped to meeting and subscription revision zero. The headless participant executable and adapters use one `ClientSession`. Disconnect never generates a new identity or join. Browser attachment was completed by the checkpoint above.

Production `/v1/participant` WebSockets delegate every command/read to existing RuntimeAuthority and SQL fences. Exact owner/incarnation binding, participant credentials, stamped envelopes, bounded frames/output/admission and deadlines are implemented. READY helper metadata selects provisioned participant routes. Runtime listeners share the existing clock/lifecycle. Raft storage version 3, PostgreSQL schema and readiness rules are unchanged.

Production process evidence drops committed join/chat replies, restarts the participant, crashes two runtimes, recovers on the survivor, replays offline history, rejects old owners/incarnations, refuses quorum loss and resolves the original pending ID after quorum restoration. Existing suites retain PostgreSQL restart, paused lock-holder, discovery and helper-leader failure coverage. Final verification and limits are in `evidence/client_session_run/result.json`.

Final verification: `npm test` **56/56**, typecheck passed, `npm run test:runtimes` **16/16** in owned lab `zoom-storage-b0299ce9`; documentation links and diff whitespace passed. The participant scenario completed in 6.95 seconds after a separate 7.19-second targeted pass. No separate consensus-only rerun is claimed.

Independent review reproduced oversized replies (escaped chat and lifetime roster) and malformed replay acceptance. Pages now cap at 16 events; participant snapshots project live members while SQL retains departed identities; complete replay DTO validation precedes cursor commit. Regressions also cover cancellation during route lookup and upgraded-socket idle deadlines. Full process testing exposed repeated NOT_READY collisions between fixed retry/renewal cadences; error retry jitter restores progress without changing readiness.

Earlier next action (now completed above): secured loopback browser attachment and shared CLI identity, pending IDs and inbox. Current meeting selection uses a provisioned UUID and participant routes pin runtime incarnations; a new incarnation requires updated configuration and an agent restart with the same journal. Only unfiltered revision zero is supported. Local credentials are plaintext under filesystem permissions. Media/SFU, supervisor/dashboard and full proxy/network deployment remain unfinished.

Verified earlier increments: retirement `ed460ba`, durable journal/session `87881da`, gateway/runtime composition `b04ff93`, production recovery/evidence `5482a89`. Implementation judgment, tools and verified commits remain authorized without routine confirmation.

### Earlier retirement and discovery checkpoints (historical)

Legacy application retirement is complete: root `peer.ts`, `server.ts`, `client.ts`, `protocol.ts`, `minutes.ts`, `video.ts`/HTML and the old demo entry points are removed, together with their exclusive tests/npm commands and obsolete overlay/coordination operational guides. The only reused dependency was `LamportClock`, extracted unchanged to `coordination/logical-clock.ts` with its existing regression retained. README now describes only the current backend. Root package/TypeScript/Compose/environment configuration remains necessary. Historical evidence and design records remain labeled as historical; executable old milestones are available through Git history. The current default suite has 41 backend tests; the previous discovery checkpoint's 95 count included 54 now-retired legacy tests.

Retirement verification: `npm test` **41/41**, `npm run typecheck` passed, and `npm run test:runtimes` **15/15**, including real discovery/helper routing, PostgreSQL restart/fences and independent runtime failures. See `evidence/retirement_run/result.json` (owned Docker lab `zoom-storage-d20cb592`). No current backend source imports the removed root modules. Preserve the final-response handover preference below.

The latest user clarification supersedes migration compatibility requirements: existing development data is disposable, original APIs/protocols/demos may be replaced freely, and old milestones can remain in Git history. Preserve the new Raft/PostgreSQL/runtime safety guarantees and runtime durability. Do not retain combined legacy responsibilities at the expense of the final architecture.

The [Chord discovery checkpoint](../../chord-discovery.md) adds a focused 128-bit bigint overlay with canonical hex wire IDs, cluster/peer/service/meeting namespaces, 128 fingers, predecessor/four-successor maintenance, bounded iterative lookups, multiple bootstrap addresses, expiring replicated hints and partition healing. An authenticated executable peer publishes configured service hints. A bootstrap-only client and `DiscoveredHelpers` connect discovery to `startMeetingRuntime` through optional `discovery` configuration; cached authenticated helper barrier reads take priority over rediscovery. All runtime transports share one Lamport clock, and uncertain writes are never automatically replayed. `resolveMeeting` independently reconciles READY Raft metadata and ACTIVE SQL ownership; discovery hints grant no authority.

Independent review reproduced and drove regressions for isolated-peer and surviving-subring healing, malformed initialization bypass, reordered TTL refresh, cached-helper renewal starvation, shutdown with pending lookups and the shared runtime clock. Further regressions cover private configuration serialization and stalled bootstrap fallback. Actual process integration now provisions four discovery peers, supplies helper routes solely through discovery to three independent runtimes, removes a discovery bootstrap, then repeats helper-leader loss, two runtime crashes, durable outcome recovery, incarnation rejection and quorum refusal. Tests still issue domain commands through the existing evidence IPC fixture. Production participant transport is not implemented.

Fresh verification: `npm test` **95/95**, `npm run typecheck` passed, and `npm run test:runtimes` **15/15** (7 storage, 4 storage faults, 2 recovery, 2 runtime process tests). Final regressions include two stalled bootstraps before a healthy third, and failed-owner exclusions so stale remote successor lists cannot prevent hint lookup before stabilization. The latter was exposed by a full-suite run and reproduced before fixing. The Docker suite required elevated Docker access after the sandbox denied its named pipe. Evidence is summarized in `evidence/discovery_run/result.json`; the final isolated lab was `zoom-storage-43092535`. No coordinator storage/schema version was changed, and the separate consensus-only suite was not rerun for this increment.

Earlier next action (completed by the checkpoint above): implement durable ClientSession storage and retry/replay semantics before participant migration. Read storage command authentication/deduplication and `MeetingStore.read` watermarks first. Persist participant UUID/resume secret plus join/command identity and immutable contents before any send; retain uncertainty through restart; scope replay to meeting and future subscription revision. Connect the session to real fenced storage/takeover tests, then a production join → chat → runtime failure → reconnect/replay path. GUI and CLI must share that session. Topics/subscriptions, browser attachment security, UI/media, supervisor and proxy deployment remain unfinished.

The user authorized implementation judgment, branch selection, commits and tools, then enabled Docker and asked to continue. That authorization persists. No further user decision is needed to continue routine implementation. The [first plan](../plans/2026-11-25-coordinator-foundation.md) and [coordinator guide](../../coordinator-foundation.md) document the durable helper foundation. The original assignment/spec content is preserved as design input.

Implemented: deterministic reservation/runtime/candidate metadata, durable Raft helpers, stamped authenticated loopback transport, guarded nonvoter admission/promotion/removal, TypeScript bridge, and checked independent-process crash/restart/snapshot/quorum scenarios. The original participant/peer/media demos have been retired. Candidate assignment is not effective PostgreSQL ownership.

Independent review findings around RPC validation, lost-store identity and durable clocks were fixed with failing-then-passing regressions. Raft `GetConfiguration().Index()` returns zero in this version: use the committed `ConfigurationStore` callback and snapshot its index; never disable membership guards with zero.

The [consensus checkpoint](../../consensus-safety.md) now repairs the three reproduced upstream log/snapshot failures using an auditable local module replacement. Original safety tests are always enabled. The patch preserves an interrupted transfer's possibly committed logs, reconciles durable snapshot/log state before service and on startup, retains matching pending configuration and fails closed on uncertain cleanup or failed leader writes. Source checksums, original proposed PRs and the actual production delta are retained in `third_party/hashicorp-raft`. A live five-voter 2/3 TCP partition tests minority refusal, majority progress, snapshot catch-up, healing, restart and removal to four voters. Real child-process crashes cover both sides of snapshot publication. Storage/envelope version 2 rejects old histories/helpers; preserve old directories instead of editing their version markers. This is bounded failure evidence, not a broad consensus-safety proof.

Docker is working. The independently reviewed [PostgreSQL checkpoint](../../postgresql-fencing.md) covers versioned migrations/cluster identity, fenced command/activation/closure paths, stable outcomes, contiguous events, FIFO screen-share handoff plus transactional media intentions, participant snapshot reads and restricted inspection. Eleven real Docker tests pause a lock-holding client, restart PostgreSQL with its volume, and verify owned-lab cleanup. Review regressions cover participant turnover and immutable in-flight command/owner inputs. Those separate storage tests use explicit assignments; the headless controller integration is covered by the later checkpoint below.

The [ownership activation checkpoint](../../ownership-activation.md) now implements conditional INTENT/READY metadata, revision-guarded renewal, monotonic runtime readiness, a headless leader reconciliation loop and failure suspicion. Real helper/PostgreSQL tests SIGKILL a recovery child after each durable transition and lose replies after Raft/SQL commits; they verify retained outcomes/state, late owner rejection, candidate failure replacement, fresh leader grace and quorum refusal. Independent review found and fixed candidate failures resetting suspicion and renewal history exceeding the authority reply limit. A stop-during-refresh race was also reproduced and fixed. Coordinator storage version is now **3**; preserve old directories and start fresh helpers, with no rolling mixed-version upgrade claim.

The [remote runtime checkpoint](../../remote-runtimes.md) now connects provisioned authenticated `Candidate` adapters to independent runtime processes. Runtime registration retries preserve the command ID and provisioned expected revision; replaced incarnations stop instead of reclaiming the registry. Background READY reconciliation schedules existing `RuntimeAuthority` renewals, handles configured helper leader changes and invalidates stopped/failed gates. Runtime RPC pins the destination incarnation, validates stamped frames and bounds request size, deadlines and admission. Its trust model is the existing trusted local backend control plane; all runtime/helper routes still require literal loopback addresses. Process tests activate through remote adapters, lose a helper leader, kill two of three runtimes, recover retained membership/outcomes on the survivor, restart an unassigned incarnation and refuse service after quorum loss. A terminal registration cleanup regression covers automatic listener/pool release. See `evidence/runtime_run/result.json` for checked results.

Earlier priority (now completed for headless participants): durable ClientSession identity/replay and production participant transport. Continue SFU feasibility, complete whole-system proxy routing, supervisor and dashboard afterward. Runtime routes and registration revisions remain provisioned explicitly; helper endpoints can now be discovered. LAN/container-network transport and automatic runtime placement announcements are incomplete. The production runtime control listener exposes status/preparation only; test IPC exercises storage commands without creating a participant protocol. Retained coordinator outcomes still have the existing 32 MiB snapshot capacity limit; long-term garbage collection is deferred. See checkpoint documentation and evidence summaries for actual limits.

## Read first

1. [Current design](../specs/2026-11-21-distributed-meeting-redesign.md): authoritative design proposal, including ownership/recovery mechanics and acceptance evidence.
2. [Assignment requirements](../../assignment-reqs.txt): actual milestone wording.
3. This handoff: conversation decisions, scope, and next action.

The current design replaces its earlier SQLite/certificate architecture. The 2026-09-10 video MVP design is historical. Do not combine incompatible old designs or reconstruct decisions from a long conversation when the current spec answers them.

## Confirmed decisions

- The main purpose is learning distributed systems; understanding agentic coding is secondary. Deliver an understandable, working meeting demo.
- Incremental implementation with complete integration paths; legacy demonstrations need not remain operational (latest user clarification).
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
- Commit coherent, verified implementation increments as work progresses; the user explicitly expects commits and does not want finished increments left uncommitted.
- End each implementation turn with a self-contained handover for the next session when work remains: summarize the committed result and checks, link this handoff, and include a copyable continuation prompt with the exact next action and material limits.
- Do not weaken ownership or durability guarantees through an undocumented shortcut.
- Existing database/SFU availability limits are intentional scope, not completed high availability.
- The assignment permits several consistency strategies and requires at least one important replicated dataset. Library acceptance is assumed from its wording, not confirmed by an instructor.
- Automated demo clients do not bypass browser capture permissions.
- Preserve user changes. At the start of this documentation task, both the assignment file and current spec were untracked; do not stage or commit them without checking scope.
- Git required a per-command safe.directory override in the sandbox. Do not change global Git settings to work around it.

## Suggested continuation prompt

> Continue from docs/superpowers/handoffs/2026-11-25-distributed-meeting-redesign.md, docs/client-sessions.md and the referenced spec on milestone-5. Secured loopback browser attachment is implemented and verified: token/Origin/Host checks, reload continuity, revisions and one local capture owner around the shared ClientSession. Build the participant UI using client/browser-attachment.js: roster, chat/history paging, pending/outcome and connection status, share request/queue/release, leave and local capture-owner status. Preserve shared CLI identity/pending IDs/inbox, uncertain-submit behavior, Raft metadata, SQL fences, readiness and retry jitter. Keep subscription revision zero unfiltered and runtime routes/incarnations provisioned. Actual capture/SFU and committed topic/subscription eligibility remain separate work; show logical grants accurately. Local credentials and the startup attachment URL are private plaintext capabilities. Implementation, tools and verified commits remain authorized. Update the handoff and end with a copyable continuation prompt and recommended model/effort.
