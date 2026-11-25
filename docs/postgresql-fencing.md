# PostgreSQL fencing checkpoint

Docker is working. This `milestone-5` batch implements and tests the storage boundary in the [current redesign](superpowers/specs/2026-11-21-distributed-meeting-redesign.md). It is independent of the existing participant application and uses explicit test ownership assignments. There is no live Raft-to-SQL recovery controller yet.

The [consensus repair checkpoint](consensus-safety.md) addresses the three reproduced dependency failures and adds live partition and durable snapshot crash tests. The remaining integration gate is the resumable Raft-to-SQL activation protocol and its failure evidence; a committed candidate alone still grants no SQL authority.

## Run and inspect

Requirements: Node.js 24.16+, npm dependencies, and a running Docker Desktop Linux engine.

```sh
npm ci
npm run test:storage
npm test
npm run typecheck
```

`test:storage` creates its own Compose project, loopback port, random database credential, stable cluster UUID, and persistent named volume. It waits for a real database health check, runs seven storage cases and four fault/inspection cases, then stops only that project's containers. Volumes remain for inspection. The pinned image is PostgreSQL 18.7 Bookworm with a digest in `compose.yaml`; `fsync` and `synchronous_commit` remain enabled.

The [recorded result](../evidence/storage_run/result.json) contains measured fault timings. Runtime lab files are under `.local/storage-labs/zoom-storage-<id>/`: `lab.json`, private `lab.env`, and `result.json`. Credentials are never included in committed evidence.

For a separate manually managed lab:

```sh
node scripts/storage-lab.ts new
node scripts/storage-lab.ts resume <printed-lab-directory>
node scripts/storage-lab.ts stop <printed-lab-directory>
```

Resume requires the original manifest, environment file, and named volume. A missing volume fails rather than silently creating an empty replacement. `stop` retains the volume. New-lab readiness failure cleans up its own partially created service; the fault test verifies that a different running lab is untouched. To discard a stopped lab's database deliberately, remove only its exact `<project>_meeting-data` volume. No global Docker pruning or unrelated-container control is used.

`compose.yaml` can also be used directly with `.env.example` copied to an ignored environment file and a fresh random password. The published port binds to `127.0.0.1`. Docker container names are namespaced by the explicit Compose project.

## Storage boundary

`storage/database.ts` applies versioned migrations under a transaction-scoped migration lock, checks their normalized digests, and binds storage to one durable cluster UUID. Initial bootstrap is explicit. Opening normally cannot initialize an empty database, repair a missing identity, or accept another cluster's database. Later migrations require the explicit initialization/migration path; applied migration files are immutable.

`MeetingStore` uses separate controller and runtime connection pools:

| Operation | Guarantee |
| --- | --- |
| `create` | Atomically creates INITIALIZING fence/state, or verifies the existing meeting. Never replaces missing established state with an empty room. Codes remain reserved after closure. |
| `install` | Locks the fence and installs a strictly newer generation/candidate in RECOVERING. Matching retries are harmless; lower generations and same-generation identity mismatches fail. |
| `activate` | Enables only the matching RECOVERING attempt. A late superseded candidate fails. |
| `close` | Installs a newer terminal CLOSED transition. Reopening is rejected. |
| `execute` | Checks local readiness, locks the fence, checks ACTIVE owner identity, authenticates participant credentials, then resolves/evaluates and commits the command. |
| `read` | Checks readiness/owner/authentication within one bounded repeatable-read snapshot; returns state, events and watermarks without an exclusive fence lock. |
| `observe` | Controller observation in any phase; does not authorize commands or media. |

Owner identity includes cluster/meeting, generation, runtime UUID, process incarnation and recovery attempt UUID. Every mutation and ownership transition uses the **same per-meeting row lock**. A command racing takeover belongs wholly before the fence commit or fails afterward. PostgreSQL's lock/commit order supplies that cutover; no application timer bypasses it. Other meetings have independent fence rows.

Controller calls are trusted in-process operations. They must eventually be authorized by committed safe coordinator state, not by client input or a discovery hint. The current `Authority.ready()` is a synchronous local gate, not a consensus certificate. It is rechecked after lock waits and before returning the transaction's work. In-flight owner and command inputs are copied before asynchronous work so later caller mutation cannot redirect an operation outside its locked meeting.

