package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/hashicorp/raft"
)

// These tests feed a follower the RPC sequence at a partition boundary. The
// senders stand in for the old minority leader and the new majority leader;
// they do not implement an election or assert that a real partition occurred.
// All RPCs cross the helper's authenticated HTTP boundary and reach the pinned
// library with the production Bolt store and metadata FSM.
type safetyFollower struct {
	node          *node
	old, current  *httpTransport
	configuration raft.Configuration
}

func newSafetyFollower(t *testing.T) *safetyFollower {
	t.Helper()
	if os.Getenv("ZOOM_RAFT_SAFETY_AUDIT") != "1" {
		t.Skip("known-failing Raft v1.8.0 safety audit (#733/#721/#697); set ZOOM_RAFT_SAFETY_AUDIT=1 and run go test -run '^TestRaftSafety' -v to reproduce; skipped coverage does not establish safety")
	}
	n, err := openNode(nodeConfig{Cluster: clusterID, ID: "10000000-0000-4000-8000-000000000003",
		Address: "127.0.0.1:0", DataDir: filepath.Join(t.TempDir(), "state"),
		New: true, Token: testToken, Output: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(n.close)
	makeSender := func(id, address string) *httpTransport {
		sender := newTransport(&wire{cluster: clusterID, id: id, incarnation: newUUID(), token: testToken, output: io.Discard}, address)
		t.Cleanup(func() { _ = sender.Close() })
		return sender
	}
	s := &safetyFollower{node: n,
		old:     makeSender("10000000-0000-4000-8000-000000000001", "127.0.0.1:1"),
		current: makeSender("10000000-0000-4000-8000-000000000002", "127.0.0.1:2")}
	s.configuration = raft.Configuration{Servers: []raft.Server{
		{ID: raft.ServerID(s.old.wire.id), Address: s.old.LocalAddr(), Suffrage: raft.Voter},
		{ID: raft.ServerID(s.current.wire.id), Address: s.current.LocalAddr(), Suffrage: raft.Voter},
		{ID: raft.ServerID(n.cfg.ID), Address: raft.ServerAddress(n.address), Suffrage: raft.Voter},
	}}
	if !s.append(t, s.old, 1, 0, 0, 1, &raft.Log{Index: 1, Term: 1, Type: raft.LogConfiguration, Data: raft.EncodeConfiguration(s.configuration)}) {
		t.Fatal("initial committed configuration rejected")
	}
	return s
}

func (s *safetyFollower) append(t *testing.T, sender *httpTransport, term, previous, previousTerm, commit uint64, entries ...*raft.Log) bool {
	t.Helper()
	request := &raft.AppendEntriesRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: raft.ProtocolVersionMax,
		ID: []byte(sender.wire.id), Addr: []byte(sender.address)},
		Term: term, PrevLogEntry: previous, PrevLogTerm: previousTerm, LeaderCommitIndex: commit, Entries: entries}
	var response raft.AppendEntriesResponse
	if err := sender.AppendEntries(raft.ServerID(s.node.cfg.ID), raft.ServerAddress(s.node.address), request, &response); err != nil {
		t.Fatal(err)
	}
	return response.Success
}

func safetyReservation(t *testing.T, index, term uint64, id, code string) *raft.Log {
	t.Helper()
	data, err := json.Marshal(Command{ID: id, Kind: "reserve", MeetingID: id, Code: code})
	if err != nil {
		t.Fatal(err)
	}
	return &raft.Log{Index: index, Term: term, Type: raft.LogCommand, Data: data}
}

