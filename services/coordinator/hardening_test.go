package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
)

func TestMalformedRaftRPCNeverReachesLibraryPanics(t *testing.T) {
	header := raft.RPCHeader{ProtocolVersion: 3, ID: []byte(meetingID), Addr: []byte("127.0.0.1:7901")}
	bad := []any{
		&raft.AppendEntriesRequest{RPCHeader: header, Term: 7, Entries: []*raft.Log{nil}},
		&raft.AppendEntriesRequest{RPCHeader: header, Term: 7, Entries: []*raft.Log{{Index: 1, Term: 7, Type: raft.LogConfiguration, Data: []byte("not msgpack")}}},
		&raft.InstallSnapshotRequest{RPCHeader: header, Term: 7, Size: 1, SnapshotVersion: 1, LastLogIndex: 3, LastLogTerm: 7, ConfigurationIndex: 1, Configuration: []byte("not msgpack")},
		&raft.RequestVoteRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: 3, ID: []byte(runtimeID), Addr: header.Addr}, Term: 7},
	}
	for _, rpc := range bad {
		if err := validateRPC(rpc, meetingID); err == nil {
			t.Fatalf("malformed RPC accepted: %+v", rpc)
		}
	}
	nodes, _ := testCluster(t, 1)
	n := leader(t, nodes)
	for _, value := range bad[:3] {
		kind := "raft.append"
		if _, ok := value.(*raft.InstallSnapshotRequest); ok {
			kind = "raft.snapshot"
		}
		body, _ := json.Marshal(value)
		e := envelope{Version: 1, ClusterID: clusterID, NodeID: meetingID, Incarnation: incarnation, RequestID: newUUID(), Lamport: 42, Kind: kind, Body: body}
		b, _ := json.Marshal(e)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "POST", "http://"+n.address+"/v1/raft", bytes.NewReader(append(b, '\n')))
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		resp.Body.Close()
		cancel()
		if resp.StatusCode != 400 {
			t.Fatal("malformed RPC status", resp.StatusCode)
		}
	}
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "still-alive"}
	if got := call(t, n, controlRequest{Operation: "apply", Command: &c}).(Result); got.Code != "OK" {
		t.Fatal(got)
	}
}

func TestAdmittedJoinerRejectsReplacedEmptyStore(t *testing.T) {
	nodes, configs := testCluster(t, 1)
	l := leader(t, nodes)
	cfg := configs[0]
	cfg.ID, cfg.Address, cfg.Listener, cfg.Bootstrap, cfg.DataDir = runtimeID, "127.0.0.1:0", nil, nil, filepath.Join(t.TempDir(), "joiner")
	joining, err := openNode(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer joining.close()
	view := call(t, l, controlRequest{Operation: "configuration"}).(configurationView)
	r := controlRequest{Operation: "add-nonvoter", NodeID: cfg.ID, Address: joining.address, ExpectedIndex: view.Index}
	call(t, l, r)
	r.Operation, r.ExpectedIndex = "promote", call(t, l, controlRequest{Operation: "configuration"}).(configurationView).Index
	call(t, l, r)
	joining.close()
	path := filepath.Join(cfg.DataDir, "raft.db")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	empty, err := raftboltdb.NewBoltStore(path)
	if err != nil {
		t.Fatal(err)
	}
	empty.Close()
	cfg.New, cfg.Address = false, joining.address
	if restarted, err := openNode(cfg); err == nil {
		restarted.close()
		t.Fatal("promoted joiner reused lost voting state")
	}
}

func TestRetainedSnapshotDoesNotExcuseLostStableStore(t *testing.T) {
	nodes, configs := testCluster(t, 1)
	l := leader(t, nodes)
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "snapshot"}
	call(t, l, controlRequest{Operation: "apply", Command: &c})
	call(t, l, controlRequest{Operation: "snapshot"})
	l.close()
	nodes[0] = nil
	path := filepath.Join(configs[0].DataDir, "raft.db")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	empty, err := raftboltdb.NewBoltStore(path)
	if err != nil {
		t.Fatal(err)
	}
	empty.Close()
	cfg := configs[0]
	cfg.New, cfg.Listener, cfg.Bootstrap = false, nil, nil
	if restarted, err := openNode(cfg); err == nil {
		restarted.close()
		t.Fatal("snapshot concealed voting state loss")
	}
}

