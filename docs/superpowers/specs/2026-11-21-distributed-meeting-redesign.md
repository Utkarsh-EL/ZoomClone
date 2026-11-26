# Distributed meeting redesign

Date: 2026-11-21
Revised: 2026-11-25
Status: revised architecture proposal; coordinator, [consensus repair](../../consensus-safety.md), [PostgreSQL storage foundations](../../postgresql-fencing.md), [headless ownership activation](../../ownership-activation.md), [authenticated loopback runtimes with renewal scheduling](../../remote-runtimes.md), [128-bit discovery](../../chord-discovery.md) and [durable ClientSession/production participant replay with secured participant UI](../../client-sessions.md) implemented on `milestone-5`. The UI covers roster, chat/history, pending outcomes, connection status, logical sharing, leave and local capture ownership. Actual capture/media, subscriptions, meeting-code entry and broader deployment remain integration work. The full design is not yet implemented or validated.

## 1. Purpose and current decisions

Build a Zoom-like meeting demo that teaches the five milestones in [the assignment requirements](../../assignment-reqs.txt). Learning distributed systems is the primary goal; learning how to collaborate with a coding agent is secondary. Prefer a coherent, demonstrable system over implementing an additional storage protocol.

This document is the current design proposal. It supersedes its earlier SQLite, primary/backup application replication, and per-message Raft certificate design. The historical video MVP specification describes a different architecture.

### Confirmed direction

- Develop incrementally toward the finished product. Original application APIs, protocols, demonstrations and development data may be replaced freely; preserve the new Raft/PostgreSQL/runtime foundations and their safety and durability guarantees. This clarification supersedes earlier migration compatibility requirements.
- Keep backend coordination peers separate from participant clients and meeting runtimes.
- Use Chord for peer-based discovery and an existing Raft implementation for coordinator agreement.
- Support even and odd coordinator configurations, including agreed voter addition/removal. Four peers is an assignment minimum; five is the default demo preset.
- Keep voting membership distinct from observed reachability. A failed node remains a voter until a configuration change removes it.
- Have one active runtime handle each meeting's participants. Other runtimes provide replacement capacity and may host other meetings; distributing one meeting across several active runtimes is out of scope.
- Store durable meeting data in shared PostgreSQL, accessed over the network. Use Docker Compose to simplify database setup, with a pinned image, health check, persistent named volume, and example configuration.
- Start with one PostgreSQL instance. Automatic database failover is deferred.
- Keep GUI and CLI operations on the same participant session. Use an existing SFU for real audio/video, with concurrent cameras/microphones and one screen share per meeting.
- Retain chat, identities, subscriptions, screen-share grants/queue, and command outcomes through meeting-runtime recovery. Participants reconnect without manually rejoining.
- Provide an administration dashboard for lifecycle management, topology, health, logs, fault injection, and cleanup.
- Support editable scenario batches and presets. Changes execute only when Apply is selected. Exact simultaneity, deterministic simulation, and a global clock freeze are out of scope.
- Provide individual node suspension/resumption as a fault. Time continues during such suspension.
- Make the single-computer demo dependable. Support prepared group-member devices on a reachable local network; public-internet hosting and audience installation are not initial requirements.

### Engineering proposals in this revision

The user delegated implementation details. These proposals make the design concrete for review; they are not additional historical user decisions:

- HashiCorp Raft in a Go helper paired with each TypeScript coordination peer, using durable Bolt-backed log/stable stores and file snapshots. The current implementation carries an explicitly documented local dependency repair; see the consensus checkpoint above for provenance and limits.
- PostgreSQL ownership fencing through a locked row per meeting, shared by all command and ownership transactions.
- A coordinator reconciliation worker that bridges committed assignment metadata to PostgreSQL fencing and runtime activation. Section 7 defines the ordering.
- Linux containers for managed backend nodes, the SFU, and fault proxies, in addition to PostgreSQL. This extends the confirmed database-only Docker requirement to simplify lab lifecycle and real process suspension on Windows.
- A local TypeScript lab supervisor and browser dashboard, outside the tested node set. Local participant agents remain host processes serving loopback browser pages.
- mediasoup behind a TypeScript media adapter and Toxiproxy for application TCP faults, subject to early feasibility checks.

No product code, dependency installation, or detailed implementation plan is part of this document revision. Approval of the revised design precedes implementation planning.

## 2. Scope and alternatives

| Approach | Benefit | Decision and cost |
| --- | --- | --- |
| SQLite in each meeting server with custom replication and coordinator certificates | Implements replication and commit resolution directly | Superseded. Too much correctness-critical protocol work for the desired application scope. |
| Full meeting records in one global coordinator Raft group | Joins ordering and replication in one protocol | Not selected. Coordination peers should remain lightweight; one shared group would carry every meeting's payload and commit traffic. |
| A Raft data group with three meeting-server replicas per meeting | Established quorum replication, isolated from coordinator storage | Considered, then superseded by shared PostgreSQL to reduce implementation complexity. |
| Shared PostgreSQL and replaceable meeting runtimes | Delegates transactions, crash recovery, and durable shared storage to an established engine | Selected. The initial database is a single availability dependency. Application ownership, reconnect, retries, and media fencing remain our responsibility. |
| Simpler ring or gossip discovery | Less overlay implementation work | Chord remains the selected learning exercise. Its hints cannot authorize writes. |
| Globally paused simulation with adjusted clocks | Can preserve selected timers during scenario editing | Deferred. Third-party timers, sockets, and media make a complete freeze much larger than batch fault injection. |

PostgreSQL does not eliminate replication as a concept. It allows database replication to be configured separately later. The initial replicated dataset for Milestone 5 is important coordinator metadata, not meeting chat. That mapping follows the supplied assignment wording; the file does not state whether algorithms must be implemented without libraries.