// https://github.com/hashicorp/raft/issues/733: a request built before the new
// leader's no-op can have an empty Entries slice but a later commit watermark.
// Only its matching prefix is proven; the old leader's suffix is uncommitted.
func TestRaftSafetyCommitOnlyAppendDoesNotApplyDivergentSuffix(t *testing.T) {
	s := newSafetyFollower(t)
	stale := safetyReservation(t, 2, 2, meetingID, "never-committed")
	if !s.append(t, s.old, 2, 1, 1, 1, stale) {
		t.Fatal("old leader suffix rejected")
	}
	if s.node.raft.CommitIndex() != 1 || len(s.node.meta.view().Meetings) != 0 {
		t.Fatal("fixture committed the old leader's suffix")
	}
	if !s.append(t, s.current, 3, 1, 1, 2) {
		t.Fatal("new leader's commit-only append rejected")
	}
	// Deliver the new leader's actual no-op and then a committed command. Waiting
	// for that command also drains prior FSM work, avoiding an async-apply race.
	correct := safetyReservation(t, 3, 3, runtimeID, "committed")
	if !s.append(t, s.current, 3, 1, 1, 3, &raft.Log{Index: 2, Term: 3, Type: raft.LogNoop}, correct) {
		t.Fatal("replacement majority suffix rejected")
	}
	eventually(t, func() bool { _, ok := s.node.meta.view().Outcomes[runtimeID]; return ok })
	if outcome, ok := s.node.meta.view().Outcomes[meetingID]; ok {
		t.Fatalf("uncommitted old-leader reservation reached metadata FSM and survived log correction: %+v", outcome.Result)
	}
}

func (s *safetyFollower) snapshot(t *testing.T, index uint64) {
	t.Helper()
	// This snapshot is the majority's state: the old leader's reservation never
	// committed, so the metadata contains no meetings.
	state := newMetadata(clusterID)
	state.StoreConfiguration(1, s.configuration)
	data, err := json.Marshal(state.view())
	if err != nil {
		t.Fatal(err)
	}
	request := &raft.InstallSnapshotRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: raft.ProtocolVersionMax,
		ID: []byte(s.current.wire.id), Addr: []byte(s.current.address)},
		SnapshotVersion: raft.SnapshotVersionMax, Term: 3, LastLogIndex: index, LastLogTerm: 3,
		Configuration: raft.EncodeConfiguration(s.configuration), ConfigurationIndex: 1, Size: int64(len(data))}
	var response raft.InstallSnapshotResponse
	if err := s.current.InstallSnapshot(raft.ServerID(s.node.cfg.ID), raft.ServerAddress(s.node.address), request, &response, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if !response.Success {
		t.Fatal("majority snapshot rejected")
	}
}

// https://github.com/hashicorp/raft/issues/697: retaining a conflicting entry at
// the snapshot boundary causes subsequent replication to reject a valid prefix.
func TestRaftSafetySnapshotDiscardsConflictingBoundary(t *testing.T) {
	s := newSafetyFollower(t)
	if !s.append(t, s.old, 2, 1, 1, 1,
		safetyReservation(t, 2, 2, meetingID, "never-committed"),
		&raft.Log{Index: 3, Term: 2, Type: raft.LogNoop},
		&raft.Log{Index: 4, Term: 2, Type: raft.LogNoop}) {
		t.Fatal("old leader suffix rejected")
	}
	s.snapshot(t, 3)
	if !s.append(t, s.current, 3, 3, 3, 4, &raft.Log{Index: 4, Term: 3, Type: raft.LogNoop}) {
		t.Fatal("valid append after installed snapshot rejected: conflicting boundary survived snapshot installation")
	}
}

// https://github.com/hashicorp/raft/issues/721: when the snapshot is beyond the
// old suffix, there is no boundary entry to compare, but the never-committed
// entries must still be discarded. Retaining these enables a later leader to
// serve them to a new follower. This checks the retention prerequisite directly;
// it does not claim to reproduce the later election/admission sequence.
func TestRaftSafetySnapshotDiscardsDivergentEntriesBelowSnapshot(t *testing.T) {
	s := newSafetyFollower(t)
	if !s.append(t, s.old, 2, 1, 1, 1, safetyReservation(t, 2, 2, meetingID, "never-committed")) {
		t.Fatal("old leader suffix rejected")
	}
	s.snapshot(t, 4)
	var retained raft.Log
	if err := s.node.store.GetLog(2, &retained); err == nil {
		t.Fatalf("snapshot retained never-committed divergent command below its boundary: index=%d term=%d data=%s", retained.Index, retained.Term, retained.Data)
	} else if err != raft.ErrLogNotFound {
		t.Fatal(err)
	}
}