func TestDurableCausalityAdvancesWireBeforeSend(t *testing.T) {
	for _, snapshot := range []bool{false, true} {
		t.Run(fmt.Sprint(snapshot), func(t *testing.T) {
			w := &wire{cluster: clusterID, id: runtimeID, incarnation: incarnation, output: io.Discard}
			m := newMetadata(clusterID)
			m.observeCausal = w.observe
			c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "clock", LogicalTime: 800}
			if snapshot {
				source := newMetadata(clusterID)
				apply(t, source, 1, c)
				s, _ := source.Snapshot()
				sink := &memorySink{}
				if err := s.Persist(sink); err != nil {
					t.Fatal(err)
				}
				if err := m.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err != nil {
					t.Fatal(err)
				}
			} else {
				apply(t, m, 1, c)
			}
			sent, err := w.packet("control.reply", attemptID, json.RawMessage("null"), nil)
			if err != nil || sent.Lamport <= 800 {
				t.Fatal("durable causal stamp ignored", sent.Lamport, err)
			}
		})
	}
}

func TestWireRejectsClockExhaustionWithoutPoisoningClock(t *testing.T) {
	w := &wire{cluster: clusterID, id: runtimeID, incarnation: incarnation}
	e := envelope{Version: 1, ClusterID: clusterID, NodeID: meetingID, Incarnation: incarnation, RequestID: attemptID, Lamport: maxSafeInteger - 1, Kind: "control", Body: json.RawMessage("null")}
	if err := w.accept(e, "control"); err == nil {
		t.Fatal("near-limit clock poisoned future sends")
	}
	packet, err := w.packet("control.reply", attemptID, json.RawMessage("null"), nil)
	if err != nil || packet.Lamport >= maxSafeInteger {
		t.Fatal("invalid outgoing stamp", packet.Lamport, err)
	}
	w.observe(maxSafeInteger)
	if _, err := w.packet("control.reply", attemptID, json.RawMessage("null"), nil); err == nil {
		t.Fatal("exhausted send silently overflowed")
	}
}

func TestRestartFirstEnvelopeIncludesPersistedCausalHistory(t *testing.T) {
	for _, snapshot := range []bool{false, true} {
		t.Run(fmt.Sprint(snapshot), func(t *testing.T) {
			nodes, configs := testCluster(t, 1)
			l := leader(t, nodes)
			l.wire.observe(800)
			c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "causal-restart"}
			call(t, l, controlRequest{Operation: "apply", Command: &c})
			watermark := l.meta.view().HighWater
			if watermark < 800 {
				t.Fatal("fixture did not persist causal timestamp")
			}
			if snapshot {
				call(t, l, controlRequest{Operation: "snapshot"})
			}
			l.close()
			nodes[0] = nil
			cfg := configs[0]
			cfg.New, cfg.Bootstrap, cfg.Listener = false, nil, nil
			restarted, err := openNode(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.close()
			first, err := restarted.wire.packet("control.reply", attemptID, json.RawMessage("null"), nil)
			if err != nil || first.Lamport <= watermark {
				t.Fatal("startup sent before restoring causal history", first.Lamport, watermark, err)
			}
		})
	}
}

func TestClockSeedingPermitsOnlySnapshotCoveredLogGaps(t *testing.T) {
	store := raft.NewInmemStore()
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "clock", LogicalTime: 900}
	data, _ := json.Marshal(c)
	if err := store.StoreLogs([]*raft.Log{{Index: 1, Term: 1, Type: raft.LogCommand, Data: data}, {Index: 5, Term: 1, Type: raft.LogCommand, Data: data}}); err != nil {
		t.Fatal(err)
	}
	w := &wire{cluster: clusterID, id: runtimeID, incarnation: incarnation}
	if err := seedClockFromLogs(store, w, 4); err != nil {
		t.Fatal("snapshot-covered gap rejected", err)
	}
	if err := seedClockFromLogs(store, w, 0); err == nil {
		t.Fatal("uncovered log gap ignored")
	}
	packet, err := w.packet("control.reply", attemptID, json.RawMessage("null"), nil)
	if err != nil || packet.Lamport <= 900 {
		t.Fatal(packet, err)
	}
}
