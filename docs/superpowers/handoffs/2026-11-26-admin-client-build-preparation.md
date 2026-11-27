# Admin/client build preparation

Prepared: 2026-11-26.

**Status:** The accepted direction now has a [staged implementation plan](../plans/2026-11-26-admin-client-application.md), prepared after code inspection on 2026-11-26. Review that plan before application implementation; neither this brief nor the plan authorizes the entire expansion. Planning changed documentation only. No push, merge or deployment.

## Planning checkpoint — read before continuing

- Follow-up: the user says the staged approach sounds reasonable and authorizes committing ready work. The finished target remains all four accepted screens with real operations through all eight increments. This authorizes the documentation/design checkpoint; no application increment has been started in this session.
- Latest scope reduction: **drop whole-backend Resume**. Every launch starts a fresh empty backend. Remove Previous Backend/Resume from setup, cross-launch restoration, legacy-demo import and archive management. Retain current-run node/client restart, browser reattachment, quorum/failover, durable journals and exact owned cleanup. Old requirements to resume completed runs are superseded.
- Setup draft revision 6 removes the Resume section and uses fresh-start copy; the overview image is refreshed. The accepted admin/client layout and final hover/share-width refinements remain. No new visual exploration or application implementation is needed for this scope edit.
- Static draft checks passed at 1400/390/320px for fresh-only setup, four independent minimum-one fields, conditional hints and no horizontal overflow. Documentation links/whitespace were checked; no product suites were rerun. `package-lock.json` and the admin/meeting close-up images retain their prior bytes.
- The plan covers the remaining required application in eight increments. The smaller first increment is **fresh coordination inventory and independent discovery/consensus startup**, tested with real 1/2/5-count process cases and owned cleanup in isolated roots. It introduces a reusable component; the existing demo may remain the user-facing launcher at this checkpoint. It does not claim full backend startup, admin-first entry or completed redesign.
- Idle media and full four-role backend startup are a separate second increment. The proposed media design is a real idle media node with explicitly provisioned, isolated per-meeting routers/fences/capabilities, followed by authenticated hot routes and caller-incarnation refresh. Current startup-only runtime/client routes and single-meeting kernel are not sufficient. The plan also identifies missing explicit discovery departure, runtime retirement and coordinator meeting-close state.
- Initial independent counts 1–5 for each role and isolated per-meeting media rooms remain engineering recommendations. No reset/resume policy questionnaire is needed. New runs use new namespaces and leave existing data alone; retained ownership records remain diagnostic, not a resume feature. One/two voters have no single-voter failure tolerance; assignment discovery evidence still needs four peers.
- Remaining increments cover secured real admin setup, live Chord/Raft membership, hot media/routes, concurrent create/join/client sessions, role-specific drains/crash/restart/logs/restricted console, and the accepted client UI/final integration. See the plan for dependencies, file boundaries, checks and exactly what remains at each checkpoint.
- Inspection baseline: branch `milestone-5`, HEAD `bc3e6ad`; completed implementation `96e80b2`. Existing `package-lock.json` change and all accepted draft/previews were preserved. No services, installs, builds, product tests, delegation or product changes were needed for planning. Do not rerun completed demo work to review this plan.

## Read first

1. This preparation brief: consolidated current requirements and next action.
2. [Accepted visual draft](../../design-drafts/2026-11-26-admin-client.html): revision 6 removes Resume from the accepted revision-5 design and retains final row-hover/share-width refinements. Open it in a browser; its operational behavior is simulated.
3. [Four-screen preview](../../design-drafts/2026-11-26-admin-client-preview.png), [admin detail](../../design-drafts/2026-11-26-admin-detail.png), [meeting detail](../../design-drafts/2026-11-26-meeting-detail.png).
4. The current follow-up and completed-demo checkpoint in the [long-running handoff](2026-11-25-distributed-meeting-redesign.md). Earlier instructions there are historical where superseded by this brief.
5. [Assignment requirements](../../assignment-reqs.txt), [current demo guide](../../single-computer-demo.md), and relevant parts of the [architecture specification](../specs/2026-11-21-distributed-meeting-redesign.md).

The architecture specification and DESIGN.md contain older UI/progress descriptions. The latest handoff establishes completed work; the accepted draft establishes the replacement appearance. Do not restart completed milestones or preserve the rejected old UI merely because DESIGN.md describes it.