Accounts, scheduling, recording, breakout rooms, seamless SFU failover, database high availability, arbitrary remote-host orchestration, and a general simulation platform are deferred.

## 3. Existing work and migration boundaries

The original root application, 16-bit overlay, TCP participant protocol, ring election/file locks, still-frame media and their exclusive tests/demos have been retired to Git history. Their behavior is not a compatibility requirement.

- `coordination/logical-clock.ts` retains the reused Lamport clock; `coordination/wire.ts` supplies the authenticated stamped control envelope. The original protocol/framing API has been removed.
- `coordination/` owns discovery, helper routing, ownership recovery and runtime lifecycle. `services/coordinator/` and the repaired Raft dependency own durable coordinator metadata.
- `storage/` owns durable meeting commands, identities/verifiers, outcomes, events, snapshot reads and SQL fencing. `client/` owns the durable participant journal/session, runtime WebSocket transport and secured loopback browser adapter; the runtime participant gateway delegates every command/read to existing readiness and SQL fences. Browser attachment/capture revisions are local; committed subscription revisions remain unfinished.
- SFU media must replace the retired still-frame demonstration. Historical design/evidence records do not establish current media or participant guarantees.
- `docs/superpowers/specs/2026-09-10-video-meeting-mvp-design.md` is historical context, not another current specification.

Inspect the current modules before implementation. Preserve the new safety boundaries while completing the remaining product.

## 4. Roles and interfaces

### Processes

1. Coordination peers: a TypeScript Chord/operations process paired with a Go Raft helper. Each pair has a stable coordinator ID; both processes have distinct process/incarnation identities.
2. Meeting runtimes: a pool of TypeScript servers. Exactly one runtime incarnation handles application commands for a meeting at a time. A runtime can host several meetings.
3. PostgreSQL: one shared durable database service. Meeting state is partitioned by meeting ID in the schema; spare runtimes connect to the same service.
4. Media service: a TypeScript adapter with SFU workers. Its rooms, transports, and producer bindings are transient.
5. Participant agents: one ClientSession per participant, shared by CLI and loopback browser UI. Capture/playback remain in the browser.
6. Lab supervisor: an out-of-band local process controlling lab resources, serving the admin dashboard, and collecting observations. Meetings do not require the dashboard to remain open.
7. Fault proxies: managed TCP endpoints for selected application links, with a control path outside the injected failures.

The default lab has five coordinators and three meeting runtimes. The three runtimes are one active host plus available replacements for the demo meeting, not three copies of its database or three dedicated machines per meeting.

### Modules

| Module | Public responsibilities |
| --- | --- |
| ClientSession | Join, submit, observe, resume, leave; identity, durable pending IDs, cursors, and connection state. |
| MeetingEngine | Pure evaluation of permissions, membership, chat, subscriptions, groups, and screen-share queue/grants. |
| MeetingStore | Fenced PostgreSQL transactions, outcomes, events, consistent reads, and replay. |
| CoordinationService | Chord hints; Raft-backed reservation, server registration, generations, assignments, renewal observations, and voter changes. |
| RecoveryController | Reconcile assignment attempts, fence storage, prepare candidates, enable ownership, and record readiness. |
| Gateway | Versioned authenticated control/signaling, bounds, backpressure, routing, and subscriptions. |
| MediaService | Serialize room control; validate current authorization; fence, reconcile, publish, subscribe, and stop. |
| LabSupervisor | Provision, inspect, drain, stop, crash, suspend, resume, inject/heal faults, apply scenarios, and shut down lab resources. |

### Architecture

~~~mermaid
flowchart TD
    GUI[Browser GUI] --> AGENT[Participant agent and CLI]
    AGENT <-->|Commands, events, resume| ACTIVE[Active meeting runtime]
    AGENT <-.->|Reconnect after takeover| SPARE[Replacement runtime]
    AGENT <-->|Chord lookup| PEERS[Coordination peers]
    PEERS <--> RAFT[Raft helpers: assignment metadata]
    ACTIVE <-->|Registration and renewal| PEERS
    SPARE <-->|Registration and activation| PEERS
    PEERS --> RECOVERY[Coordinator recovery controller]
    RECOVERY -->|Install ownership fence| PG[(Shared PostgreSQL)]
    ACTIVE -->|Fenced transactions| PG
    SPARE -->|Same database after activation| PG
    ACTIVE -->|Room control| MEDIA[Media adapter and SFU]
    MEDIA -->|Current authorization reads| PG
    GUI <-->|WebRTC| MEDIA
    ADMIN[Admin dashboard] --> LAB[Local lab supervisor]
    LAB -.->|Lifecycle and fault control| PEERS
    LAB -.-> ACTIVE
    LAB -.-> SPARE
    LAB -.-> PG
    LAB -.-> MEDIA
~~~

## 5. Identity, discovery, and coordinator membership

Use stable UUIDs for clusters, coordinators, servers, meetings, and participants. A process restart creates a new incarnation. Assignment and storage fences bind both stable runtime ID and incarnation; restarting a server does not silently inherit an old process's write authority.

Meeting codes map to immutable meeting IDs. Reserve codes through Raft so simultaneous creation cannot create separate meetings under one code. Initial creation is resumable and idempotent. Keep canceled/closed reservations as tombstones initially instead of silently reusing codes.

Chord uses a namespaced 128-bit identifier space, hexadecimal on the wire and bigint internally. Maintain fingers, predecessors, and successor fallbacks; bound hops, retries, and time. Demonstrate real finger shortcuts rather than neighbor-only routing. Chord locates registered services and meeting placement hints. Hints have generations and expiry, but may be stale.

An authoritative lookup must reconcile current coordination status with the installed PostgreSQL owner fence before reporting a runtime as ready. Distinguish unknown from temporarily unavailable. Clients retain multiple bootstrap addresses. No sole gateway or dashboard process is required for discovery.

