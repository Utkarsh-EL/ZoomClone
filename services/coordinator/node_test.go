package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

const testToken = "local-test-cluster-token-at-least-32-bytes"

func eventually(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition did not become true within 15 seconds")
}

func testCluster(t *testing.T, count int) ([]*node, []nodeConfig) {
	t.Helper()
	nodes := make([]*node, count)
	configs := make([]nodeConfig, count)
	servers := make([]raft.Server, count)
	for i := range configs {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ln.Close() })
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", i+1)
		configs[i] = nodeConfig{Cluster: clusterID, ID: id, Address: ln.Addr().String(), Listener: ln,
			DataDir: filepath.Join(t.TempDir(), "state"), New: true, Token: testToken, Output: io.Discard}
		servers[i] = raft.Server{ID: raft.ServerID(id), Address: raft.ServerAddress(ln.Addr().String()), Suffrage: raft.Voter}
	}
	for i := range nodes {
		configs[i].Bootstrap = servers
		var err error
		nodes[i], err = openNode(configs[i])
		if err != nil {
			t.Fatal(err)
		}
		j := i
		t.Cleanup(func() {
			if nodes[j] != nil {
				nodes[j].close()
			}
		})
	}
	return nodes, configs
}

func leader(t *testing.T, nodes []*node) *node {
	t.Helper()
	var found *node
	eventually(t, func() bool {
		for _, n := range nodes {
			if n != nil && n.raft.State() == raft.Leader {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				_, err := n.control(ctx, controlRequest{Operation: "read"})
				cancel()
				if err == nil {
					found = n
					return true
				}
			}
		}
		return false
	})
	return found
}

func call(t *testing.T, n *node, r controlRequest) any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	value, err := n.control(ctx, r)
	if err != nil {
		t.Fatal(r.Operation, err)
	}
	return value
}

func TestFiveVotersRecoverLeaderAndDurableSnapshot(t *testing.T) {
	nodes, configs := testCluster(t, 5)
	l := leader(t, nodes)
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "retained"}
	first := call(t, l, controlRequest{Operation: "apply", Command: &c}).(Result)
	if first.Code != "OK" {
		t.Fatal(first)
	}
	var lost int
	for i, n := range nodes {
		if n == l {
			lost = i
			break
		}
	}
	nodes[lost].close()
	nodes[lost] = nil
	l = leader(t, nodes)
	if got := call(t, l, controlRequest{Operation: "apply", Command: &c}).(Result); got != first {
		t.Fatal("lost stable outcome", got)
	}
	for i := range 40 {
		id := fmt.Sprintf("20000000-0000-4000-8000-%012d", i)
		x := Command{ID: id, Kind: "reserve", MeetingID: id, Code: fmt.Sprintf("room-%d", i)}
		call(t, l, controlRequest{Operation: "apply", Command: &x})
	}
	call(t, l, controlRequest{Operation: "snapshot"})
	config := configs[lost]
	config.New, config.Bootstrap, config.Listener = false, nil, nil
	var err error
	nodes[lost], err = openNode(config)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return len(nodes[lost].meta.view().Meetings) == 41 })
	installed, err := os.ReadDir(filepath.Join(config.DataDir, "snapshots"))
	if err != nil || len(installed) == 0 {
		t.Fatal("follower did not install a snapshot", err)
	}
	if got := nodes[lost].meta.view().Outcomes[meetingID].Result; got != first {
		t.Fatal("snapshot lost original outcome", got)
	}
	if nodes[lost].wire.incarnation == l.wire.incarnation {
		t.Fatal("processes share incarnation")
	}
}

func TestFourVotersNeverShrinkQuorumOnFailure(t *testing.T) {
	nodes, _ := testCluster(t, 4)
	l := leader(t, nodes)
	stopped := 0
	for i, n := range nodes {
		if n != l && stopped < 2 {
			n.close()
			nodes[i] = nil
			stopped++
		}
	}
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "minority"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := l.control(ctx, controlRequest{Operation: "apply", Command: &c}); err == nil {
		t.Fatal("two of four authorized a write")
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if _, err := l.control(ctx2, controlRequest{Operation: "read"}); err == nil {
		t.Fatal("minority returned authoritative state")
	}
	f := l.raft.GetConfiguration()
	if err := f.Error(); err != nil {
		t.Fatal(err)
	}
	if len(f.Configuration().Servers) != 4 {
		t.Fatal("reachability changed configuration")
	}
}

func TestMembershipRequiresConfigurationIndexAndNonvoterAdmission(t *testing.T) {
	nodes, configs := testCluster(t, 4)
	l := leader(t, nodes)
	cfg := configs[0]
	cfg.ID, cfg.Address, cfg.Listener, cfg.Bootstrap = "10000000-0000-4000-8000-000000000005", "127.0.0.1:0", nil, nil
	cfg.DataDir = filepath.Join(t.TempDir(), "joining")
	joining, err := openNode(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer joining.close()
	configuration := call(t, l, controlRequest{Operation: "configuration"}).(configurationView)
	r := controlRequest{Operation: "promote", NodeID: cfg.ID, Address: joining.address, ExpectedIndex: configuration.Index}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := l.control(ctx, r); err == nil {
		t.Fatal("unadmitted voter promoted")
	}
	r.Operation = "add-nonvoter"
	call(t, l, r)
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	r.Operation = "promote"
	if _, err := l.control(ctx2, r); err == nil {
		t.Fatal("stale configuration index accepted")
	}
	eventually(t, func() bool { return joining.raft.AppliedIndex() >= configuration.Index })
	r.ExpectedIndex = call(t, l, controlRequest{Operation: "configuration"}).(configurationView).Index
	call(t, l, r)
	view := call(t, l, controlRequest{Operation: "configuration"}).(configurationView)
	if view.Voters != 5 || view.Quorum != 3 {
		t.Fatal(view)
	}
	r.Operation, r.ExpectedIndex = "remove", view.Index
	call(t, l, r)
	view = call(t, l, controlRequest{Operation: "configuration"}).(configurationView)
	if view.Voters != 4 || view.Quorum != 3 {
		t.Fatal(view)
	}
}

func TestRestartRejectsMissingOrMismatchedIdentity(t *testing.T) {
	nodes, configs := testCluster(t, 1)
	nodes[0].close()
	nodes[0] = nil
	cfg := configs[0]
	cfg.New, cfg.Listener, cfg.Bootstrap = false, nil, nil
	cfg.ID = meetingID
	if n, err := openNode(cfg); err == nil {
		n.close()
		t.Fatal("identity mismatch accepted")
	}
	cfg.ID = configs[0].ID
	cfg.DataDir = filepath.Join(t.TempDir(), "missing")
	if n, err := openNode(cfg); err == nil {
		n.close()
		t.Fatal("missing storage silently initialized")
	}
}

func TestRestartRejectsLostStoreAndDuplicateProcess(t *testing.T) {
	nodes, configs := testCluster(t, 1)
	bad := configs[0]
	bad.Address, bad.Listener, bad.New = "127.0.0.1:0", nil, true
	if n, err := openNode(bad); err == nil {
		n.close()
		t.Fatal("second initialization reused a directory")
	}
	nodes[0].close()
	nodes[0] = nil
	bad = configs[0]
	bad.New, bad.Listener, bad.Bootstrap = false, nil, nil
	if err := os.Remove(filepath.Join(bad.DataDir, "raft.db")); err != nil {
		t.Fatal(err)
	}
	if n, err := openNode(bad); err == nil {
		n.close()
		t.Fatal("lost database was silently recreated")
	}
}
