# Durable participant sessions and production replay

This checkpoint adds `client/` and the runtime's `/v1/participant` WebSocket gateway. A production participant agent automatically joins, sends domain commands, reconnects to a READY replacement, resolves uncertain outcomes by the original command ID, and replays PostgreSQL events into its local durable inbox. [Current design](superpowers/specs/2026-11-21-distributed-meeting-redesign.md) and [implementation plan](superpowers/plans/2026-11-25-client-session.md).

## Durable local state

`SessionJournal.open(path, {clusterId, meetingId, name})` creates a version-1 SQLite journal. Its initial transaction stores a participant UUID, a random 256-bit resume secret, the initial join UUID and complete command contents. Later submissions synchronously commit their ID, operation and Lamport timestamp before returning an ID. Pending commands are immutable JSON records; a lost reply leaves the record pending. ClientSession retries that exact record after restart. Domain rejections are stable outcomes and remain visible to the caller.

SQLite uses FULL synchronization and a rollback journal. A completion commit stores the outcome; a replay commit stores events, the snapshot observation and the scanned cursor together. SQL commit and local completion are separate transactions. Losing the latter causes an idempotent SQL retry, not another chat event. No endpoint, readiness decision or owner authority is durable client state.

The cursor is scoped by the journal's cluster/meeting binding and `{meetingId, subscriptionRevision: 0, seq}`. Revision zero is unfiltered. Runtime DTO validation, contiguous sequences and nonregressing watermarks are checked before cursor advancement. Topic/subscription revisions require a future committed-order eligibility protocol; changing a filter cannot reuse this cursor.

The local inbox makes received events available while a GUI or CLI is detached. `session.view(after, limit)` returns up to 200 retained events and recent command outcomes without credentials. The network cursor confirms persistence in this inbox; local consumers use their own display position. Snapshot `watermark` and scanned cursor remain separate: a current roster snapshot can accompany an earlier page of history. Repeated attachment must read this session rather than open a second journal.

New pending work is capped at 128 commands. A queued leave forms a submission boundary; after its confirmed outcome the session stays left across restart. A dropped socket does not imply leave. This checkpoint has no disconnect eviction timer.

Local files contain plaintext credentials. New files use mode 0600 and newly created directories mode 0700 on systems enforcing those modes; Windows uses inherited directory ACLs. Keep each session path in a private account directory. Process-crash recovery is tested. Disk loss, whole-machine durability and encryption at rest are not established by these tests.

## Runtime configuration

Add an optional participant listener to protected `ZOOM_RUNTIME_CONFIG` JSON:

```json
{
  "participants": {
    "address": "127.0.0.1:7101",
    "token": "a-separately-generated-local-agent-token-at-least-32-bytes-long",
    "timeoutMs": 4000
  }
}
```

Other runtime fields retain the configuration described in [remote runtimes](remote-runtimes.md). Startup reports `participantAddress`; the provisioner also knows the runtime ID/incarnation and token. Both listeners close on shutdown, registration revocation and failed startup.

The gateway uses the runtime's shared stamped version-2 ControlWire envelope, with participant body version 1 and WebSocket subprotocol `zoom.participant.v1`. Upgrade requires a provisioned bearer token and rejects browser Origin headers. Every domain command also authenticates its participant resume secret through MeetingStore. The gateway binds the exact cluster, meeting, generation, runtime, incarnation and attempt, checks RuntimeAuthority, then delegates to the existing fresh SQL transaction/fence. A READY metadata route is an observation, never authorization to bypass SQL.

Ingress permits at most 128 sockets and 32 active operations by default, one operation per socket, with a 64 KiB frame bound and 1 MiB reply/output bound. Deadlines cover partial HTTP headers, idle upgraded sockets and active requests. Timed-out SQL work retains admission until it settles; socket closure cannot cancel an already committed transaction. The existing blackholed database connection/shutdown limitation remains.

