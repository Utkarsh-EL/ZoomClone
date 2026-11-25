// SPDX-License-Identifier: MPL-2.0
// Local regressions supplement the proposed upstream fixes. See FORK.md.
package raft

import (
	"errors"
	"io"
	"testing"
	"testing/iotest"

	"github.com/stretchr/testify/require"
)

type publicationCheckedStore struct {
	LogStore
	check func() error
}

func (s *publicationCheckedStore) DeleteRange(min, max uint64) error {
	if min == 3 && s.check != nil {
		if err := s.check(); err != nil {
			return err
		}
	}
	return s.LogStore.DeleteRange(min, max)
}

func TestLocalSnapshotPublicationPrecedesCleanup(t *testing.T) {
	store := &publicationCheckedStore{LogStore: newBoltLikeLogStore()}
	f := newTestFollowerOn(t, store, 2, confLog(), cmd(2, 1, "committed"), cmd(3, 2, "stale"))
	f.appendEntries(t, AppendEntriesRequest{Term: 3, PrevLogEntry: 2, PrevLogTerm: 1, LeaderCommitIndex: 2})
	store.check = func() error {
		snapshots, err := f.r.snapshots.List()
		if err != nil {
			return err
		}
		if len(snapshots) == 0 {
			return errors.New("possibly committed log entries were trimmed before durable replacement")
		}
		return nil
	}
	f.installSnapshot(t, 3, 10, 3)
	require.Equal(t, map[uint64]uint64{1: 1, 2: 1}, f.stored(t))
}

// Reuse the same persisted log/stable/snapshot stores across a process-style
// stop/start. The caller has already observed shutdown or is stopping it here.
func (f *testFollower) restart(t *testing.T) {
	t.Helper()
	_ = f.r.Shutdown().Error()
	_, receiver := NewInmemTransport("f")
	_, sender := NewInmemTransport("l")
	sender.Connect("f", receiver)
	receiver.Connect("l", sender)
	fsm := &recordingFSM{}
	configuration := f.r.config()
	r, err := NewRaft(&configuration, fsm, f.store, f.r.stable, f.r.snapshots, receiver)
	require.NoError(t, err)
	t.Cleanup(func() { _ = r.Shutdown().Error() })
	f.r, f.fsm, f.leader = r, fsm, sender
}

func TestLocalSnapshotNeverRewindsAppliedState(t *testing.T) {
	f := newTestFollower(t, 1, cmd(2, 1, "a"), cmd(3, 1, "b"), cmd(4, 1, "c"), cmd(5, 1, "d"))
	f.appendEntries(t, AppendEntriesRequest{Term: 1, PrevLogEntry: 5, PrevLogTerm: 1, LeaderCommitIndex: 5})
	f.fsm.waitApplied(t, 5)
	f.installSnapshot(t, 1, 3, 1)
	f.requireCommitted(t, 5, 5)
}

func TestLocalSnapshotPublicationCannotMoveStableBoundaryBackwards(t *testing.T) {
	var state raftState
	state.setLastSnapshot(10, 3)
	// A background snapshot captured at index 2 can finish after a remote
	// snapshot at 10. Its publication must not rewind the cached stable bound.
	state.setLastSnapshot(2, 1)
	index, term := state.getLastSnapshot()
	require.Equal(t, uint64(10), index)
	require.Equal(t, uint64(3), term)
}

type countedCloseTransport struct {
	Transport
	closes int
}

func (t *countedCloseTransport) Close() error { t.closes++; return nil }

func TestLocalRepeatedShutdownStillJoinsAndClosesTransport(t *testing.T) {
	transport := &countedCloseTransport{}
	r := &Raft{trans: transport, shutdownCh: make(chan struct{})}
	initiated := r.Shutdown()                // A storage-error path initiates shutdown itself.
	require.NoError(t, r.Shutdown().Error()) // The owning process must still join.
	require.Equal(t, 1, transport.closes, "repeated shutdown returned before closing transport")
	require.NoError(t, initiated.Error())
	require.Equal(t, 1, transport.closes, "transport was closed twice")
}