## Accepted product direction

### Backend setup

- Application entry opens administration before automatically creating a meeting or participant sessions.
- The setup box contains **Backend Setup** and **Start**. Remove previous-backend information and Resume under the latest scope reduction.
- Whole-backend presets precede Initial Capacity. Manual meeting/client setup is acceptable.
- Independent, non-hardcoded initial counts for **Discovery Peers**, **Consensus Nodes**, **Meeting Servers**, and **Media Servers**. Minimum 1 at setup. Counts such as 1, 2 and 5 must be considered explicitly; do not restrict consensus to odd counts or pair its count with discovery.
- Defaults can retain the current 4 discovery / 3 consensus / 2 meeting / 1 media configuration. Zero-start support is deferred.
- Each Start allocates fresh meeting/coordinator/journal state together in a new run namespace. No prior backend is reopened or imported. Existing demo data is left untouched. Uncertain prior ownership still blocks another run; fresh startup never bypasses a stale lock or silently deletes old resources.
- Hide fulfilled hints. Put each remaining hint on its own line. Bottom helper copy describes what the user **can** do later.

### Administration

- One collapsible sidebar contains meetings, clients, discovery peers, consensus nodes, meeting servers, media servers and storage. Keep discovery and consensus separate; no logical-node pairing/refactor.
- Group headers have **+**. Individual rows expose a **minus** control on hover/focus, also accessible on touch. Hovering the minus highlights the entire row.
- Adding discovery/consensus nodes while the backend runs is required. Graceful role-specific removal is required as well; it is separate from a crash. Address live addition/removal for the other exposed roles explicitly rather than leaving fake operational controls.
- The center shows information appropriate to the selected meeting, backend node or client. Detail tabs are **Overview** and **Actions**; there is no detail-pane Logs tab.
- Logs/Command Console occupy the panel below the details. Sidebar selection and a source dropdown control logs. Keep bounded output and a simple Expand control; advanced log-query tooling is not required.
- The console must accept supported commands and return real results/errors through the same control operations as dashboard buttons. The mockup's command aliases are proposals, not existing CLI syntax. A full shell/PTY terminal is deferred.
- Clients are controllable admin items with browser access, status/logs, crash/restart and appropriate participant actions. Use their existing shared session/journal. Stopping a client process is distinct from durable Leave Meeting; device capture always needs browser permission and valid capture ownership.
- Role hints are limited to **Owner** and **Leader**. Owner means a server owns at least one meeting; show ownership/generation per meeting in its details, not as a lab-wide exclusive role.
- Multiple concurrent meetings are required. Do not substitute a fixed single-meeting demo as the final deliverable.

### Client

- Home focuses on **Create Meeting** and **Join Meeting**, with no product-name header or promotional copy. Both admin and client can create meetings.
- Meeting view uses light mode, no meeting heading bar, and no sample-data labels in the product. Put title, elapsed time and connection details under More; received-event inspection is More → Logs.
- Keep media controls prominent and People/Chat/More compact. Labels use Title Case; Leave is an icon with **Leave** underneath.
- Request Share / People / Chat / More form a group centered on the meeting window independently of uneven left/right controls.
- Share request/cancel must not change the button or group's horizontal size or position. Queue position appears beneath the icon; clicking again cancels. Receiving a turn still requires an explicit browser display choice before capture.
- Chat uses horizontally scrolling named channel buttons with a trailing plus for group creation, and a bottom composer with a small send icon at its right. Preserve per-channel drafts.
- Keep ordinary diagnostics hidden, but show an actionable contextual warning when original command delivery is uncertain. Do not silently submit a new command.

## Scope discipline

The deliverable is a dependable local assignment lab, not a general simulation platform. Reuse the existing Chord, Raft, storage, journal and media foundations.

Required backend work includes configurable fresh startup/inventory, live membership/lifecycle, manual meeting/client creation, multi-meeting operation and real control/log transport. Whole-backend Resume has been dropped as a convenience feature. Earlier session prompts that require it, indefinitely retain hardcoded counts or defer all live addition are obsolete. Early increments may temporarily use the existing launcher, but that is a staging choice, not completion of the requested application.