The gateway caps reads at 16 events even if the requested limit is higher. This accommodates sixfold JSON escaping of valid 8192-byte chat bodies plus the live roster and screen-share queue. Participant snapshots project joined members only; departed identities, names, credentials and complete events remain in PostgreSQL for recovery and authentication. Storage/inspection APIs retain their existing semantics.

## Participant executable and shared API

Run `npm run start:participant` with protected `ZOOM_PARTICIPANT_CONFIG` JSON shaped as follows (replace the illustrative UUIDs, addresses and secrets with actual provisioned values):

```json
{
  "sessionPath": ".local/participants/alice/session.sqlite",
  "target": {
    "clusterId": "11111111-1111-4111-8111-111111111111",
    "meetingId": "22222222-2222-4222-8222-222222222222",
    "name": "Alice"
  },
  "helpers": [{
    "helperId": "33333333-3333-4333-8333-333333333333",
    "address": "127.0.0.1:7001"
  }],
  "helperToken": "the-provisioned-helper-token-at-least-32-bytes-long",
  "routes": [{
    "runtimeId": "44444444-4444-4444-8444-444444444444",
    "incarnation": "55555555-5555-4555-8555-555555555555",
    "address": "127.0.0.1:7101",
    "token": "the-provisioned-participant-token-at-least-32-bytes-long"
  }]
}
```

`discovery: {bootstraps, token, timeoutMs?}` can replace helper routes, with `helpers: []`, using the existing Chord/DiscoveredHelpers boundary. Helper and participant traffic share one process wire. Participant endpoints remain provisioned, and READY helper metadata selects a matching runtime incarnation. Supply all replacement routes. A restarted runtime has a new incarnation; refresh participant configuration and restart the agent with its existing session path to learn that route. Automatic runtime placement/endpoint announcements remain unfinished. No participant process needs PostgreSQL credentials.

The JSON-lines stdin adapter is the headless CLI. The initial join happens automatically. Example inputs:

```json
{"id":"chat-1","action":"submit","operation":{"type":"chat","content":"Hello"}}
{"id":"view-1","action":"view","after":0,"limit":100}
{"id":"leave-1","action":"submit","operation":{"type":"leave"}}
```

Submit returns a durable `commandId`, not a commit acknowledgement. View reports outcomes, cached observation/events and `connecting`, `connected`, `reconnecting`, `authority unavailable` or `left`. Runtime disconnects and dependency refusal leave pending identities intact. Input frames and stdout buffering are bounded. EOF or termination stops the agent without sending leave.

`startParticipant(config)` exposes exactly one `session` with `submit`, `view`, serialized `step` and abortable `run`. Its `openBrowser()` serves the same object and shares the process ControlWire clock with helper/runtime traffic. The runtime gateway remains for trusted local agents. Current configuration selects the meeting UUID; meeting-code entry/discovery UX remains future work.

## Secured loopback browser attachment

Add `"browser": {"address": "127.0.0.1:0"}` to the participant configuration to enable the browser listener in the executable. Port zero selects an available port; a fixed literal loopback address/port is also supported, including IPv6 `::1`. The `participant.started` JSON output includes `browser.url`. Open that private URL in the browser. Stdout now contains an attachment capability, so keep its output private. Programmatic callers can call `agent.openBrowser()` once; concurrent calls share one listener. `agent.close()` owns its shutdown, including a listener still starting.

The participant page uses `client/browser-attachment.js` through a display-only model. Its conversation workspace includes a roster, paged meeting history, chat composer, shared pending/outcome details, connection states, share request/queue/release, explicit leave and local capture ownership. It exposes `globalThis.attachment` for integration:

```js
await attachment.view(0, 16); // {view, capture}; local display position, not network ack
await attachment.submit({type: "chat", content: "Hello"}); // durable commandId
await attachment.claimCapture(); // CAS against latest observed capture revision
await attachment.releaseCapture();
attachment.ownsCapture;
attachment.addEventListener("capturechange", () => { /* reconcile capture */ });
```

