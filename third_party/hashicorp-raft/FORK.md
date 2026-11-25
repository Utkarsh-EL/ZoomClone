# ZoomClone Raft dependency

This is a local dependency fork for the bounded ZoomClone demo. It is **not** an upstream HashiCorp release or a formal consensus proof. `services/coordinator/go.mod` explicitly replaces `github.com/hashicorp/raft` with this directory. The original license and complete module sources/tests are retained.

## Provenance

- Base: HashiCorp Raft `v1.8.0`, tag commit `0f543c056e7e577a54b819a62116335c9661a13a`.
- Go module checksum: `h1:YbfecBcuTar/LNFEDfVTpqu9Aw+MczTk7MYczvy+62k=`.
- `UPSTREAM-SHA256.json` records the original bytes of every copied base file. Five production files differ: `api.go`, `future.go`, `raft.go`, `snapshot.go`, `state.go`.
- `patches/upstream-734.diff`: exact proposed [PR #734](https://github.com/hashicorp/raft/pull/734), head `ff6579cbe14422a9440d79e697293aa85726df5c`.
- `patches/upstream-735.diff`: exact proposed [PR #735](https://github.com/hashicorp/raft/pull/735), head `b62659f8bdb38702fed3c956f7d6b40905e4d29d`.
- Both PRs were open/unmerged when inspected. Their tests are imported; their shared fixture is identical. The snapshot deletion-error test is locally adapted to require shutdown/restart reconciliation, rather than allowing a failed node to continue.
- `patches/local-vs-v1.8.0.diff` records the actual production delta, including the local corrections below. It differs deliberately from simply stacking the two proposed PRs.

## Safety invariants

1. Follower commitment advances only through the prefix covered by the particular append and never regresses (PR #734).
2. An interrupted incoming snapshot preserves all existing logs. Local commitment may lag global commitment, so deleting an apparently uncommitted tail before durable replacement is unsafe.
3. Snapshot preparation only reads boundary/configuration information. After the snapshot is durably published, divergent logs are reconciled before the RPC can succeed or the restored state can serve. Snapshot publication or cleanup/restore uncertainty shuts the node down.
4. Startup restores a valid snapshot and reconciles its log **before voting or serving**. A matching boundary proves retained logs safe and preserves trailing-log retention. A conflicting boundary discards that log. With a missing boundary, covered logs are removed while the suffix above the snapshot is preserved. The production Bolt store's range deletion is transactional. Startup I/O failure prevents service.
5. A snapshot at or below the applied index cannot rewind the FSM. Snapshot commitment/cached stable boundaries are monotonic, including when an older background snapshot finishes later.
6. A matching retained suffix may contain pending membership. Rebuild that configuration after restoring snapshot membership; duplicate appends must not lose it.
7. Snapshot log preparation/cleanup and background compaction share a mutex for their multi-call store views. Repeated `Shutdown().Error()` joins outstanding routines and closes the transport once, even if an internal failure initiated shutdown.
8. Failed leader log writes synchronously initiate shutdown before responding. A failed configuration write cannot install membership, change quorum or stop a removed peer's replication. This closes the helper-reachable [unwritten membership issue #726](https://github.com/hashicorp/raft/issues/726); it does not certify arbitrary disk faults.

An independent pre-implementation review found the crash/error/membership/older-snapshot gaps in simply applying PR #735. Further durability analysis rejected early trimming; `TestLocalInterruptedSnapshotPreservesUnconfirmedDurableSuffix` captures that requirement. No pre-fix application history is automatically repaired: helper storage/envelope version 2 rejects old stores/binaries; old directories remain for inspection.

## Validation and scope

The base test suite, imported proposed tests and local regressions run with Go's race detector. Application tests cover real Bolt/FileSnapshotStore process kills immediately before/after publication; the original three reproductions; and a five-voter 2/3 TCP partition, snapshot catch-up, healing, restart and even-size membership afterward. The network partition test uses separate helper instances/stores/sockets in one Go process. A separate scenario runs five independent helper processes for crash/restart evidence.

The helper intentionally omits optional append pipelining and heartbeat fast-path dispatch; all consensus messages use its authenticated serialized consumer and source-specific TCP routes. This fork is tested for the helper's default Bolt-backed, automatic-FSM-restore configuration. Arbitrary custom log stores, Byzantine members, disk corruption and unrelated upstream feature combinations are not newly certified by this work.

Keep this fork small and auditable. A future upstream replacement must pass the same always-enabled safety and integration regressions before the `replace` directive is removed. SQL activation/reconciliation is a separate application protocol and still needs its own failure evidence.
