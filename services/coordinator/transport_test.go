package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

func TestControlBoundaryRejectsMissingAuthStampsAndWrongCluster(t *testing.T) {
	nodes, _ := testCluster(t, 1)
	n := nodes[0]
	valid := envelope{Version: 2, ClusterID: clusterID, NodeID: meetingID, Incarnation: incarnation,
		RequestID: attemptID, Lamport: 8, Kind: "control", Body: json.RawMessage(`{"operation":"status"}`)}
	cases := []struct {
		name   string
		change func(*envelope)
		token  string
		want   int
	}{
		{"valid", func(e *envelope) {}, testToken, 200},
		{"no auth", func(e *envelope) {}, "wrong", 401},
		{"wrong cluster", func(e *envelope) { e.ClusterID = runtimeID }, testToken, 400},
		{"no logical time", func(e *envelope) { e.Lamport = 0 }, testToken, 400},
		{"no incarnation", func(e *envelope) { e.Incarnation = "" }, testToken, 400},
		{"no request ID", func(e *envelope) { e.RequestID = "" }, testToken, 400},
		{"legacy unsafe helper version", func(e *envelope) { e.Version = 1 }, testToken, 400},
		{"wrong version", func(e *envelope) { e.Version = 3 }, testToken, 400},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := valid
			c.change(&e)
			b, _ := json.Marshal(e)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "POST", "http://"+n.address+"/v1/control", bytes.NewReader(append(b, '\n')))
			req.Header.Set("Authorization", "Bearer "+c.token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != c.want {
				t.Fatal(resp.StatusCode, c.want)
			}
			if c.want == 200 {
				var reply envelope
				if err := json.NewDecoder(resp.Body).Decode(&reply); err != nil {
					t.Fatal(err)
				}
				if reply.Lamport <= 8 || reply.RequestID != attemptID || reply.NodeID != n.cfg.ID || reply.Kind != "control.reply" {
					t.Fatal(reply)
				}
			}
		})
	}
}

func TestHeartbeatUsesSerializedConsensusConsumer(t *testing.T) {
	n, err := openNode(nodeConfig{Cluster: clusterID, ID: runtimeID, Address: "127.0.0.1:0", DataDir: filepath.Join(t.TempDir(), "state"), New: true, Token: testToken, Output: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	defer n.close()
	var bypass atomic.Int64
	n.transport.SetHeartbeatHandler(func(rpc raft.RPC) {
		bypass.Add(1)
		rpc.Respond(&raft.AppendEntriesResponse{Term: 1, Success: true}, nil)
	})
	sender := newTransport(&wire{cluster: clusterID, id: meetingID, incarnation: incarnation, token: testToken}, "127.0.0.1:7901")
	defer sender.Close()
	var response raft.AppendEntriesResponse
	if err := sender.AppendEntries(raft.ServerID(runtimeID), raft.ServerAddress(n.address), &raft.AppendEntriesRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: raft.ProtocolVersionMax, ID: []byte(meetingID), Addr: []byte("127.0.0.1:7901")}, Term: 1}, &response); err != nil {
		t.Fatal(err)
	}
	if bypass.Load() != 0 || n.raft.CurrentTerm() != 1 {
		t.Fatal("heartbeat bypassed the serialized state transition", bypass.Load(), n.raft.CurrentTerm())
	}
}

func TestSnapshotLimitAndNoUnstampedPipeline(t *testing.T) {
	nodes, _ := testCluster(t, 1)
	n := nodes[0]
	if _, err := n.transport.AppendEntriesPipeline(raft.ServerID(meetingID), raft.ServerAddress(n.address)); err != raft.ErrPipelineReplicationNotSupported {
		t.Fatal(err)
	}
	if err := n.transport.InstallSnapshot(raft.ServerID(meetingID), raft.ServerAddress(n.address), &raft.InstallSnapshotRequest{Size: maxSnapshotBytes + 1}, &raft.InstallSnapshotResponse{}, bytes.NewReader(nil)); err == nil {
		t.Fatal("oversized snapshot was accepted")
	}
}