History pages contain at most 16 events of every supported kind, ordered by sequence. Older/Newer browse fixed pages; Latest follows the tail. Tab-scoped display positions survive reload and are keyed by cluster, meeting, participant and subscription revision zero. They do not acknowledge or change the agent's durable inbox cursor. Only the visible page is held in the UI model. Roster/share state comes from the latest retained snapshot, independently of the history page. The footer shows the snapshot's observation time/watermark and local inbox position; retained state is marked potentially stale when the agent or backend is disconnected.

Local agent attachment and backend connection status are shown separately. Chat can queue while backend authority is unavailable, but a locally closed attachment requires reload. Each submission is single-flight. Its uncertainty guard is saved before sending; if acceptance is interrupted or the tab reloads during it, the UI disables further submissions until the participant reviews the shared command IDs, immutable contents and outcomes and deliberately acknowledges that review. Acknowledging does not submit or retry anything. Only ClientSession retries the original durable command. Browser tab storage contains display positions and this guard, not a second participant identity; if browser storage is unavailable these display aids are memory-only.

Accepted submissions wait for a fresh post-acceptance view before enabling further actions; an older in-flight read cannot reopen controls against pre-command state. A failed view pauses actions until the shared commands can be inspected. Command rows keep their DOM identity, open details and keyboard focus while CLI traffic or outcomes arrive.

Share controls display the retained holder and FIFO queue. Cancel/release uses the exact observed request ID, and pending share commands suppress duplicate clicks. Capture claim explicitly replaces the current local owner with compare-and-set against its observed revision; capture release is owner-only. Neither operation starts media. Leave uses an inline confirmation and submits one durable command for the shared CLI/browser participant. Pending leave disables further domain actions, and a successful outcome shows left. Closing/reloading a tab only detaches it. Participant names and message/command contents are rendered as text; long content wraps on mobile. Historical messages from departed participants may use a short participant ID because live snapshots omit departed names; a bounded historical-name source is deferred.

The listener generates a random 256-bit capability each time it starts. The token travels in the initial URL fragment and first WebSocket authentication frame, never an HTTP query, asset or session view. The page removes the fragment from the visible URL and retains the capability in tab-scoped sessionStorage for reload. A restarted agent rotates the token; use its new URL. Participant resume secrets, helper/runtime tokens and database credentials are never sent to the page. Anyone with the private attachment URL can control this participant session locally.

HTTP requests require the exact configured Host and reject a supplied nonmatching Origin. `/v1/attachment` upgrades require the exact same-origin Origin and `zoom.attachment.v1` subprotocol; absent, `null`, foreign and rebinding origins are refused. Only fixed HTML/CSS/module assets are served. Responses disable caching/referrers/framing and restrict scripts, styles and connections to the same origin through CSP. No CORS permission is granted. Capability authentication precedes session access. This boundary targets a local browser and does not claim public-network deployment.

Each authenticated socket gets a random attachment ID and a monotonically increasing listener-local attachment revision. Subsequent version-1 request bodies bind both fields and pin the browser's stamped wire identity; stale attachment requests and replayed wire timestamps cannot submit. The version-2 ControlWire envelope carries cluster/node/incarnation, request UUID and Lamport time. A browser has only this agent peer and at most 32 outstanding calls; jumps more than 1024 ahead of the agent's clock are rejected before clock observation. Reply/event failure closes affected attachments. Revisions are scoped to the listener incarnation; they are separate from subscription revision zero and durable participant identity.

Capture is an explicit local lease: `{revision, owner: {id, revision} | null}`. Attaching/reloading does not claim capture. A claim or release must provide the current `captureRevision`; a successful replacement immediately publishes a capture-change event to all attached sockets. Only the current owner may release, and a delayed disconnect releases only its exact attachment. A stale release/claim cannot revoke a successor. These local permissions are separate from SQL screen-share grants and runtime ownership. The opt-in [capture/SFU feasibility adapter](media-feasibility.md) stops tracks on revocation/close and checks all three boundaries before publication. Full participant media integration remains unfinished.

