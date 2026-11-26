# Chord discovery checkpoint

The backend has a focused Chord discovery service. It uses SHA-256 truncated to 128 bits over a versioned cluster/namespace/name tuple, bigint arithmetic internally, and exactly 32 lowercase hexadecimal digits on the wire. The original 16-bit overlay and combined application have been retired to Git history.

`DiscoveryNode` maintains a predecessor, four successors and 128 fingers. Iterative lookups try preceding fingers and successor fallbacks, detect revisits, and stop after 32 hops, 64 remote attempts, or the shared deadline (default 1500 ms). Each attempt also has a deadline of at most 250 ms, leaving time for other bootstrap/fallback routes. Maintenance repairs eight fingers per tick by default. It retains at most 32 contact addresses, rotates failed contacts, refreshes process incarnations through authenticated status, and probes contacts even with healthy successors so surviving subrings can merge after healing. A peer that has observed another member refuses to invent singleton routing when isolated.

Discovery records are **hints**. They cannot create a Raft assignment, change voters, activate storage, install a runtime gate, or authorize a participant command. Helpers still communicate directly over Raft transport. `resolveMeeting` independently requires a successful Raft barrier read with READY assignment and a matching ACTIVE PostgreSQL fence. Its result is an observation; service still checks runtime readiness and the SQL fence. Unknown codes are reported only after a successful metadata read; failed dependencies return unavailable.

## Run a peer

Run `npm run start:discovery` with `ZOOM_DISCOVERY_CONFIG` supplied as protected JSON in the process environment. No secrets are accepted as command-line arguments or printed in startup logs.

| Field | Value |
| --- | --- |
| `clusterId`, `nodeId` | Existing cluster UUID and stable peer UUID. |
| `address` | Literal loopback address, such as `127.0.0.1:7201`. Port zero allocates a port. |
| `token` | Backend discovery credential, at least 32 bytes. |
| `initialize` | Boolean `true` for explicit initial overlay creation. This never initializes Raft. |
| `bootstraps` | One to sixteen peer addresses for joining; required instead of initialization. Unreachable bootstraps fail startup. |
| `intervalMs`, `timeoutMs` | Optional maintenance interval (default 500) and operation deadline (default 1500). |
| `announcements` | Optional array of up to sixteen `{namespace, name, generation, value}` hints. |

The CLI generates a fresh process incarnation. For helper discovery, announce namespace `service`, name `coordinators`, and value `{ "helpers": [{ "helperId": "<helper UUID>", "address": "127.0.0.1:7001" }] }`. Include all configured helper endpoints, up to nine. The deployment supplies a positive generation; changing contents requires increasing it. Each publisher must agree on the same generation/contents. Announcements are refreshed after maintenance with 30-second expiry; intervals above ten seconds are rejected when announcements are configured. Programmatic meeting placement hints use namespace `meeting` and a meeting code/name; they carry no write authority.

Hints are copied to the ring owner and up to four successors. Each node holds at most 1024 hints; a hint is at most 8 KiB with TTL at most 60 seconds. Older generations cannot replace a retained newer one; conflicting contents at the same generation fail, and reordered refreshes cannot shorten expiry. Producers republish volatile hints; there is no durable discovery log or guaranteed key transfer on topology changes. Temporary misses or stale hints are expected during churn. Losing every remembered reachable contact requires explicit reprovisioning; the implementation does not promise discovery availability under every partition.

## Consume from the new backend

`DiscoveryClient` is a bootstrap-only reader. It performs authenticated `/v1/discovery` lookups without joining the ring or becoming a voter. It accepts multiple bootstrap addresses, a total timeout (default 4000 ms), and an optional shared `ControlWire`. Attempts receive a fair share of the total deadline, selection rotates after failures, and a successful bootstrap is preferred on later calls, so two stalled routes cannot permanently hide a reachable third.

`startMeetingRuntime` accepts optional `discovery: {bootstraps, token, timeoutMs}`. In that mode, `helpers` may be empty: `DiscoveredHelpers` resolves the `coordinators` service hint and constructs normal authenticated `HelperClient` routes. The runtime, helper clients and discovery client share one Lamport clock. Once a route succeeds, subsequent reads use its authenticated Raft barrier directly; discovery is refreshed when cached helper reads fail. A stalled discovery service therefore cannot consume readiness time while cached helpers remain healthy. Mutations are sent once through the last established route; this adapter never retries an uncertain write or invents command IDs.

The transport uses existing version 2 stamped envelopes, request correlation, cluster authentication and destination incarnation checks. Trust matches the existing local backend: holders of the token are trusted cluster members, not independently authenticated cryptographic principals. Requests are limited to 64 KiB, replies to the existing 1 MiB control bound, active requests to sixteen and sockets to 64. Socket deadlines include incomplete HTTP headers. Shutdown stops ingress and drains maintenance and pending lookup handlers before returning. LAN/container-network transport remains future work.

## Evidence and next increment

`npm test` includes discovery regressions for 128-bit namespace separation, real finger shortcuts in a 12-peer ring, consecutive successor failures, replication/expiry, dead and stalled bootstrap routes, routing bounds, isolated peers and surviving subrings healing, invalid initialization, authentication/framing/incarnation checks, private configuration exclusion, shared clocks, draining shutdown, and no automatic retry of uncertain helper writes.

`npm run test:runtimes` adds real Raft/PostgreSQL process evidence: four discovery peers supply all helper routes to three independent runtimes; one bootstrap stops, a helper leader crashes, two runtimes crash, a survivor recovers durable membership/outcomes, a restarted incarnation cannot inherit ownership, and quorum loss withdraws readiness. Domain commands in this scenario still use the existing test IPC fixture. There is no production participant transport or durable ClientSession yet.

Next implement one persistent ClientSession shared by future CLI/browser attachments: persist join credentials and immutable command IDs/contents before sending; preserve uncertain retries and meeting-scoped replay cursors across process restart; exercise those against actual fenced PostgreSQL commands and runtime takeover. Then connect production participant join/chat/reconnect/replay before UI/media expansion.