func TestLocalSnapshotDeleteFailureRequiresRestartReconciliation(t *testing.T) {
	store := &flakyDeletes{LogStore: newBoltLikeLogStore()}
	f := newTestFollowerOn(t, store, 2, confLog(), cmd(2, 1, "committed"), cmd(3, 2, "stale"))
	f.appendEntries(t, AppendEntriesRequest{Term: 3, PrevLogEntry: 2, PrevLogTerm: 1, LeaderCommitIndex: 2})
	store.mu.Lock()
	store.fails = 1
	store.mu.Unlock()
	response, err := f.sendSnapshot(3, 10, 3)
	require.Error(t, err)
	require.False(t, response.Success)
	snapshots, err := f.r.snapshots.List()
	require.NoError(t, err)
	require.Len(t, snapshots, 1, "replacement must be durable before cleanup")
	require.Equal(t, Shutdown, f.r.State(), "uncertain storage cleanup must fail closed until restart")
	f.restart(t)
	var stale Log
	require.ErrorIs(t, f.store.GetLog(3, &stale), ErrLogNotFound, "restart left a divergent durable entry")
	f.appendEntries(t, AppendEntriesRequest{Term: 3, PrevLogEntry: 10, PrevLogTerm: 3, LeaderCommitIndex: 11, Entries: []*Log{cmd(11, 3, "after-restart")}})
	f.fsm.waitApplied(t, 11)
}

func TestLocalInterruptedSnapshotPreservesUnconfirmedDurableSuffix(t *testing.T) {
	f := newTestFollower(t, 2, cmd(2, 2, "possibly-globally-committed"))
	f.appendEntries(t, AppendEntriesRequest{Term: 3, PrevLogEntry: 1, PrevLogTerm: 1, LeaderCommitIndex: 1})
	var response InstallSnapshotResponse
	err := f.leader.InstallSnapshot("f", "f", &InstallSnapshotRequest{RPCHeader: f.header(), SnapshotVersion: SnapshotVersionMax, Term: 3, LastLogIndex: 10, LastLogTerm: 3,
		Configuration: EncodeConfiguration(testFollowerConf), ConfigurationIndex: 1, Size: 8}, &response, iotest.ErrReader(io.ErrUnexpectedEOF))
	require.Error(t, err)
	var retained Log
	require.NoError(t, f.store.GetLog(2, &retained), "interrupted transfer discarded a possibly committed entry")
	require.Equal(t, "possibly-globally-committed", string(retained.Data))
}

func TestLocalMatchingSnapshotRetainsPendingConfiguration(t *testing.T) {
	next := testFollowerConf.Clone()
	next.Servers = append(next.Servers, Server{ID: "n", Address: "n", Suffrage: Nonvoter})
	f := newTestFollower(t, 1, cmd(2, 1, "a"), cmd(3, 1, "b"), &Log{Index: 4, Term: 1, Type: LogConfiguration, Data: EncodeConfiguration(next)}, cmd(5, 1, "c"))
	f.appendEntries(t, AppendEntriesRequest{Term: 1, PrevLogEntry: 2, PrevLogTerm: 1, LeaderCommitIndex: 2})
	f.installSnapshot(t, 1, 3, 1)
	configuration := f.r.GetConfiguration()
	require.NoError(t, configuration.Error())
	require.Equal(t, next, configuration.Configuration(), "matching snapshot discarded the retained pending membership")
	f.appendEntries(t, AppendEntriesRequest{Term: 1, PrevLogEntry: 3, PrevLogTerm: 1, LeaderCommitIndex: 5, Entries: []*Log{
		{Index: 4, Term: 1, Type: LogConfiguration, Data: EncodeConfiguration(next)}, cmd(5, 1, "c"),
	}})
	f.fsm.waitApplied(t, 5)
	require.Equal(t, uint64(4), f.r.configurations.committedIndex)
	require.Equal(t, next, f.r.configurations.committed)
}