## Durable commands and screen-share handoff

The engine supports join, meeting-wide chat, request/release screen share, and leave. At most 128 participants are joined concurrently. Departed identities remain for authentication/rejoin but do not consume live capacity; returning participants also obey the limit. Chat content is bounded to 8 KiB and names to 200 UTF-8 bytes. The existing pub/sub demo remains separate; topics/subscription revisions are not migrated yet.

Participants supply a stable UUID and a 256-bit resume secret represented as 64 lowercase hex characters. Only its SHA-256 verifier is stored, in a credential table excluded from inspection. Display names do not authenticate identity. Client-side persistence and transport authentication are later work; these are direct store tests, not an implemented participant reconnect protocol.

Every command has a stable UUID and semantic content digest. Outcomes are keyed by meeting/participant/command and retained for the meeting lifetime. Retrying the same operation after takeover or database restart returns the original outcome, including its original generation and sequence. Changed contents under that ID fail. Retransmission Lamport times can advance without changing semantic identity; the original committed event timestamp remains durable. All transport/commit uncertainty requires retrying the same command ID and contents.

In one transaction, a successful domain change updates state, advances the per-meeting counter, appends its event, saves the outcome, and writes any screen-media intention. The counter is transactional, so rollback creates no event gap. Rejections/no-ops can retain an outcome without generating a domain event.

Screen requests form a FIFO queue. Releasing/leaving atomically removes the old holder, selects the next waiter and advances the grant version. A release binds the exact participant/request identity; an older release cannot revoke a later grant. Forced outbox-write failure proves that grant, queue, counter, event and outcome roll back together. Media intentions are desired state only: no SFU effect or SQL/media distributed transaction is claimed.

## Bounded reads, privileges and faults

Commands use one checked-out connection for the complete SQL transaction. Runtime defaults are a 750 ms lock timeout, 2 s statement and idle-in-transaction timeouts, and a 5 s transaction timeout. Database defaults also impose finite limits. A timeout leaves recovery pending and never grants write authority. Query/connection failures propagate; checked-out and idle connection errors are handled so a restart does not terminate the process. Damaged connections are discarded.

The paused-client test starts a real Linux `psql` container, locks a fence and makes an uncommitted counter change, then pauses that container. PostgreSQL time continues. The first takeover attempt times out normally; the client's 1.2 s server-side idle timeout then releases the lock and rolls back its counter change. A retry installs the new owner, and the old owner is rejected. This is a paused database-client/process test, not yet a paused meeting-runtime application scenario.

`StorageInspector` has a separate two-connection pool and a real nonsuperuser login with SELECT grants only on approved views. It checks cluster identity, uses read-only repeatable-read transactions, shorter server timeouts, at most 100 events/outcomes and a 1 MiB returned JSON bound. It exposes no resume verifiers or credentials. Tests hold an exclusive fence row lock while inspection succeeds and verify that direct credential reads, DML and schema creation fail. A general SQL query panel is deferred; the current inspector exposes prepared observations only.

Participant replay pages scan committed events up to the snapshot watermark and return an explicit scanned watermark. There is no subscription filtering or long-lived live stream yet. Each request opens a fresh snapshot; overlapping takeover can legitimately return the pre-cutover view. No database transaction stays open for a WebSocket lifetime.

The restart test restarts PostgreSQL's container using its original named volume, resolves the original command outcome through a reconnected pool, reads retained events/state and reopens using the same cluster identity. This demonstrates restart recovery on one host. Database replication/failover, whole-system restore, backup/export tooling and independent-host resilience remain later acceptance work. A named volume is not an independent backup.

## Review and next integration

Independent review found the lifetime-capacity bug, fixed with a failing turnover/rejoin regression. Failed-startup cleanup was also reproduced against a real owned Docker project and fixed. A separate SQL regression reproduced mutation of an in-flight owner redirecting work to another meeting; inputs are now captured before awaiting the fence. The database restart test found and verified the active-client error-handler fix.

Next: extend coordinator metadata with resumable activation intent/readiness and implement the headless recovery worker against this storage boundary. Prove crashes/retries at each cross-system transition before connecting participant or media controls. After that, connect the 128-bit Chord lookup, persistent participant session/replay, supervisor, media adapter and dashboard. Retain the current separation between desired assignment, SQL ownership cutover and serialized media cutover.