Raft helpers communicate directly through their configured transport endpoints; do not route consensus through Chord hops. Joining the overlay and becoming a voter are separate operations. Synchronize a joining helper as a nonvoter, then use the library's serialized, version-guarded membership API. Removal, including deliberate removal of a presumed permanently dead voter, requires an agreed configuration change.

A timeout is suspicion, not proof of death or an automatic change to the denominator. Four voters require three votes even after one crashes. Five voters also require three. A partition cannot redefine its reachable members as a new independent majority.

A stopped voter restarts using its durable identity and Raft state and catches up as the same member. A previously removed voter must be deliberately admitted again. A node that lost its durable voting state follows an explicit replacement procedure; do not treat an empty directory as a normal restart or create a second process with the same voter identity.

Bootstrap only through explicit initialization. Never bootstrap a replacement cluster because old peers are unreachable. Graceful leave removes the voter before stopping where possible; blocked removal remains pending. Support even/odd sizes and runtime addition/removal without hardcoding five.

## 6. Failure model, ordering, and availability

Target trusted authenticated application processes that crash, restart, pause, or experience message loss, delay, duplication, and partitions. Byzantine behavior and compromised cluster credentials are outside scope.

Coordinator Raft stores name reservations, server registrations, generations, assignments/attempts, health/renewal revisions, lifecycle status, and durable membership information. It stores no per-chat commit ledger, chat bodies, resume secrets, or SDP. Its snapshots are coordination snapshots.

PostgreSQL stores meeting policy and state, participant verifiers/membership, subscriptions, chat/events, screen-share queue/grant, idempotency outcomes, media reconciliation intentions, and the effective owner fence. PostgreSQL transaction commitment is the meeting-data commit decision. A Raft assignment decision and a SQL transaction are not one distributed transaction.

Use three distinct orders:

- Raft term/log order for coordinator decisions.
- A contiguous transactional sequence per meeting for application events.
- Lamport timestamps for application causality evidence. Increasing Lamport values do not establish causality by themselves.

Application-owned requests/responses carry protocol version, cluster/node/incarnation identity, request ID, and logical timestamp. Implement send/receive rules in participant agents, runtimes, peers, Go helpers, media controller, and lab-control messages. Instrument the Raft transport adapter without changing consensus semantics, including heartbeat and pipeline paths. Snapshot streams have stamped headers and completion events.

Stock PostgreSQL, Docker, browser internals, TLS, and WebRTC RTP/RTCP retain their native protocols. They are third-party infrastructure boundaries, not application envelopes we claim to instrument. Persist relevant application timestamps with commands/events and restore clocks from durable causal state as appropriate; identify restarted clock incarnations in logs.

Use these initial availability rules:

| Condition | Behavior |
| --- | --- |
| One meeting runtime fails, a replacement and dependencies are reachable | Recover ownership and reconnect participants. |
| Coordinator majority remains reachable | Coordination decisions can progress. |
| Coordinator quorum cannot be established | No new assignments, creation, or voter changes. Runtimes stop authoritative application commands when renewal/authority readiness becomes uncertain; previously committed history may remain visibly disconnected. |
| PostgreSQL unavailable | No new durable commands or fresh authoritative state; show database unavailability. Existing media can continue. |
| SFU unavailable | Chat and metadata remain usable if other dependencies work; media is unavailable until reconciliation. |
| Dashboard/supervisor unavailable | Existing nodes and protocol-driven takeover among running runtimes continue; new provisioning and lab controls wait for supervisor recovery. |

There is no instantaneous global detector of quorum loss. In-flight SQL operations may finish, and a cached readiness observation lasts only for its configured local renewal window. This is not per-message Raft certification. Generation fencing, rather than a timing assumption, prevents conflicting accepted owners at the database.

Durability covers committed PostgreSQL state while its persistent storage survives. One PostgreSQL instance and one SFU are deliberate availability limits. A single Docker host is also a shared failure domain; multiple containers demonstrate process failure, not independent-host resilience.

## 7. Ownership and recovery protocol

This is the main integration protocol to validate before media depends on it.

### State and effective authority

Raft allocates a monotonically increasing generation and one candidate runtime incarnation per recovery attempt. Persist the attempt ID, desired transition, and progress sufficient for a new coordinator leader to reconcile it. A replacement attempt uses a higher generation.

PostgreSQL has one owner-fence row per meeting: generation, runtime ID, incarnation, attempt ID, and phase INITIALIZING, RECOVERING, ACTIVE, or CLOSED. All meeting mutations and ownership changes serialize through that row. Ordinary reads use committed snapshots with the ownership and authorization checks described below. PostgreSQL is authoritative about which assigned runtime is currently enabled to access the meeting.

A Raft assignment is an instruction to transition ownership. Its application alone does not cancel an already-running SQL transaction. The PostgreSQL fence transaction defines the storage cutover. Advertisements and dashboards distinguish desired assignment from effective, ready ownership.

### Normal commands and takeover

1. The active runtime periodically renews its assignment through committed Raft commands. A local readiness gate stops accepting new authoritative work on uncertain renewal, expired readiness, or detected revocation. These observations reduce stale service; SQL fencing provides safety.
2. A coordinator recovery worker conditionally reserves generation g and candidate C through Raft. Only the designated attempt may request its storage transition. Authorize that request from committed coordination state, not a Chord hint or an uncommitted leader response.
3. The controller starts a PostgreSQL transaction, locks the meeting's fence row, and installs generation g, C's incarnation, attempt ID, and RECOVERING. Reject lower generations, a different candidate under the same generation, or any transition out of terminal CLOSED. Identical retries return their existing outcome.
4. The SQL commit of that fence seals the old owner's write prefix. An old write either committed before it acquired the row or waits and then observes a mismatched generation. No old write can commit after that storage fence while following the required transaction path.
5. C loads a consistent view of meeting state, events, outcomes, and pending reconciliation work from PostgreSQL. It needs no payload transfer from the failed runtime. Rebuild connections as transient state; give participants reconnect grace.
6. Record conditional activation intent through Raft for that exact generation/candidate/attempt. Enable ACTIVE in PostgreSQL only for the matching installed RECOVERING fence. A higher installed generation blocks a late enable.
7. Confirm readiness through Raft for the unchanged assignment; only then advertise C and accept commands. A superseded candidate cannot confirm readiness. It stops if an activation response is uncertain, resolves the attempt, and never treats a cached assignment as fresh permission.
8. Reconcile SFU ownership before enabling new media controls. Chat may become ready while media is explicitly unavailable.

