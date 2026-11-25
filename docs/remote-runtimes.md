# Remote runtime checkpoint

Meeting runtimes now run independently of the coordinator worker. Authenticated loopback adapters implement `Candidate.prepare`; a background runtime agent registers its incarnation, discovers its READY assignments and schedules fenced renewals. The existing Raft-to-PostgreSQL activation protocol is unchanged. Original participant/peer/video demos remain separate.

## Run the checks

With Node.js 24.16+, installed npm dependencies, Go 1.26+ and Docker Desktop:

```sh
npm test
npm run typecheck
npm run test:coordinator
npm run test:runtimes
```

`test:runtimes` builds the helper, provisions an isolated persistent PostgreSQL lab, and runs storage, storage-fault, ownership-recovery and remote-runtime process tests. Only owned children/services are stopped. Volumes and helper traces remain under ignored `.local/` directories. The participant commands in the runtime test use an IPC evidence fixture; production runtime listeners expose only status and preparation.

## Runtime and worker composition

`coordination/runtime-service.ts` exports `startMeetingRuntime(config, report)`, returning the agent, storage boundary, listener address, completion promise and idempotent `close`. `scripts/meeting-runtime.ts` is its process entry point:

```sh
node scripts/meeting-runtime.ts
```

Provision `ZOOM_RUNTIME_CONFIG` as JSON through the process environment. Required configuration fields are:

| Field | Meaning |
| --- | --- |
| `clusterId`, `runtimeId` | Existing cluster UUID and stable provisioned runtime UUID. |
| `expectedRevision` | Observed registration revision at provisioning (zero for a new runtime ID). |
| `address` | Literal loopback listener, such as `127.0.0.1:7101`; port zero allocates a test port. |
| `token`, `callers` | Runtime control token (at least 32 bytes) and allowed controller node UUIDs. |
| `helpers` | One to nine provisioned `{helperId, address}` helper routes. |
| `helperToken` | Existing cluster control credential. |
| `connectionString` | Backend database connection for the existing ownership observation boundary. |
| `runtimeConnectionString` | Restricted `zoom_runtime` connection for preparation and domain work. |

Optional `intervalMs` defaults to 500, `readinessMs` to 2000, `maxMeetings` to 128 and `helperTimeoutMs` to the helper client's 4000. Scheduling is sequential and bounded; dependency latency or many assigned meetings can expire readiness. The interval must be shorter than readiness. These defaults are configurable demo values, not latency guarantees. The CLI always generates a fresh process incarnation. The factory accepts an explicit incarnation for provisioners/tests that already allocate one.

Keep credentials in protected environment/configuration, outside command-line flags and evidence files. Startup and renewal logs contain identity/status only. The public runtime identity does not retain database credentials or control tokens.

On the worker side, create `RemoteRuntime` adapters with the provisioned cluster/runtime/incarnation, address/token and a controller `Identity`. Create one `ControlWire(identity)` for that controller incarnation and pass it as the second argument to every `RemoteRuntime` and `HelperClient` belonging to that identity. Shared wires are validated against the caller identity and preserve one Lamport clock across destinations. Pass `() => availableRuntimes(routes)` to the existing `RecoveryController.run` candidate supplier. The worker remains independent of the dashboard. Probes filter the configured routes; they do not modify Raft membership, replace Chord discovery or independently authorize placement.

## Authentication and bounded RPC

The `/v1/runtime` listener accepts only authenticated `status` and `prepare` requests from configured controller IDs. Version 2 envelopes carry cluster, sender incarnation, request ID and Lamport time. A runtime process shares one clock across its incoming runtime calls and outgoing helper calls. Replies are correlated to the request and expected runtime ID/incarnation. Requests also name the destination incarnation, so reuse of a port by another process cannot acknowledge old work.

The trust model matches the existing local helper control plane: provisioned backend members holding the token are trusted, and can claim allowed sender IDs. This is not per-node cryptographic identity or participant authentication. Only literal loopback HTTP routes are currently enabled; LAN/container-network bindings require a later authenticated transport/proxy boundary.

Runtime requests are limited to 64 KiB, one newline-delimited frame, UUID owner fields and an exact operation shape. Clients bound reply size and enforce a whole-call deadline. Servers bound connections, concurrent handlers and socket lifetime from acceptance, including incomplete HTTP headers. A timed-out preparation retains its admission slot until the underlying work actually settles; abandoning a socket cannot create unlimited background work. Preparation only reads committed state and never grants readiness. Existing SQL server-side timeouts do not establish end-to-end completion through a blackholed database connection; such work can retain admission slots and delay shutdown.

## Registration, readiness and shutdown

Registration is a compare-and-set command with one immutable ID, contents and expected revision for that process start. An uncertain reply retries that same command. A replacement incarnation receives the next observed revision from provisioning. A rejected or revoked old process stops instead of repeatedly reading the latest revision and registering over its replacement.

The scheduler only creates an authority gate for its own exact READY assignment, after preparing a consistent SQL view. Every renewal still uses `RuntimeAuthority`: a fresh committed assignment, revision-guarded renewal and matching SQL ACTIVE fence, with a monotonic deadline measured from refresh start. A failed initial read clears all gates; failed per-meeting renewal clears that gate. A local ready probe does not reserve authority across a later renewal. Commands may need to retry their original IDs during refresh or dependency failure.

Barrier reads may try the provisioned helper routes after a leader change. Mutations go once to the last successful read destination; the router never replays an uncertain write. The next scheduler iteration discovers the current leader before resolving/retrying registration or renewing again.

Stop/abort invalidates gates immediately. Late registration, preparation or renewal results cannot enable a stopped runtime. Terminal registration conflict/revocation reports its cause, rejects the completion promise and closes its listener and pools; explicit cleanup remains idempotent. The CLI exits unsuccessfully for terminal failure. SQL fences remain the final authority for every domain command; a timeout or local readiness observation is not a cross-machine lease.

## Evidence and remaining work

The independent-process scenario uses three real helpers, PostgreSQL and three runtime children. It activates through remote adapters, observes multiple autonomous renewals, kills a helper leader, observes renewal through its successor, kills two runtimes and activates the survivor. A repeated command returns its original outcome and retains membership. Late old SQL activation and preparation by a restarted unassigned incarnation are rejected. Quorum loss withdraws readiness. A separate process integration check covers terminal registration failure propagation and cleanup. HTTP tests cover authentication, stale destinations/replies, malformed frames, size/deadline/concurrency bounds, partial bodies/headers and shared controller clocks.

Independent review found the incomplete-header deadline and per-adapter controller clock issues; both have failing-then-passing regressions. A further run-loop regression reproduces and fixes silent terminal registration failure. No new minor review findings were deferred.

See [recorded results](../evidence/runtime_run/result.json). These are process failures on one machine, not host-failure evidence or a general protocol proof. Automatic Chord discovery, participant ClientSession identity/replay, production participant RPC, per-meeting runtime write queues, SFU/media, full fault-proxy routing, supervisor and dashboard remain later work. Retained coordinator outcomes still have the existing 32 MiB snapshot capacity limit. Coordinator storage remains version **3**; no rolling mixed-version upgrade is claimed.