Defer network editing, arbitrary TCP/UDP faults, configurable latency, pause/global-time controls, a full terminal, general maintain-N/autoscaling/replacement management, desktop installers and deployment. The user permits dropping network editing unless it is relatively easy; current TCP cut/heal fixtures do not establish a general admin feature. Needed provisioning inside an explicit Create Meeting/Add Node operation must still be designed; deferring a general reconciler does not erase those lifecycle needs.

## Existing implementation and the gaps to inspect

| Area | Relevant source | Current fact / planning consequence |
| --- | --- | --- |
| Fixed scenario and recovery | `scripts/demo-stack.ts` | Creates one meeting, fixed participants and media during startup; recovery ticks that one meeting. Split backend lifecycle from meeting/client lifecycle and generalize readiness/recovery by meeting. |
| Saved configuration | `scripts/demo-state.ts` | Manifest version 2 requires exactly 3 helpers and 2 runtime IDs; participant names are Alice/Bob/Charlie/Outsider. Discovery peers are currently generated at launch. Plan inventory, stable identity, retirement and saved-topology handling. Do not edit old format markers to force acceptance. |
| Supervisor control | `scripts/demo.ts`, `scripts/demo-control.ts` | Existing authenticated CLI supervisor control rejects browser Origin requests and accepts no request body. A browser admin needs a deliberately secured attachment/API; do not simply remove checks or expose cluster credentials. |
| Owned child processes | `scripts/demo-child.ts`, `scripts/demo-lock.ts`, `scripts/demo-journal.ts`, `scripts/bounded-command.ts` | Reuse bounded commands, ownership locking, journal validation and exact owned-child shutdown. An uncertain stale lock is not permission to kill recovered PIDs or delete state. |
| Discovery | `coordination/discovery.ts`, `coordination/discovery-rpc.ts`, `scripts/discovery-peer.ts` | Real Chord join, lookups, maintenance and failure repair exist. Add supervisor inventory/spawn/leave/restart and bootstrap refresh. Initial announcements are captured at service startup. |
| Consensus | `services/coordinator/node.go`, `coordination/helper-client.ts`, `coordination/helper-route.ts`, `coordination/discovered-helpers.ts` | Guarded nonvoter admission, catch-up, promotion and removal exist. Orchestrate these safely and refresh discovery/routes; cached helper routing currently caps lists at 9 endpoints. Pick and test bounded supported counts. |
| Per-meeting authority | `coordination/runtime-agent.ts`, `coordination/runtime-service.ts`, `coordination/recovery-controller.ts`, `storage/meeting-store.ts` | Metadata/storage/runtime authority distinguish meetings and support multiple assignments. Lifecycle/status/recovery still need generalization around them; reachability is never replacement authority. |
| Media lifecycle | `media/runtime-media.ts`, `media/provision.ts`, `media/kernel-fence.ts`, `services/media/kernel.mjs` | Runtime media routes are supplied at startup; the SFU kernel is initialized with one `MEDIA_MEETING_ID`. Hot meeting creation and an idle media server before any meeting need a concrete lifecycle design. Do not infer arbitrary room sharing from the underlying SFU library. |
| Shared client control | `scripts/participant-agent.ts`, `client/participant-agent.ts`, `client/client-session.ts`, `client/session-journal.ts` | JSON-lines commands and browser attachment use the same durable session. Generalize clients beyond fixed names; retain identity/original commands and never reuse a journal for a different meeting target. |
| Client presentation | `client/participant.html`, `client/participant.css`, `client/browser-bootstrap.js`, `client/participant-model.js`, `client/group-controls.js` | Reorganize the real controls to match the accepted draft. The standalone mockup contains simulation code; do not copy its local state transitions into production behavior. |

## Current scope choices

1. **Fresh only:** the user dropped Resume. Do not build saved-backend selection, restoration, legacy import or archive management. Preserve old files/volumes by default without presenting them as reopenable backends; permanent deletion is separate explicit work. Never clean/reset while ownership is uncertain.
2. **Current-run recovery stays:** node/client crashes, same-journal restart, browser reload and live membership retries still need state and fencing. Whole-supervisor death retains the existing manual ownership-recovery blocker; no automatic restorer is required.
3. **Media provisioning:** the plan recommends real idle media nodes followed by isolated per-meeting rooms and authenticated hot route/caller updates. These are engineering choices; explain cost without asking the user to design them.
4. **Counts and limits:** preserve independent values, minimum 1 and even counts. The plan proposes 1–5 per role initially; one or two voters cannot tolerate one voter failure, and the assignment P2P demonstration needs 4+ discovery peers.