Reload reads the same ClientSession. It never opens a journal or generates a new join. Submit synchronously persists before the command ID reply; if that reply is lost, reload and inspect the shared command list. The browser adapter deliberately does not retry an uncertain submission. Only ClientSession retries the original durable command against the runtime. Browser display cursors do not advance the network inbox cursor. This checkpoint keeps subscription revision zero unfiltered.

Ingress is bounded to eight sockets by default (configurable 1–32), 64 KiB frames, authentication/idle deadlines of 30 seconds by default (configurable 1–60000 ms), and 8 MiB reply/output buffering per socket. Partial HTTP headers have an absolute deadline; rejected upgrades are destroyed after their response flushes, and shutdown destroys all raw sockets as well as admitted WebSockets. Browser views cap history pages at 16 events while retaining all 128 recent command records, including worst-case escaped chat contents. The runtime gateway's 1 MiB bound is unchanged. The browser caps outstanding calls at 32 and times them out. Slow/expired clients disconnect and can resume from the local inbox. No browser disconnect sends a domain leave or evicts durable membership.

## Checked evidence and remaining limits

The original [session evidence](../evidence/client_session_run/result.json) and [browser attachment evidence](../evidence/browser_attachment_run/result.json) are retained. Current UI checks are recorded in [participant UI evidence](../evidence/participant_ui_run/result.json): default tests, typecheck, native Chromium and the existing real Docker runtime suite. Set `ZOOM_BROWSER_EXECUTABLE` for a Chromium executable outside the default Windows Chrome/Edge locations. Optional `ZOOM_UI_EVIDENCE` names a directory for desktop/mobile screenshots and horizontal-overflow assertions. The native test uses a disposable profile and requires browser subprocess/loopback permissions; it never bypasses capture permissions or opens real media devices.

The participant scenario starts production scripts, three real Raft helpers, three independent runtimes with restricted PostgreSQL pools, and two independent participant agents. A test-only WebSocket relay drops a committed join reply and a committed chat reply, then blocks retries until the agent is killed. Restart reuses its credentials/IDs. Two runtime crashes move ownership to the survivor; offline chat is replayed exactly once into the local inbox, the old owner is fenced, a restarted runtime's old incarnation is rejected, quorum loss retains uncertainty, and quorum restoration completes the pending ID. Attachment sockets now submit through that same path, reconnect to the shared session, see the original uncertain command and compare recovered events/outcomes against the CLI. Separately, real headless Chrome reloads a page against an offline production agent with a seeded durable inbox, verifies both adapters' pending IDs and identity, replaces capture ownership between tabs, and observes clean agent shutdown. The pre-existing suite separately covers PostgreSQL restart, paused lock holders, helper leader replacement and discovery failure. This is bounded process-failure evidence on one host.

Independent review found oversized escaped-history/lifetime-roster replies and insufficient malformed replay validation. Both have reproduced failing-then-passing regressions. Cancellation during route lookup and idle WebSocket deadline regressions are also covered.

The expanded native test operates actual page controls against an offline production participant executable with a seeded 49-event durable inbox, roster and share queue. A separate deterministic engine transport inside the same test checks resolved share request/grant/release and leave through ClientSession; it also interrupts a UI acceptance reply and reloads without resubmission. This fixture is not SQL/runtime recovery evidence. The existing Docker participant scenario separately retains production transport, real SQL fences and two-runtime failure coverage. Screenshots are synthetic retained observations and include deliberately long/untrusted content.

Raft metadata/storage version 3, PostgreSQL schema and readiness semantics are unchanged. No separate consensus-only rerun is claimed. Replay/live uses periodic durable reads (200 ms default, up to eight pages per pass), with retry jitter after errors and no in-memory publication dependency or long-lived SQL snapshot. Local inbox/outcome disk retention grows for the meeting lifetime; garbage collection is deferred. Native capture/SFU has separate bounded feasibility evidence. Topics/subscriptions, meeting-code entry, full participant media integration, disconnect-grace policy, supervisor and complete fault-proxy/network deployment remain unfinished.