All SQL command paths check the installed ACTIVE fence in the same transaction as their mutations. A late old activation cannot overwrite a higher installed SQL generation. A higher Raft reservation may exist before its SQL fence is installed; old-generation work during that interval belongs before the effective storage cutover. Do not claim that a Raft reservation instantly fences external storage or media.

If a candidate fails at any stage, the current coordinator leader's worker resolves recorded SQL/Raft progress and either completes that exact attempt or reserves a higher generation. Its timeouts and attempt revisions are conditional and idempotent. Do not depend on the admin dashboard to run recovery.

### Locking, reads, and renewal

Initially serialize commands that mutate state per meeting both in the runtime and through SELECT FOR UPDATE on the owner-fence row. Take that lock before reading domain state or checking outcomes for a mutation. Hold it through the SQL transaction so takeover and application writes have one order. Different meetings use different fence rows; there is no global meeting lock. The resulting serialization of one meeting's writes is an intentional starting point, with lock-wait time and transaction duration measured before considering finer-grained concurrency.

Ordinary participant reads, event replay, and dashboard inspection do not take an exclusive fence lock. Use PostgreSQL committed snapshots: one statement for a single-query observation, or a short read-only REPEATABLE READ transaction when several queries must observe the same database view. Participant-serving reads check the runtime's current readiness and validate ACTIVE owner/incarnation/generation, participant permissions, returned state, and cursor watermark within that consistent view. Reject a mismatched owner instead of serving a disconnected runtime's cached authoritative state. A read overlapping takeover may legitimately return the committed view from before cutover; each subsequent request opens a fresh view.

Dashboard observations can show committed state during INITIALIZING, RECOVERING, or dependency failure without implying the meeting is ready. Label the observation time and observed generation. An inspection result is not authorization to mutate state or control media; those actions use their fenced command and media protocols. Keep read transactions bounded, and never retain a snapshot or SQL transaction for the lifetime of a WebSocket subscription.

Set finite PostgreSQL transaction, statement, and idle-in-transaction timeouts and bounded lock waits. A suspended process must not retain a lock indefinitely. A lock timeout leaves recovery pending; it never permits bypassing the fence. Do not perform Raft RPCs, SFU calls, or other network side effects while holding the domain transaction open.

Leader-local monotonic timers drive failure suspicion. Expiration proposals include expected owner/generation and renewal revision; only a matching proposal applies. Give owners a fresh renewal grace period after coordinator leadership changes. Duplicate renewal IDs do not refresh liveness again. These are recovery triggers, not cross-machine wall-clock leases proving write safety.

### Creation, closure, and reconciliation

Reserve a name/ID and initial assignment in Raft, create the initial SQL meeting/fence idempotently, and use the activation handshake before admitting participants. Partial creation remains INITIALIZING. Canceled reservations remain visible tombstones; missing durable state for an established meeting yields UNAVAILABLE, never a fresh empty room.

Closing a meeting also allocates an agreed transition and fences SQL to terminal CLOSED before reporting closure complete. Then reconcile media shutdown and coordination status. Keep meeting data for inspection initially.

Controllers reconcile after their own crash or leader change by reading durable assignment/attempt state and the SQL fence. Repeating completed stages must be harmless. A returning old runtime gets a new incarnation, reads current assignment, and joins the available pool; it does not restore previous ownership automatically.

## 8. PostgreSQL meeting transactions

Use one shared PostgreSQL service and versioned schema migrations. Keep normal durability settings, including fsync and synchronous transaction commitment, enabled. Local acknowledged commit means PostgreSQL has completed its configured durable commit; it does not mean a second database host holds the data.

A command carries meeting ID, participant identity, stable command ID, generation-independent content digest, and the submitted operation. The runtime authenticates the participant before domain evaluation.

For each command:

1. Begin a bounded transaction and lock the meeting fence.
2. Verify ACTIVE phase, runtime ID/incarnation, generation, and the runtime's authority readiness.
3. Look up the outcome keyed by meeting, participant, and command ID. Return the original outcome for matching contents; reject reuse with different contents. A new owner resolves the same key after takeover.
4. Evaluate against state read inside the transaction. Generate nondeterministic IDs/timestamps once for a successful attempt.
5. Apply state changes, allocate the next per-meeting sequence transactionally, append the event, save the stable outcome, and record necessary media/reconciliation intentions atomically.
6. Commit. Only then report success and publish the event.

Use a counter protected by the meeting transaction rather than a nontransactional sequence if the event cursor promises contiguous committed numbers. Persist domain rejections when they require a stable retry outcome. Validation/authentication failures need not become domain events.

A lost connection during commit leaves an unknown outcome. Retry the same command ID through a ready owner; a unique outcome key prevents duplicate effects. A success reply may arrive late for a command that committed before takeover. That is safe and must not be described as a stale owner committing a new write.

Durable event rows are the delivery source. In-memory fanout or PostgreSQL notifications can wake readers, but are not a durable message queue. If commit succeeds and publication fails, replay must still deliver the event.

