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

`startParticipant(config)` exposes exactly one `session` with `submit`, `view`, serialized `step` and abortable `run`. CLI and future GUI adapters must use that object. A browser attachment interface and GUI do not exist yet; token/origin validation for that local interface and attachment/capture revisions are the next integration step. The runtime gateway is for trusted local agents and is not a browser/public deployment boundary. Current configuration selects the meeting UUID; meeting-code entry/discovery UX remains future work.

## Checked evidence and remaining limits

`npm test` passes 56 tests; `npm run typecheck` passes. `npm run test:runtimes` includes the new independent participant process scenario alongside storage, faults, ownership recovery and discovered runtime tests. See [evidence](../evidence/client_session_run/result.json) for the final lab and results.

The participant scenario starts production scripts, three real Raft helpers, three independent runtimes with restricted PostgreSQL pools, and two independent participant agents. A test-only WebSocket relay drops a committed join reply and a committed chat reply, then blocks retries until the agent is killed. Restart reuses its credentials/IDs. Two runtime crashes move ownership to the survivor; offline chat is replayed exactly once into the local inbox, the old owner is fenced, a restarted runtime's old incarnation is rejected, quorum loss retains uncertainty, and quorum restoration completes the pending ID. The pre-existing suite separately covers PostgreSQL restart, paused lock holders, helper leader replacement and discovery failure. This is bounded process-failure evidence on one host.

Independent review found oversized escaped-history/lifetime-roster replies and insufficient malformed replay validation. Both have reproduced failing-then-passing regressions. Cancellation during route lookup and idle WebSocket deadline regressions are also covered.

Raft metadata/storage version 3, PostgreSQL schema and readiness semantics are unchanged. No separate consensus-only rerun is claimed. Replay/live uses periodic durable reads (200 ms default, up to eight pages per pass), with retry jitter after errors and no in-memory publication dependency or long-lived SQL snapshot. Local inbox/outcome disk retention grows for the meeting lifetime; garbage collection is deferred. Topics, secured browser attachment, GUI/media, disconnect-grace policy, supervisor, SFU and complete fault-proxy/network deployment remain unfinished.
