package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

// Test-only TCP fault infrastructure. Closing both socket directions also cuts
// pooled HTTP connections, so existing connections cannot bypass a partition.
type cutProxy struct {
	listener    net.Listener
	target      string
	mu          sync.Mutex
	cut, closed bool
	connections map[net.Conn]bool
	workers     sync.WaitGroup
}

func newCutProxy(t *testing.T, target string) *cutProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &cutProxy{listener: listener, target: target, connections: map[net.Conn]bool{}}
	p.workers.Add(1)
	go func() {
		defer p.workers.Done()
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			if p.cut || p.closed {
				p.mu.Unlock()
				connection.Close()
				continue
			}
			p.connections[connection] = true
			p.workers.Add(1)
			p.mu.Unlock()
			go p.forward(connection)
		}
	}()
	t.Cleanup(p.close)
	return p
}
func (p *cutProxy) forward(front net.Conn) {
	defer p.workers.Done()
	defer front.Close()
	back, err := net.DialTimeout("tcp", p.target, 500*time.Millisecond)
	if err != nil {
		p.mu.Lock()
		delete(p.connections, front)
		p.mu.Unlock()
		return
	}
	defer back.Close()
	p.mu.Lock()
	if p.cut || p.closed {
		delete(p.connections, front)
		p.mu.Unlock()
		return
	}
	p.connections[back] = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.connections, front); delete(p.connections, back); p.mu.Unlock() }()
	done := make(chan struct{})
	go func() { _, _ = io.Copy(back, front); _ = back.Close(); close(done) }()
	_, _ = io.Copy(front, back)
	_ = front.Close()
	_ = back.Close()
	<-done
}
func (p *cutProxy) setCut(cut bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cut = cut
	if cut {
		for connection := range p.connections {
			_ = connection.Close()
		}
	}
}
func (p *cutProxy) close() {
	p.mu.Lock()
	p.closed = true
	_ = p.listener.Close()
	for connection := range p.connections {
		_ = connection.Close()
	}
	p.mu.Unlock()
	p.workers.Wait()
}

func partitionCluster(t *testing.T) ([]*node, []nodeConfig, [][]*cutProxy) {
	t.Helper()
	const count = 5
	nodes := make([]*node, count)
	configs := make([]nodeConfig, count)
	servers := make([]raft.Server, count)
	proxies := make([][]*cutProxy, count)
	for i := range count {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { listener.Close() })
		id := fmt.Sprintf("30000000-0000-4000-8000-%012d", i+1)
		configs[i] = nodeConfig{Cluster: clusterID, ID: id, Address: listener.Addr().String(), Listener: listener, DataDir: filepath.Join(t.TempDir(), "state"), New: true, Token: testToken, Output: io.Discard, Routes: map[string]string{}}
		servers[i] = raft.Server{ID: raft.ServerID(id), Address: raft.ServerAddress(configs[i].Address), Suffrage: raft.Voter}
	}
	for i := range count {
		proxies[i] = make([]*cutProxy, count)
		for j := range count {
			if i == j {
				continue
			}
			proxy := newCutProxy(t, configs[j].Address)
			proxies[i][j] = proxy
			configs[i].Routes[configs[j].Address] = proxy.listener.Addr().String()
		}
	}
	for i := range count {
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
	return nodes, configs, proxies
}

func TestFiveVoterPartitionHealsWithoutMinorityOutcomes(t *testing.T) {
	nodes, configs, proxies := partitionCluster(t)
	old := leader(t, nodes)
	oldIndex := 0
	for i, n := range nodes {
		if n == old {
			oldIndex = i
			break
		}
	}
	partner := (oldIndex + 1) % len(nodes)
	minority := func(index int) bool { return index == oldIndex || index == partner }
	for from, row := range proxies {
		for to, proxy := range row {
			if proxy != nil && minority(from) != minority(to) {
				proxy.setCut(true)
			}
		}
	}
	stale := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "partition-name"}
	oldReply := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, err := old.control(ctx, controlRequest{Operation: "apply", Command: &stale})
		oldReply <- err
	}()
	eventually(t, func() bool {
		last, err := old.store.LastIndex()
		if err != nil {
			return false
		}
		first, err := old.store.FirstIndex()
		if err != nil {
			return false
		}
		for index := first; index <= last && first != 0; index++ {
			var entry raft.Log
			if old.store.GetLog(index, &entry) == nil && entry.Type == raft.LogCommand {
				var command Command
				if json.Unmarshal(entry.Data, &command) == nil && command.ID == meetingID {
					return true
				}
			}
		}
		return false
	})
	var majority []*node
	for i, n := range nodes {
		if !minority(i) {
			majority = append(majority, n)
		}
	}
	current := leader(t, majority)
	committed := Command{ID: attemptID, Kind: "reserve", MeetingID: runtimeID, Code: "partition-name"}
	if result := call(t, current, controlRequest{Operation: "apply", Command: &committed}).(Result); result.Code != "OK" {
		t.Fatal("minority reservation escaped its partition", result)
	}
	if err := <-oldReply; err == nil {
		t.Fatal("two configured voters acknowledged a command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	_, err := old.control(ctx, controlRequest{Operation: "read"})
	cancel()
	if err == nil {
		t.Fatal("isolated old leader served authoritative state")
	}
	for i := range 40 {
		id := fmt.Sprintf("40000000-0000-4000-8000-%012d", i)
		c := Command{ID: id, Kind: "reserve", MeetingID: id, Code: fmt.Sprintf("partition-tail-%d", i)}
		if result := call(t, current, controlRequest{Operation: "apply", Command: &c}).(Result); result.Code != "OK" {
			t.Fatal(result)
		}
	}
	call(t, current, controlRequest{Operation: "snapshot"})
	for _, row := range proxies {
		for _, proxy := range row {
			if proxy != nil {
				proxy.setCut(false)
			}
		}
	}
	for _, n := range nodes {
		eventually(t, func() bool { return len(n.meta.view().Meetings) == 41 })
		if _, exists := n.meta.view().Outcomes[meetingID]; exists {
			t.Fatal("never-committed minority outcome entered the FSM", n.cfg.ID)
		}
		configuration := call(t, n, controlRequest{Operation: "status"}).(statusView).Configuration
		if configuration.Voters != 5 || configuration.Quorum != 3 {
			t.Fatal("partition changed voting membership", configuration)
		}
	}
	old.close()
	nodes[oldIndex] = nil
	restart := configs[oldIndex]
	restart.New, restart.Listener, restart.Bootstrap = false, nil, nil
	nodes[oldIndex], err = openNode(restart)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return len(nodes[oldIndex].meta.view().Meetings) == 41 })
	if _, exists := nodes[oldIndex].meta.view().Outcomes[meetingID]; exists {
		t.Fatal("ghost outcome returned after durable restart")
	}
	current = leader(t, nodes)
	configuration := call(t, current, controlRequest{Operation: "configuration"}).(configurationView)
	var remove *node
	for _, n := range nodes {
		if n != current {
			remove = n
			break
		}
	}
	call(t, current, controlRequest{Operation: "remove", NodeID: remove.cfg.ID, ExpectedIndex: configuration.Index})
	configuration = call(t, current, controlRequest{Operation: "configuration"}).(configurationView)
	if configuration.Voters != 4 || configuration.Quorum != 3 {
		t.Fatal("post-recovery even membership is wrong", configuration)
	}
}