No per-message Raft call, commit certificate, replica acknowledgment ledger, hash chain, or meeting-server database snapshot transfer is required. PostgreSQL owns transactional storage and crash recovery; application code owns the invariants above.

## 9. Screen sharing and media authorization

The shared resource is screenshare:<meeting-id>. Cameras and microphones are independently publishable. A stable participant/request identity owns a screen-share grant.

Persist a FIFO queue ordered by committed meeting events. Cancel, leave, stop, and grant-next are deterministic engine operations. In one fenced SQL transaction, handoff removes the waiter, assigns the holder, increments the grant version, records the event/outcome, and creates a media reconciliation intention. This is the Milestone 5 application transaction.

PostgreSQL is authoritative for the grant and queue. Do not maintain a second independently authoritative grant summary in Raft. Coordination peers still demonstrate leader election and replicated ownership metadata; the active meeting service centrally coordinates the distributed screen-share mutex.

The media adapter serializes control per room and enforces at most one active screen producer. It closes the previous producer before enabling its replacement, and treats generation plus grant version as fencing data. Bind a generation to its assigned runtime incarnation.

Before executing new publish/control work, the adapter checks current ACTIVE ownership, participant authorization, and grant/version from PostgreSQL. A historical assignment or grant token alone is insufficient. If that current check is unavailable, reject new control work; already established media may continue. On restart, each room is unready until current storage authority and grant state have been read and reconciled.

Fresh checks and media effects are not one distributed transaction. A previously validated operation can be in flight during a SQL transition. Effective media cutover occurs when the room's serialized fence/reconciliation completes; after that point, reject all older-generation control. A successor stream is not ready until the old producer is closed and the current grant has been checked. Do not promise instantaneous physical revocation at SQL commit time.

Coalesce obsolete media intentions by re-reading current desired state rather than replaying old grants blindly. Retry current intentions idempotently; record effect outcomes separately from the domain decision. A committed grant can remain starting/unavailable, and the UI must show that distinction.

Explicit leave releases immediately as a committed operation. Disconnect starts a configurable grace period. Expiry commands bind the participant's connection/attachment revision and current grant identity; a stale timer cannot remove a reconnected participant or a later grant. Runtime takeover starts fresh transport grace without duplicating durable membership.

Browser Stop sharing, track-ended events, capture cancellation, and permission failures feed normal idempotent release/reconciliation paths. A logical grant cannot remain silently shown as a working stream after capture ends.

## 10. Clients, replay, and basic meeting experience

Retain one local participant agent with a shared ClientSession for GUI and CLI. Reloading its browser attaches to the same session. One browser attachment owns capture at a time; attachment revisions also protect against stale disconnect notifications.

The local HTTP/WebSocket interface uses an unguessable attachment token and origin checks. Participants have durable resume credentials stored locally and verifiers in PostgreSQL. Generate and persist join identity/credentials and command IDs before first transmission so lost join replies and agent restarts remain resolvable. Display names do not authenticate identity.

Use versioned WebSocket JSON control/signaling to meeting runtimes. Catch command errors; show connecting, connected, reconnecting, authority unavailable, and left. On uncertainty, preserve pending command IDs and their contents. Discover a ready replacement through known peers, resume the same participant identity, and replay committed events.

Replay and live delivery are one continuous cursor protocol. Read the durable event log after the last confirmed cursor; a live wakeup only prompts another read. Advance through an explicit scanned watermark even when topic filtering returns no visible events. Scope cursors to meeting and subscription revision, preserve subscription state, and define replay eligibility in committed order so changing a filter cannot silently skip newly eligible history.

Bootstrap state and its event watermark come from the same consistent database view. Discard duplicate events by sequence. No event may fall into a gap between snapshot/replay and live delivery. A slow client has bounded buffers; disconnect with a resumable cursor instead of unbounded memory growth.

The initial participant experience includes meeting code/name entry, roster, pre-join camera/microphone preview, mute/unmute, camera off/on, concurrent audio/video, chat/topics, screen-share request/queue/stop, leave, and connection/media status. Handle denied permission, missing or busy devices, and blocked playback with actionable UI.

Demo clients can join and generate scripted chat/control traffic automatically. They are labeled automated participants. Real browser capture/playback and screen selection still require user/browser interaction; presets do not bypass permissions. Verify actual media with at least two real browser participants, preferably on group-member devices.

## 11. SFU and network deployment

Use an existing SFU through a separate media service; mediasoup is the current proposal. Validate a minimal two-browser audio/video call, screen share, advertised addresses, and restart/reconnect on the user's Windows/Docker environment early.

Keep application records and media separate. Persist permissions/intentions when needed; SDP, ICE credentials, transports, and producer bindings are transient. Media travels directly between browser and SFU, optionally through TURN, not through PostgreSQL or the coordinator overlay.

One SFU is an explicit initial limit. Its failure interrupts media but must not erase chat or meeting state. Recreate rooms and transports after restart under current fences. Seamless node-to-node media migration is deferred. Measure interruption durations rather than promise them.

Provide a dependable single-computer preset and configurable network addresses/ports for multiple computers. Group devices may run prepared local participant agents, preserving loopback browser serving and shared GUI/CLI behavior. Audience devices do not need to join or install software.

Same school Wi-Fi does not establish mutual reachability. Preflight control connections and actual bidirectional media on the intended network. Keep the single-computer preset as presentation fallback. Do not assume Docker-private addresses are reachable from browsers; explicitly configure host-advertised SFU addresses and published bounded media ports.

Loopback browser pages can use their secure-context exception. If a browser page is served from another computer, configure trusted HTTPS and compatible signaling instead of relying on insecure-browser flags. Public-internet hosting and a production TURN deployment are deferred; local testing must establish whether the selected network needs a relay.

