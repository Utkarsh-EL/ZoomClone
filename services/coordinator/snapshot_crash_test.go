package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/hashicorp/go-hclog"
	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
)

type publicationPauseStore struct {
	raft.SnapshotStore
	stage, ready string
}
type publicationPauseSink struct {
	raft.SnapshotSink
	stage, ready string
}

func (s *publicationPauseStore) Create(v raft.SnapshotVersion, index, term uint64, c raft.Configuration, ci uint64, transport raft.Transport) (raft.SnapshotSink, error) {
	sink, err := s.SnapshotStore.Create(v, index, term, c, ci, transport)
	if err != nil {
		return nil, err
	}
	return &publicationPauseSink{SnapshotSink: sink, stage: s.stage, ready: s.ready}, nil
}
func (s *publicationPauseSink) Close() error {
	if s.stage == "before-publish" {
		if err := os.WriteFile(s.ready, []byte("ready"), 0600); err != nil {
			return err
		}
		select {}
	}
	if err := s.SnapshotSink.Close(); err != nil {
		return err
	}
	if err := os.WriteFile(s.ready, []byte("ready"), 0600); err != nil {
		return err
	}
	select {}
}

var crashConfiguration = raft.Configuration{Servers: []raft.Server{{ID: "f", Address: "f", Suffrage: raft.Voter}, {ID: "l", Address: "l", Suffrage: raft.Voter}, {ID: "g", Address: "g", Suffrage: raft.Voter}}}

func crashFollower(t *testing.T, dir string, snapshots raft.SnapshotStore) (*raft.Raft, *raftboltdb.BoltStore, *metadata, *raft.InmemTransport) {
	t.Helper()
	store, err := raftboltdb.NewBoltStore(filepath.Join(dir, "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	if snapshots == nil {
		snapshots, err = raft.NewFileSnapshotStore(dir, 3, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, receiver := raft.NewInmemTransport("f")
	_, sender := raft.NewInmemTransport("l")
	sender.Connect("f", receiver)
	receiver.Connect("l", sender)
	config := raft.DefaultConfig()
	config.LocalID = "f"
	config.Logger = hclog.NewNullLogger()
	config.HeartbeatTimeout = time.Minute
	config.ElectionTimeout = time.Minute
	config.LeaderLeaseTimeout = time.Minute
	config.TrailingLogs = 8
	state := newMetadata(clusterID)
	r, err := raft.NewRaft(config, state, store, store, snapshots, receiver)
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Shutdown().Error(); _ = store.Close() })
	return r, store, state, sender
}

func crashAppend(t *testing.T, sender *raft.InmemTransport, previous, previousTerm, commit uint64, entries ...*raft.Log) {
	t.Helper()
	var response raft.AppendEntriesResponse
	err := sender.AppendEntries("f", "f", &raft.AppendEntriesRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: raft.ProtocolVersionMax, ID: []byte("l"), Addr: []byte("l")}, Term: 3,
		PrevLogEntry: previous, PrevLogTerm: previousTerm, LeaderCommitIndex: commit, Entries: entries}, &response)
	if err != nil || !response.Success {
		t.Fatalf("append failed: %+v %v", response, err)
	}
}