These do not justify reopening the accepted appearance or a long questionnaire. Ask only consequential user-policy questions; ordinary engineering choices remain the implementer's responsibility.

## Planning-session brief (completed; retained for context)

Prepare an implementation plan, not another visual draft and not an immediate full rewrite.

- Inspect repository instructions and the current working tree first; read the files above selectively.
- Define small end-to-end increments, their dependencies, real observable deliverables and meaningful checks. Separate ordinary UI/control wiring from durable lifecycle/membership and media changes so costs are visible.
- Recommend a first bounded increment: variable initial discovery/consensus counts, fresh run inventory and safe owned cleanup, plus a path to starting backend services independently of the fixed scenario. Resume was subsequently removed. Resolve idle-media/startup separately; wire UI incrementally as real operations become available.
- Specify exactly what remains after each increment. Do not call the redesign complete after only a reskin, fixed-demo dashboard or simulated create/join controls.
- Present the first increment and the material reset/media policy choices in plain language. Obtain review of the bounded plan before application implementation; the user has asked to prepare for building, not yet to execute the entire project.

## Verification and continuity

- No Docker startup, builds, installs, product tests or app changes are needed merely to prepare the plan. Existing demo evidence is historical evidence, not a request to rerun it.
- For implementation, use focused checks per changed boundary and the relevant real integration gates. Exercise 1/2/5 counts, retained identity/topology, interrupted lifecycle operations, safe Raft membership, multi-meeting privacy/ownership/media isolation, and cleanup without affecting unrelated resources. A mockup check does not prove backend behavior.
- Final integration should demonstrate two concurrent meetings with real clients/media, creating from admin and client, node addition/graceful departure, a recoverable targeted crash with sufficient capacity/quorum, client restart within the current run, clean owned shutdown and a subsequent fresh empty launch.
- Preserve quorum, authoritative READY/ACTIVE ownership, runtime/SFU fencing, explicit browser capture, FIFO sharing, invite-only group history and shared original-command uncertainty. Do not add a second participant protocol.
- Work directly and budget-consciously. No routine delegation or repeated full-suite reruns without a reason. During execution, commit coherent verified increments; no push/merge/deploy without instruction. Stop at meaningful checkpoints and update the handoff rather than hiding unfinished work.
- Current branch at preparation: `milestone-5`. HEAD: `bc3e6ad` (documentation); completed implementation checkpoint: `96e80b2`. Read current Git state again next session.
- Existing unrelated user change: `package-lock.json`. Current handoff edits and `docs/design-drafts/` artifacts are uncommitted session work. Preserve them; do not sweep unrelated files into commits. No credentials/private URLs are included in these artifacts.

## Copyable review/next-session prompt

```text
Read docs/superpowers/handoffs/2026-11-26-admin-client-build-preparation.md and docs/superpowers/plans/2026-11-26-admin-client-application.md. The implementation plan is prepared, not implemented or approved. Review it rather than restarting planning, visual exploration or completed demo work. The accepted draft is docs/design-drafts/2026-11-26-admin-client.html.

The recommended first bounded increment is fresh coordination inventory plus independent discovery/consensus startup and focused real-process verification of 1/2/5 counts and owned cleanup. The new component is separate from full backend startup; idle media and all four configurable roles follow in increment 2. Whole-backend Resume has been dropped: no previous-backend selector, cross-launch restoration, legacy import or archive manager. Keep current-run node/client restart and failover. Implement only the increment explicitly authorized after review; do not infer authorization for all eight increments.

Preserve remaining required scope: admin-first fresh setup, four independent counts (minimum 1), live additions/graceful removals, targeted crash/restart, concurrent meetings, real admin/client create/join, shared client journals, logs/restricted console and accepted UI. Keep network editing, a full shell, zero-start and general autoscaling deferred. Preserve safety guarantees and unrelated changes, especially package-lock.json; retain accepted design refinements except the removed Resume setup. Work inline without routine delegation; no installs, service startup or product test reruns merely for review. No push/merge/deploy.
```