The initial supervisor manages one local Docker host and local client agents. Service protocols remain network-capable; manually configured remote services can register and participate. Deploying authenticated supervisors on arbitrary remote machines is a later extension.

## 12. Docker, process lifecycle, and operations

Docker Compose manages PostgreSQL with a pinned compatible version, persistent named volume, health check, and example local environment. Do not use disposable storage for retained meetings. Application connections retry readiness and recover broken pools. Document Docker Desktop as a one-time Windows prerequisite.

Proposed lab packaging also containerizes coordination processes/helpers, meeting runtimes, the SFU, and TCP proxies. Keep each helper separately observable and independently faultable. The host supervisor uses a narrow Docker/process-control adapter; it can provision stable identities and restart their existing volumes. Pin compatible images and dependencies after feasibility checks rather than using floating latest tags.

All managed resources carry a lab ID and stable node identity. Persist the supervisor's desired inventory, scenario history, and resource associations outside managed processes. On supervisor restart, inspect actual resources and reconcile; never duplicate them merely because its in-memory registry was lost.

Failure detection and takeover among existing runtimes live in coordinator/application services. The supervisor only supplies process capacity when asked. If no runtime is available and the supervisor is down, report UNAVAILABLE until capacity returns. Closing the dashboard browser must not terminate services.

Ordinary unexpected process failures can use a visible bounded restart policy. An injected crash is held down until explicit restart/heal or a scenario recovery step; automatic restart must not erase the intended experiment. Runtime replacement uses available pool capacity first. Restart a crashed coordinator with its original durable Raft identity unless it has been removed.

A coordinator-node crash or suspension targets both its TypeScript peer and Go helper by default. Component-only actions remain available and identify their narrower scope explicitly. Quorum observations count reachable voting helpers, not merely visible peer processes; a helper-only or peer-only fault must not be mislabeled as the loss of the whole pair.

Graceful drain stops new placements, transfers owned meetings through the fence protocol, and completes voter removal where requested before stopping. Crash skips those steps. Suspend/resume retains process memory and durable identity; it is a real fault, so normal timeouts continue.

Shutdown lab first cancels pending scenario work, heals lab-owned faults, resumes suspended resources as needed for orderly stop, and stops only owned processes/containers. Preserve PostgreSQL and coordinator volumes. Reset lab is a distinct, explicitly destructive operation affecting this lab's data and identities; never use global Docker cleanup.

## 13. Administration dashboard and fault scenarios

The dashboard is an operations interface, separate from participant views. Prioritize a readable topology/inventory, current coordinator leader and voting configuration, active meeting ownership, readiness, database/SFU status, and a correlated event timeline. Show pending transitions and dependency failures rather than inventing a single healthy/unhealthy label.

Provide start lab, add coordinator, add meeting runtime, create meeting, join demo clients, drain/leave, stop, crash, restart, suspend/resume, inspect logs, heal faults, and shutdown lab. Starting a process does not itself complete Raft admission or meeting activation; display their actual progress and failure outcomes.

Keep the control service authenticated and loopback-bound initially. Only explicitly managed node IDs and links are action targets. Do not expose Docker control or arbitrary shell execution through the browser. CLI and dashboard call the same supervisor operations.

### Database inspection

Provide browsable PostgreSQL views for meeting state, events, outcomes, and installed ownership. A read-only SQL query panel can use the same backend inspection path. Use a dedicated nonsuperuser account with SELECT access only to approved views that exclude resume verifiers, secrets, and credentials. Enforce read-only transactions and database privileges; checking whether a query starts with SELECT is not a permission boundary. Keep database credentials in the backend.

Use ordinary snapshot reads without FOR UPDATE. Give inspection a small separate connection pool, statement/transaction timeouts, and bounded returned rows/bytes. Queries still consume CPU, I/O, and snapshot resources, so slow inspection must not exhaust the meeting-command pool. Show observed time/generation and distinguish query errors or database unavailability from empty results. PostgreSQL inspection remains useful while a meeting runtime is recovering, provided the database itself is reachable.

### Staging and application

Draft a scenario while the lab continues running. Adding/editing a draft has no side effects. On Apply:

1. Validate action syntax, dependencies, target availability, and destructive scope.
2. Resolve role/random selectors to actual IDs and incarnations; record those choices and any optional seed.
3. Revalidate topology-sensitive preconditions. A changed primary or voter set requires an explicit refreshed preview instead of silently targeting an unrelated node.
4. Dispatch independent actions together with bounded concurrency. Honor explicit ordering, delays, or observed-condition steps.
5. Record requested, dispatched, effective, failed, skipped, and healed actions with actual times and observations.

Batches are not atomic transactions. Some actions can succeed while others fail. Report partial execution accurately and provide heal/recovery actions; do not claim rollback of a crash. Preserve outcomes across supervisor restart. Resolve uncertain actions by inspecting target state before retrying; do not repeat a completed crash or restart blindly.

No exact simultaneous delivery, deterministic replay, global simulation clock, or pause-adjusted leases are required. A seed reproduces target selection, not thread scheduling or network timing. Node suspension remains available as a deliberate failure action.

### Fault scope

Use controlled TCP proxies for selected Chord, Raft, client/gateway, runtime/coordinator, and runtime/database paths. Verify all intended connections, including reconnects and Raft fast paths, use the injected route. Define a partition as an explicit set of directed links; sever both directions where a bidirectional partition is intended.

Toxiproxy can provide connection cuts, latency/jitter, bandwidth limits, and selected stream faults. It does not simulate arbitrary UDP media impairment. Initial media tests cover SFU crash/restart and reachable-address failures; detailed RTP packet-loss simulation is deferred.

Separate fault-control traffic from tested links so Heal remains reachable. Proxy-process failure is a distinct infrastructure failure and must not masquerade as a single selected-link fault.

## 14. Presets and expected evidence

