# Durable coordinator checkpoint

This is the first implemented checkpoint of the [distributed meeting redesign](superpowers/specs/2026-11-21-distributed-meeting-redesign.md), on `milestone-5`. The milestone-4 application and its demos still run separately. The new helper is not yet wired into `peer.ts` and does not authorize meeting access.

## Run the evidence

Install Node.js 24.16+ and Go 1.26+. Docker is not required for this checkpoint. The first Go build needs network access to download the exact versions in `services/coordinator/go.mod` and their checksum-verified dependencies.

From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run test:coordinator
npm run demo:coordinator
```

`npm test` runs the existing application tests plus the TypeScript protocol boundary tests. `test:coordinator` runs the Go suite and vet, builds the helper, and runs the independent-process test. `demo:coordinator` builds the helper and runs the checked scenario, printing its result and the directory containing its logs. Go caches and binaries stay in ignored `.cache/` and `.local/` directories; scripts work from any current directory and hide Windows helper windows.

The checked scenario:

1. Explicitly initializes five helpers with a shared voter configuration and separate persistent directories.
2. Reserves a meeting code, registers a runtime incarnation, and proposes generation 1 for that candidate. This is metadata only; there is no ACTIVE SQL fence.
3. Hard-kills the actual elected helper process. A surviving majority elects a replacement, and retrying the original reservation returns its original result and log index.
4. Commits more reservations and forces a file snapshot while the old leader is down. Restarts that same voter from its directory, observes a snapshot reply and applied-index catch-up, and checks that its process incarnation changed.
5. Holds down three of the five configured voters. The remaining two refuse authoritative reads and still report five configured voters and quorum three.
6. Restores those processes without bootstrap, then restarts all five processes. Metadata, candidate generation, and the original retry outcome remain available.

Go tests additionally cover four voters requiring three votes; adding and synchronizing a nonvoter before promotion to a fifth voter; removing it; stale configuration indices; lost/mismatched identity; reservation conflicts; stale candidate generations; snapshots; and malformed/authentication/stamp boundaries. These are crash, restart, and quorum tests on one host. They do not establish correctness for every partition, divergent log suffix, storage fault, or host failure. A [recorded successful run](../evidence/coordinator_run/result.json) contains the actual transition timeline.

Every run preserves its own directory under `.local/coordinator-labs/<uuid>/`: `lab.json`, `bootstrap.json`, per-incarnation JSONL traces, node stores/snapshots, and `result.json`. The cluster credential is in `.token`, outside the trace and result files. Successful and failed runs stop only their own child processes; files remain for inspection. Ctrl+C requests cleanup. An abruptly killed parent cannot guarantee child cleanup; this runner is not the durable supervisor proposed by the design.

## What is replicated

The deterministic FSM owns three operations:

| Command | Preconditions and result |
| --- | --- |
| `reserve` | Unique lowercase meeting code and immutable meeting UUID. Concurrent conflicts yield one winner. |
| `register` | Runtime UUID/incarnation with an expected registration revision. Stale registrations fail. |
| `assign` | Existing meeting and matching registered runtime incarnation; expected meeting generation; unique attempt UUID. A successful proposal advances generation once. |

All operation IDs are UUIDs. Outcomes, including domain rejections, are retained with a digest of semantic command contents. Retransmissions can have different envelope timestamps and request IDs while retaining the same command ID and contents. Reusing a command ID for other contents returns `ID_CONFLICT`. Snapshots include outcomes and the committed voting configuration/index. There is no outcome garbage collection in this lab.

Raft commits use a majority of configured voters and durable Bolt log/stable storage with syncing enabled. File snapshots compact coordinator metadata. Authoritative reads commit a fresh Raft barrier; a local status reply is explicitly an observation, not authority. A timeout or broken reply can leave a mutation's outcome uncertain. Resolve it through a leader using the original command ID and contents; do not generate a new ID automatically.

Assignments here are desired candidates. The SQL recovery phases, renewal gates, effective storage fences, media reconciliation, and runtime takeover controller have not been implemented. Existing `peer.ts` election/locks remain the old demonstration and do not become Raft-backed merely because this helper exists.

## Start a helper manually

Build with `npm run build:coordinator`. The binary is `.local/bin/coordinator.exe` on Windows and `.local/bin/coordinator` elsewhere. Put one shared random credential of at least 32 bytes into `ZOOM_CLUSTER_TOKEN`; it is read from the environment, never a command-line argument.

For an explicitly new single-voter learning cluster, save this as a local `bootstrap.json`:

```json
[{"id":"10000000-0000-4000-8000-000000000001","address":"127.0.0.1:7901"}]
```

PowerShell example (generate your own cluster and node UUIDs for separate labs):

```powershell
$env:ZOOM_CLUSTER_TOKEN = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
.\.local\bin\coordinator.exe --new --cluster 20000000-0000-4000-8000-000000000001 --id 10000000-0000-4000-8000-000000000001 --listen 127.0.0.1:7901 --data .local/manual-node-1 --bootstrap bootstrap.json
```

For a multi-voter bootstrap, use exactly the same complete list of initial voter IDs/addresses at every node, each with its own matching ID, port, and new directory. Bootstrap is explicit initialization, never a response to unreachability. A new directory must not already exist. A joining node starts with `--new` and no bootstrap file; it cannot create its own cluster.

On normal restart, supply the same cluster UUID, node UUID, address, directory, and environment credential; omit **both** `--new` and `--bootstrap`. Missing storage or mismatched identity/address fails startup. A store UUID binds `identity.json` to a sentinel in the Bolt store; an empty valid replacement database cannot masquerade as the original store, including for a node originally admitted as a nonvoter. The persisted voting term is also required. A retained snapshot does not excuse lost voting state. Keep the entire node directory, including `identity.json`, `raft.db`, and `snapshots/`.

Never run two processes with the same voter identity, or use `--new` to reconstruct a lost voter's state under that identity. Directory and port checks prevent ordinary accidental reuse locally, but do not enforce uniqueness across copied directories/machines. Replacement after state loss requires quorum: remove the old voter through an agreed configuration change, initialize a new UUID/directory, add it as a nonvoter, synchronize, then promote. A minority cannot perform this recovery and must wait for enough existing voters.

## Control boundary

`coordination/helper-client.ts` provides `HelperClient.call(operation, args)` for `status`, `read`, `apply`, `configuration`, `add-nonvoter`, `promote`, `remove`, and `snapshot`. `forHelper(id, address)` changes destination while retaining the caller's identity, incarnation, and Lamport clock. It does not hide retries or follow unauthenticated redirects. Callers must retain pending command IDs; the durable participant session will be built in a later batch.

Membership requests require `nodeId`, `expectedIndex`, and, for admission/promotion, `address`. Fetch an authoritative `configuration`, then pass its index. A stale index fails. Adding always starts as a nonvoter; promotion checks its applied index against the leader's committed watermark. Membership response loss requires inspecting the configuration before issuing a refreshed operation, rather than blindly repeating admission/removal.

The helper uses `/v1/control` and `/v1/raft`, authenticated with the cluster bearer credential. Both accept a bounded, newline-terminated JSON envelope containing version, cluster/node/incarnation, request ID, Lamport time, kind, and body. Snapshot requests append a bounded raw stream to that stamped header; the stamped response records completion. Replies are correlated and size-limited. Heartbeats use the same route and checks. The adapter rejects malformed RPC entries and configuration encodings before dispatch to library goroutines, and binds library sender identity to the envelope. Credentials and command bodies are excluded from trace records.

Before election goroutines start, the helper advances its clock from durable log stamps and restored snapshot state. Replayed commands advance the same clock. Snapshot-covered gaps are valid after catch-up; gaps outside a snapshot are startup failures. Checked clock arithmetic rejects near-exhaustion timestamps without advancing the clock, and exhausted sends fail explicitly rather than emitting an invalid stamp.

The helper deliberately returns `ErrPipelineReplicationNotSupported`; HashiCorp Raft falls back to regular AppendEntries. This trades throughput for one transport path to validate. Consensus remains the library implementation. Loopback-only plaintext HTTP is the current deployment boundary. Authenticated LAN transport/TLS, source-specific fault proxies, and container packaging are later checkpoints.

Control requests have a 32-request concurrency bound, three-second operation context, and bounded HTTP reads/writes. Envelopes are limited to 1 MiB and snapshots to 32 MiB. A response exceeding the envelope bound fails explicitly; no pagination/retention system is claimed. Per-meeting payloads, resume credentials, and media do not belong in this metadata service.

## Dependency findings and next evidence

The pinned Raft version's `GetConfiguration().Index()` returns zero. The adapter implements the supported `ConfigurationStore` callback, snapshots the committed index, and passes that nonzero index to membership changes. If a newer configuration is pending, the library rejects the stale index. This avoids silently disabling version guards. See the [upstream report](https://github.com/hashicorp/raft/issues/722) and [ConfigurationStore API](https://pkg.go.dev/github.com/hashicorp/raft@v1.8.0#ConfigurationStore).

Authoritative reads use a newly committed barrier rather than treating leader status or nonvoter reachability as proof of authority. The library also has [an open VerifyLeader/nonvoter report](https://github.com/hashicorp/raft/issues/725); this code does not rely on that optimization.

**Subsequent safety audit: the pinned Raft dependency is blocked for ownership integration.** Three new regressions in `services/coordinator/safety_test.go` reproduce uncommitted metadata application ([#733](https://github.com/hashicorp/raft/issues/733)), rejection of valid post-snapshot appends ([#697](https://github.com/hashicorp/raft/issues/697)), and retention of divergent commands below a snapshot ([#721](https://github.com/hashicorp/raft/issues/721)). The tests use authenticated helper HTTP, its real FSM and Bolt store, with constructed partition-boundary histories. They do not claim to run a live partition/election. Barrier reads and disabled pipelining do not fix these bugs.

Run the explicit known-failing audit in PowerShell:

```powershell
$env:GOPATH = Join-Path (Get-Location) '.cache/go'
$env:GOCACHE = Join-Path (Get-Location) '.cache/go-build'
$env:ZOOM_RAFT_SAFETY_AUDIT = '1'
go -C services/coordinator test -run '^TestRaftSafety' -count=1 -v
Remove-Item Env:\ZOOM_RAFT_SAFETY_AUDIT
```

All three currently fail their safety assertions (exit 1). The ordinary suite explicitly skips these opt-in reproductions; that green suite does not establish consensus safety. Proposed upstream fixes [#734](https://github.com/hashicorp/raft/pull/734) and [#735](https://github.com/hashicorp/raft/pull/735) were still unmerged at audit time. No safe upgrade has been selected. Do not activate external database/media ownership using this dependency until a reviewed replacement or fixed version passes these and live partition/recovery tests. Independent PostgreSQL fencing tests use explicit test assignments only.

The next implementation plan should prove PostgreSQL fence/command races, stalled transaction timeouts, and resumable Raft-to-SQL activation before connecting participant or media controls. Docker Desktop must be running for that work. Preserve the SQL cutover rule and the separate media cutover; a successful assignment in this demo does not implement either one.

## Review and verification record

An independent read-only reviewer identified malformed-RPC panic exposure, acceptance of an empty replacement store for a promoted joiner, and missing restoration of the process clock from durable timestamps. Each has a regression that failed before its fix. Near-limit clock arithmetic was also fixed and tested in both languages. The process test caught stdout backpressure in the runner; startup now leaves the log pipe draining.

Final checks for this batch: 57 Node tests; 19 Go test functions with additional subcases; Go vet; Go race detector; TypeScript typecheck; five-process integration test; and the standalone demo. The integration and demo both verify full-process restart and snapshot transfer. No browser/media, PostgreSQL, LAN, or container acceptance is claimed.
