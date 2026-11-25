# Consensus repair checkpoint

The three reproduced Raft log/snapshot failures are repaired on `milestone-5`; their tests now run unconditionally. This checkpoint also adds a live TCP partition and real-process snapshot-publication crashes. The later [ownership activation checkpoint](ownership-activation.md) connects Raft to SQL through a headless controller; the migrated meeting application remains in progress.

## Run the checks

Requirements: Node.js 24.16+, npm dependencies, Go 1.26+, and a C compiler supported by Go's race detector. This checkpoint does not require Docker.

```sh
npm ci
npm run test:coordinator
npm run test:consensus
npm test
npm run typecheck
```

`test:coordinator` runs local dependency safety regressions, the complete helper suite, vet, a build and the five-process scenario. `test:consensus` runs the complete fork and helper suites uncached with `-race`, followed by vet, build and that process scenario. No `ZOOM_RAFT_SAFETY_AUDIT` flag is needed. The snapshot crash-child fixture skips only its direct invocation; its parent test executes it as a real subprocess at each crash boundary.

## Dependency choice and ordering

The released HashiCorp Raft v1.8.0 reproduced three failures through authenticated helper HTTP with real Bolt storage: application of an uncommitted suffix, rejection of a valid post-snapshot append, and retention of divergent entries below a snapshot. Barrier reads and disabling pipelining do not repair those failures.

No released fix was available when inspected on 2026-11-25. A local Go module replacement preserves the existing integration, disk format and complete upstream test suite. Switching to another Raft core would require a new persistence, message and membership driver. Carrying this fork has a maintenance cost; replace it only when the alternative passes the same regressions and failure scenarios.

The fork incorporates the append-bound correction proposed in [PR #734](https://github.com/hashicorp/raft/pull/734) and adapts the snapshot correction proposed in [PR #735](https://github.com/hashicorp/raft/pull/735). Both were unmerged when inspected. [Fork provenance](../third_party/hashicorp-raft/FORK.md) records exact commits, the original module checksum, per-file SHA-256 values, both proposed patches, and the actual five-file production delta. Original license notices are retained.

The important local correction is **publication before cleanup**. A follower can hold globally committed entries before learning their commit index. Deleting an apparently uncommitted tail before a replacement snapshot is durable could therefore lose acknowledged data if transfer fails. Preparation only reads the log. The helper publishes the replacement snapshot durably, reconciles divergent logs before success/service, and stops on publication, cleanup or restore uncertainty. Startup repeats reconciliation after restoring a valid snapshot and before voting. A matching boundary preserves trailing logs; a conflicting boundary discards the divergent log; a missing boundary removes the covered prefix while preserving the later suffix. Bolt range deletion is transactional.

Other local regressions protect monotonic commit/snapshot boundaries, older-snapshot rejection, retained pending membership, background compaction serialization and repeated shutdown joining. A failed leader log write now stops the node synchronously; a failed membership write cannot install a different voting/commit configuration ([upstream issue #726](https://github.com/hashicorp/raft/issues/726)). This is a scoped failure policy, not a general disk-corruption recovery mechanism.

## Failure evidence

| Check | Boundary exercised |
| --- | --- |
| Three original helper regressions | Constructed old/new-leader histories cross the real authenticated HTTP, FSM and Bolt boundary. Each failed against released v1.8.0 and now passes. |
| Snapshot publication process kills | A real child with Bolt and file snapshots exits immediately before or after publication. Restart must retain un-replaced logs before publication and remove covered divergence after publication. The after-publication case failed against the unpatched dependency. |
| Five-voter TCP partition | Five helper instances have independent stores/listeners and source-specific TCP proxies. A 2/3 split leaves an unacknowledged minority proposal while the majority commits the same code correctly. Forced snapshot, healing, old-leader restart and removal to four voters preserve only majority outcomes. |
| Failed membership write | An injected atomic store failure while removing one of four voters preserves the original membership, commit quorum and replicators, and closes shutdown synchronously. The regression failed before the fix. |
| Five independent processes | Leader kill, majority election, snapshot catch-up, minority refusal and complete-cluster restart retain the original metadata/outcome. |

The partition test's five helper instances run in one Go process; its faults cut actual TCP connections, including pooled sockets. The snapshot crash test uses real subprocesses and native in-memory RPC transport to isolate the durable publication boundary. The separate process scenario tests the helper executable and TypeScript bridge. These distinct scopes should not be conflated.

The [recorded result](../evidence/consensus_run/result.json) reports the final checks and limits. Independent read-only review found no further material snapshot/append defect within the stated intact-storage crash/network model, and identified the failed-membership-write case fixed above. Passing tests and review are evidence, not a formal consensus proof.

## Compatibility and next work

New helper directories use storage version 3 after the ownership activation checkpoint. Old directories may already contain incorrectly applied outcomes; startup rejects them and preserves them for inspection. Create a fresh isolated lab instead of editing identity markers. Envelope version 2 rejects mixed legacy helpers/clients. HTTP operation paths, the metadata schema and native Raft snapshot versions have separate versioning.

Optional append pipelining and heartbeat fast-path dispatch are omitted. All consensus messages reach the serialized authenticated consumer. `--routes` maps logical loopback destinations to loopback proxy endpoints separately for each source; peer-control requests use it too. This is coordinator routing evidence, not complete whole-system fault routing or LAN/TLS acceptance.

The supported setting is the helper's default automatic-FSM-restore configuration with intact, synchronous Bolt storage. Arbitrary custom stores/options, Byzantine nodes, disk corruption, hardware power-loss durability and every possible message schedule are not certified. PostgreSQL and the SFU remain initial single availability dependencies.

Next add committed activation intent/readiness and a headless reconciliation worker against the [SQL fence](postgresql-fencing.md), with crashes and retries at every cross-system transition. Desired Raft assignment, SQL ownership cutover and media cutover remain distinct. No assignment from this checkpoint grants participant or media authority by itself.