// Invoked only by the parent test so it can kill a real process at a precise
// FileSnapshotStore publication boundary, with a real fsynced Bolt log store.
func TestSnapshotPublicationCrashChild(t *testing.T) {
	stage := os.Getenv("ZOOM_SNAPSHOT_CRASH_STAGE")
	if stage == "" {
		t.Skip("subprocess fixture")
	}
	dir := os.Getenv("ZOOM_SNAPSHOT_CRASH_DIR")
	files, err := raft.NewFileSnapshotStore(dir, 3, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	_, store, state, sender := crashFollower(t, dir, &publicationPauseStore{SnapshotStore: files, stage: stage, ready: filepath.Join(dir, "ready")})
	data, _ := json.Marshal(Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "committed"})
	crashAppend(t, sender, 0, 0, 2, &raft.Log{Index: 1, Term: 1, Type: raft.LogConfiguration, Data: raft.EncodeConfiguration(crashConfiguration)}, &raft.Log{Index: 2, Term: 1, Type: raft.LogCommand, Data: data})
	eventually(t, func() bool { return len(state.view().Meetings) == 1 })
	stale, _ := json.Marshal(Command{ID: runtimeID, Kind: "reserve", MeetingID: runtimeID, Code: "never-committed"})
	crashAppend(t, sender, 2, 1, 2, &raft.Log{Index: 3, Term: 2, Type: raft.LogCommand, Data: stale})
	if _, ok := state.view().Outcomes[runtimeID]; ok {
		t.Fatal("fixture committed stale entry")
	}
	if last, err := store.LastIndex(); err != nil || last != 3 {
		t.Fatal(last, err)
	}
	stateBytes, _ := json.Marshal(state.view())
	var response raft.InstallSnapshotResponse
	err = sender.InstallSnapshot("f", "f", &raft.InstallSnapshotRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: raft.ProtocolVersionMax, ID: []byte("l"), Addr: []byte("l")},
		SnapshotVersion: raft.SnapshotVersionMax, Term: 3, LastLogIndex: 10, LastLogTerm: 3, Configuration: raft.EncodeConfiguration(crashConfiguration), ConfigurationIndex: 1, Size: int64(len(stateBytes))}, &response, bytes.NewReader(stateBytes))
	t.Fatal("publication barrier did not stop the child", response, err)
}

func TestSnapshotPublicationCrashRecovery(t *testing.T) {
	for _, stage := range []string{"before-publish", "after-publish"} {
		t.Run(stage, func(t *testing.T) {
			dir := t.TempDir()
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			log, err := os.Create(filepath.Join(dir, "child.log"))
			if err != nil {
				t.Fatal(err)
			}
			defer log.Close()
			child := exec.Command(binary, "-test.run=^TestSnapshotPublicationCrashChild$", "-test.timeout=30s")
			child.Env = append(os.Environ(), "ZOOM_SNAPSHOT_CRASH_STAGE="+stage, "ZOOM_SNAPSHOT_CRASH_DIR="+dir)
			child.Stdout = log
			child.Stderr = log
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			closed := make(chan error, 1)
			go func() { closed <- child.Wait() }()
			defer func() { _ = child.Process.Kill() }()
			deadline := time.NewTimer(8 * time.Second)
			defer deadline.Stop()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
		readyLoop:
			for {
				select {
				case err := <-closed:
					data, _ := os.ReadFile(filepath.Join(dir, "child.log"))
					t.Fatalf("child exited before barrier: %v %s", err, data)
				case <-deadline.C:
					data, _ := os.ReadFile(filepath.Join(dir, "child.log"))
					t.Fatalf("publication barrier timeout: %s", data)
				case <-ticker.C:
					if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
						break readyLoop
					}
				}
			}
			if err := child.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			<-closed
			r, store, state, sender := crashFollower(t, dir, nil)
			if stage == "after-publish" {
				var retained raft.Log
				if err := store.GetLog(3, &retained); err != raft.ErrLogNotFound {
					t.Fatalf("published snapshot retained divergent durable log after process kill: %v %+v", err, retained)
				}
			}
			previous, term := uint64(2), uint64(1)
			if stage == "after-publish" {
				previous, term = 10, 3
			}
			crashAppend(t, sender, previous, term, previous)
			fresh, _ := json.Marshal(Command{ID: attemptID, Kind: "reserve", MeetingID: attemptID, Code: "after-restart"})
			crashAppend(t, sender, previous, term, previous+1, &raft.Log{Index: previous + 1, Term: 3, Type: raft.LogCommand, Data: fresh})
			eventually(t, func() bool { _, ok := state.view().Outcomes[attemptID]; return ok })
			if _, ok := state.view().Outcomes[runtimeID]; ok {
				t.Fatal("uncommitted entry survived process crash as metadata")
			}
			if len(state.view().Meetings) != 2 {
				t.Fatal("committed prefix was lost", state.view())
			}
			if r.AppliedIndex() < previous+1 {
				t.Fatal("restarted follower did not advance")
			}
		})
	}
}