The Demo lab preset creates or resumes a lab with five coordinator voters, three meeting runtimes, one PostgreSQL service, one SFU, one meeting, and three distinct joined client agents. Provision missing runtime capacity before creating the meeting; verify readiness rather than use startup sleeps. Do not allocate three new dedicated runtime processes for every additional meeting.

Repeated provisioning with the same operation ID is idempotent. Preserve explicit new-lab versus resume-lab choices and resource ownership. Automated participants join without automatically claiming microphone/camera capture.

| Scenario | Actions | Expected outcome |
| --- | --- | --- |
| Random coordinator crash | Resolve and hold down one coordinator | A working majority continues. Elect a replacement if the target was leader. |
| Meeting-server takeover | Crash the current active runtime | An available runtime takes over; clients resume with retained state and outcomes. |
| Two meeting servers lost | Crash two of the three runtimes, with the selection recorded | The remaining runtime can host the meeting if PostgreSQL, SFU as needed, and coordinator quorum are reachable. |
| Old owner returns | Suspend/isolate the active runtime, observe takeover, then resume/heal it | The old incarnation/generation cannot commit after the SQL cutover or control media after its media fence. |
| Quorum boundary | Crash two of five configured voters | Three mutually reachable voters retain quorum. Explain the denominator in the UI. |
| Quorum lost and restored | Remove reachability of three of five without changing configuration, then heal | No minority authorizes coordination changes. Readiness becomes unavailable and recovers without rebootstrap. |
| Database outage | Stop and restart PostgreSQL with its volume | Durable operations pause, uncertain outcomes resolve by ID, and retained data returns. This is restart recovery, not database failover. |
| SFU restart | Crash and restart media service | Chat remains usable; media status is accurate and browsers rebuild transports. |

For a maximum safe coordinator-failures selector, derive floor((configured voters - 1) / 2) from the actual voting configuration and verify remaining connectivity. Do not count meeting runtimes, database containers, or SFU workers as coordinator voters. Do not promise continued service merely from the number of running processes.

Scenarios support planned waits for an observed condition with a timeout, such as ownership changing, rather than relying exclusively on fixed sleeps. Exportable scenario definitions and result timelines are useful lab artifacts; a general workflow language is out of scope.

## 15. Durability and availability boundaries

| Component | Initial limitation | Recovery |
| --- | --- | --- |
| Coordinator quorum | Minority cannot authorize changes | Restore enough configured voters/connectivity or perform a supported agreed membership change while quorum exists. |
| PostgreSQL | One instance and storage failure domain | Restart using its persistent volume. Automatic promotion and storage replication are deferred. |
| Media service/SFU | One media node | Restart and reconcile rooms/transports; interruption is expected. |
| Lab supervisor | One management endpoint | Reattach to existing managed resources; meetings continue independently where their dependencies remain. |
| Participant agent | One session endpoint per participant | Restart using durable credentials, pending IDs, and cursor. |
| Local Docker host | Shared infrastructure for local preset | Restart services from surviving volumes; do not claim independent-host resilience. |

Retain chat, event history, outcomes, and subscriptions for the meeting lifetime initially. Bound message sizes, queues, connection buffers, and concurrent work. Long-term garbage collection and retention policy changes require replay/idempotency rules.

Raft log compaction snapshots coordinator metadata, and replacement coordinators synchronize through the library. This is the initial replication/snapshot learning evidence. Do not describe a single PostgreSQL instance as a replicated chat store.

Document a PostgreSQL backup/export procedure and record the restore point; automated backup scheduling and coordinated whole-system restore tooling are deferred. Replicas and persistent volumes are not independent disaster backups.

An older database restore can omit acknowledged messages and ownership generations. It must not be attached silently to the live cluster. Restore into an isolated lab with a new cluster identity and declare the restore point/data loss, or use a future explicitly designed recovery procedure. Likewise, do not restore stale coordinator data alongside live higher-generation services. Reset/restore never lets an empty database masquerade as an existing meeting.

## 16. Assignment mapping and acceptance

This mapping uses docs/assignment-reqs.txt, not a stronger invented requirement that every dataset be replicated by student-written code.

| Milestone | Application evidence |
| --- | --- |
| 1: Architecture and models | Independent clients, coordinator/helper pairs, meeting runtimes, database, media service, and lab supervisor; component request/reply and correlated logs. |
| 2: Communication | Socket/WebSocket/RPC calls; serialized versioned envelopes; topic pub/sub with multiple subscribers; meeting-wide group messages across independent client processes; wall and logical message logs. |
| 3: P2P integration | At least four Chord peers; fingers and successor repair; meaningful lookup of meetings/services; joining/leaving; operation across even/odd sizes. |
| 4: Coordination | Lamport clocks in application nodes; observable Raft election; per-meeting event order; a centrally coordinated distributed screen-share mutex enforced at the SFU. |
| 5: Replication, transactions, fault tolerance | Important coordinator metadata replicated by durable Raft; stated consistency policies; atomic SQL screen-share handoff; fault detection, leader/runtime recovery, stable retries, and retained meeting state. |

The supplied file does not require public-internet deployment, database-node failover, per-meeting Raft groups, a custom Raft implementation, or cross-database/media ACID transactions. Library acceptance is a grading assumption, not an instructor guarantee. If different grading guidance appears, revisit the mapping before implementation.

Required checks:

1. GUI and CLI share each participant's session; browser reload does not join twice.
2. Actual browsers exchange audio/video, mute/camera state, and one screen share; denied/canceled capture and browser stop-sharing are handled.
3. Pub/sub and meeting-wide group communication are visibly distinct and reach multiple independent subscribers/nodes.
4. Chord lookup exercises finger shortcuts and fallback under failure, including transient stale hints.
5. Even/odd voter configurations, join/sync/promotion, graceful removal, dead-member removal, and stable-ID restart use library quorum rules. Include four- and five-voter demonstrations; exact larger-size matrix is a planning detail.
6. Crash a coordinator leader; show surviving metadata, a replacement leader, and no minority rebootstrap. Force coordinator snapshots and catch-up.
7. Inject failures around SQL commit/reply/publication. Confirmed data survives runtime restart and retries return one stable outcome.
8. Race an old SQL command against the fence transaction. Its result must belong wholly before cutover or be rejected afterward. Repeat with an old process suspended while holding a transaction.
9. Crash the recovery controller/candidate after each Raft/SQL activation stage and resume reconciliation. Test a late superseded candidate.
10. Reconnect while an older disconnect timer is pending. It must not eject the resumed participant or release a later grant.
11. Commit events exactly during snapshot/replay/live handoff and topic changes. Verify no lost eligible events and bounded slow-client behavior.
12. Isolate old runtime plus SFU from new owner/coordinators while exercising database authorization paths. No historical assignment or authorization cache alone can admit new media work. Verify single producer and fence behavior after reconnect/restart.
13. Crash two of three runtime processes; restore on the survivor with PostgreSQL and quorum available. No runtime-to-runtime data replication is assumed.
14. Stop/restart PostgreSQL and SFU independently; distinguish their effects and verify persistent-volume recovery.
15. Stage a batch with no early effects, validate changing targets, apply partial failures, and inspect the recorded action/result timeline. Heal after supervisor restart.
16. Close/reopen the dashboard and restart the supervisor without terminating or duplicating running nodes. Shutdown preserves volumes and only affects this lab.
17. Run the reliable single-computer preset. Preflight the actual school-network control/media paths before claiming a multi-device demo.
18. Measure durable command latency, per-meeting lock waits, transaction duration, takeover/reconnect time, and media interruption. Report process versus host failure coverage accurately.
19. Inspect PostgreSQL during writes and takeover without taking an exclusive meeting-fence lock. Verify bounded queries/results, restricted views, no write privileges, accurate snapshots/watermarks, and isolation from the meeting-command connection pool.

## 17. Delivery boundaries and remaining work

This is a project delivered in reviewable batches. The detailed plan follows approval of this revised design.

1. Validate Raft helper persistence/transport instrumentation, PostgreSQL/Docker connectivity, SFU media, and backend container packaging with small feasibility checks.
2. Extract protocol/client/engine/store boundaries and unify GUI/CLI sessions. Keep old demos available temporarily.
3. Implement Chord and coordinator membership plus the PostgreSQL ownership/transaction protocol. Prove headless recovery before media controls depend on it.
4. Implement the supervisor lifecycle API and headless scenario runner, then a useful dashboard on those same operations. Build Demo lab and meeting-server takeover first.
5. Integrate full browser media, screen-share policy, freshness/fencing, and remaining scenario presets.
6. Update README/guides and remove superseded paths after replacement evidence is reviewable.

The builder can choose exact source layout, SQL schema names, timeout values, backoff, HTTP/RPC encoding, proxy allocation, dependency patch versions, and UI styling. Keep configurable values measured and logged. Basic transaction/ownership invariants and accepted behavior are not discretionary performance shortcuts.

Concrete open implementation risks are the Node/Go Raft transport boundary, crash-safe coordination-to-SQL reconciliation, paused-transaction timeouts, Docker/SFU media addressing, source-specific fault routes, and browser capture/reconnect behavior. These are feasibility/validation tasks, not reasons to ask the user to invent a protocol.

Keep an attractive, readable dashboard, but design its visual layout when implementing that surface. No screenshots, UI build, dependency installation, or product tests are claimed by this document.

## 18. Primary references

- [Assignment requirements](../../assignment-reqs.txt).
- [HashiCorp Raft API](https://pkg.go.dev/github.com/hashicorp/raft): membership, persistence, snapshot, and transport interfaces.
- [Raft durable store adapter](https://github.com/hashicorp/raft-boltdb).
- [Raft paper](https://raft.github.io/raft.pdf): consensus, stable state, elections, and membership background.
- [Chord paper](https://www.cs.princeton.edu/courses/archive/fall25/cos418/papers/chord.pdf): lookup and routing background.
- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html), [row locks](https://www.postgresql.org/docs/current/explicit-locking.html), [snapshot isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [read-only transactions](https://www.postgresql.org/docs/current/sql-set-transaction.html), and [timeouts](https://www.postgresql.org/docs/current/runtime-config-client.html).
- [PostgreSQL notifications](https://www.postgresql.org/docs/current/sql-notify.html): wakeup mechanism distinct from retained application events.
- [PostgreSQL replication](https://www.postgresql.org/docs/current/warm-standby.html) and [failover](https://www.postgresql.org/docs/current/warm-standby-failover.html): future storage availability work, not enabled by installing one instance.
- [mediasoup signaling](https://mediasoup.org/documentation/v3/communication-between-client-and-server/) and [installation](https://mediasoup.org/documentation/v3/mediasoup/installation/).
- [Docker pause](https://docs.docker.com/reference/cli/docker/container/pause/) and [Compose shutdown](https://docs.docker.com/reference/cli/docker/compose/down/).
- [Toxiproxy](https://github.com/Shopify/toxiproxy): TCP fault injection.
- [Media capture](https://www.w3.org/TR/mediacapture-streams/) and [screen capture](https://www.w3.org/TR/screen-capture/): browser permission and capture boundaries.
- [Wireless client isolation](https://documentation.meraki.com/Wireless/Operate_and_Maintain/How_Tos/Firewall_and_Traffic_Shaping/Wireless_Client_Isolation): same-SSID reachability is not guaranteed.

Component documentation supports component behavior. The ownership handshake, SQL fencing discipline, client replay rules, and scenario protocol are application design proposals requiring failure-oriented verification.
