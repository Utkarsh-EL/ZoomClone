package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/hashicorp/go-hclog"
	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
	"go.etcd.io/bbolt"
)

type nodeConfig struct {
	Cluster, ID, Address, DataDir, Token string
	New                                  bool
	Bootstrap                            []raft.Server
	Listener                             net.Listener
	Output                               io.Writer
}

type identity struct {
	Version      int    `json:"version"`
	Cluster      string `json:"cluster"`
	ID           string `json:"id"`
	Address      string `json:"address"`
	Bootstrapped bool   `json:"bootstrapped"`
}

type node struct {
	cfg       nodeConfig
	address   string
	raft      *raft.Raft
	meta      *metadata
	wire      *wire
	transport *httpTransport
	store     *raftboltdb.BoltStore
	server    *http.Server
	once      sync.Once
	controls  chan struct{}
}

func openNode(cfg nodeConfig) (_ *node, failure error) {
	if !uuidPattern.MatchString(cfg.Cluster) || !uuidPattern.MatchString(cfg.ID) || len(cfg.Token) < 32 || !loopbackAddress(cfg.Address, cfg.New) || cfg.DataDir == "" {
		return nil, fmt.Errorf("UUID identities, data directory, loopback address and >=32-byte token required")
	}
	if !cfg.New && len(cfg.Bootstrap) != 0 {
		return nil, fmt.Errorf("bootstrap is allowed only during explicit new-node initialization")
	}
	listener := cfg.Listener
	if listener == nil {
		var err error
		listener, err = net.Listen("tcp", cfg.Address)
		if err != nil {
			return nil, err
		}
	}
	defer func() {
		if failure != nil {
			_ = listener.Close()
		}
	}()
	address := listener.Addr().String()
	if !loopbackAddress(address, false) || (cfg.Address != address && !hasZeroPort(cfg.Address)) {
		return nil, fmt.Errorf("listener/address mismatch")
	}
	manifest := identity{Version: 1, Cluster: cfg.Cluster, ID: cfg.ID, Address: address, Bootstrapped: len(cfg.Bootstrap) != 0}
	manifestPath := filepath.Join(cfg.DataDir, "identity.json")
	storePath := filepath.Join(cfg.DataDir, "raft.db")
	if cfg.New {
		if err := validateBootstrap(cfg.Bootstrap, cfg.ID, address); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(cfg.DataDir), 0700); err != nil {
			return nil, err
		}
		if err := os.Mkdir(cfg.DataDir, 0700); err != nil {
			return nil, fmt.Errorf("new node requires a new directory: %w", err)
		}
		file, err := os.OpenFile(manifestPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		err = json.NewEncoder(file).Encode(manifest)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else {
		b, err := os.ReadFile(manifestPath)
		if err != nil {
			return nil, fmt.Errorf("durable identity missing; explicit replacement required: %w", err)
		}
		var old identity
		if decodeStrict(b, &old) != nil || old.Version != 1 || old.Cluster != cfg.Cluster || old.ID != cfg.ID || old.Address != address {
			return nil, fmt.Errorf("durable identity does not match startup configuration")
		}
		manifest = old
		if info, err := os.Stat(storePath); err != nil || info.Size() == 0 {
			return nil, fmt.Errorf("durable Raft store missing; explicit replacement required")
		}
	}
	store, err := raftboltdb.New(raftboltdb.Options{Path: storePath, BoltOptions: &bbolt.Options{Timeout: time.Second}})
	if err != nil {
		return nil, err
	}
	defer func() {
		if failure != nil {
			_ = store.Close()
		}
	}()
	snapshots, err := raft.NewFileSnapshotStore(cfg.DataDir, 3, io.Discard)
	if err != nil {
		return nil, err
	}
	existing, err := raft.HasExistingState(store, store, snapshots)
	if err != nil {
		return nil, err
	}
	if !cfg.New && manifest.Bootstrapped && !existing {
		return nil, fmt.Errorf("Raft state lost; refusing automatic rebootstrap")
	}
	w := &wire{cluster: cfg.Cluster, id: cfg.ID, incarnation: newUUID(), token: cfg.Token, output: cfg.Output}
	transport := newTransport(w, address)
	meta := newMetadata(cfg.Cluster)
	rc := raft.DefaultConfig()
	rc.LocalID = raft.ServerID(cfg.ID)
	rc.Logger = hclog.NewNullLogger()
	rc.HeartbeatTimeout, rc.ElectionTimeout = 500*time.Millisecond, 500*time.Millisecond
	rc.LeaderLeaseTimeout, rc.CommitTimeout = 250*time.Millisecond, 50*time.Millisecond
	rc.TrailingLogs, rc.SnapshotThreshold, rc.SnapshotInterval = 8, 256, 30*time.Second
	r, err := raft.NewRaft(rc, meta, store, store, snapshots, transport)
	if err != nil {
		return nil, err
	}
	defer func() {
		if failure != nil {
			_ = r.Shutdown().Error()
			_ = transport.Close()
		}
	}()
	if cfg.New && len(cfg.Bootstrap) > 0 {
		if err := r.BootstrapCluster(raft.Configuration{Servers: cfg.Bootstrap}).Error(); err != nil {
			return nil, err
		}
	}
	n := &node{cfg: cfg, address: address, raft: r, meta: meta, wire: w, transport: transport, store: store, controls: make(chan struct{}, 32)}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/control", n.serve)
	mux.HandleFunc("/v1/raft", n.serve)
	n.server = &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 12 * time.Second, WriteTimeout: 12 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	go func() { _ = n.server.Serve(listener) }()
	return n, nil
}

func hasZeroPort(address string) bool {
	_, port, err := net.SplitHostPort(address)
	return err == nil && port == "0"
}

func validateBootstrap(servers []raft.Server, id, address string) error {
	if len(servers) == 0 {
		return nil
	}
	ids, addresses := map[raft.ServerID]bool{}, map[raft.ServerAddress]bool{}
	found := false
	for _, server := range servers {
		if !uuidPattern.MatchString(string(server.ID)) || !loopbackAddress(string(server.Address), false) || server.Suffrage != raft.Voter || ids[server.ID] || addresses[server.Address] {
			return fmt.Errorf("invalid or duplicate bootstrap voter")
		}
		ids[server.ID], addresses[server.Address] = true, true
		if string(server.ID) == id && string(server.Address) == address {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("bootstrap configuration does not contain this node/address")
	}
	return nil
}

func (n *node) close() {
	n.once.Do(func() {
		_ = n.server.Close()
		_ = n.raft.Shutdown().Error()
		_ = n.transport.Close()
		_ = n.store.Close()
	})
}

func wait(ctx context.Context, future raft.Future) error {
	done := make(chan error, 1)
	go func() { done <- future.Error() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return fmt.Errorf("outcome uncertain; inspect/retry the same operation: %w", ctx.Err())
	}
}

type controlRequest struct {
	Operation     string   `json:"operation"`
	Command       *Command `json:"command,omitempty"`
	NodeID        string   `json:"nodeId,omitempty"`
	Address       string   `json:"address,omitempty"`
	ExpectedIndex uint64   `json:"expectedIndex,omitempty"`
}

type configurationView struct {
	Index   uint64        `json:"index"`
	Servers []raft.Server `json:"servers"`
	Voters  int           `json:"voters"`
	Quorum  int           `json:"quorum"`
}

type statusView struct {
	ID            string            `json:"id"`
	Incarnation   string            `json:"incarnation"`
	Address       string            `json:"address"`
	Role          string            `json:"role"`
	LeaderID      string            `json:"leaderId"`
	LeaderAddress string            `json:"leaderAddress"`
	Applied       uint64            `json:"applied"`
	Commit        uint64            `json:"commit"`
	Configuration configurationView `json:"configuration"`
	Observation   string            `json:"observation"`
}

func (n *node) configuration(ctx context.Context) (configurationView, error) {
	state := n.meta.view()
	view := configurationView{Index: state.ConfigurationIndex, Servers: state.Configuration.Servers}
	for _, s := range view.Servers {
		if s.Suffrage == raft.Voter {
			view.Voters++
		}
	}
	view.Quorum = view.Voters/2 + 1
	return view, nil
}

func (n *node) authoritative(ctx context.Context) error {
	// A fresh committed barrier supplies the read's quorum point. Do not substitute
	// local leader status or a reachability count, including nonvoter responses.
	return wait(ctx, n.raft.Barrier(time.Second))
}

func (n *node) control(ctx context.Context, request controlRequest) (any, error) {
	switch request.Operation {
	case "status":
		configuration, err := n.configuration(ctx)
		if err != nil {
			return nil, err
		}
		address, id := n.raft.LeaderWithID()
		return statusView{ID: n.cfg.ID, Incarnation: n.wire.incarnation, Address: n.address, Role: n.raft.State().String(), LeaderID: string(id), LeaderAddress: string(address), Applied: n.raft.AppliedIndex(), Commit: n.raft.CommitIndex(), Configuration: configuration, Observation: "local; not an authority grant"}, nil
	case "read":
		if err := n.authoritative(ctx); err != nil {
			return nil, err
		}
		return n.meta.view(), nil
	case "configuration":
		if err := n.authoritative(ctx); err != nil {
			return nil, err
		}
		return n.configuration(ctx)
	case "apply":
		if request.Command == nil || !request.Command.valid() {
			return nil, fmt.Errorf("invalid metadata command")
		}
		command := *request.Command
		n.wire.mu.Lock()
		command.LogicalTime = n.wire.clock
		n.wire.mu.Unlock()
		b, err := json.Marshal(command)
		if err != nil {
			return nil, err
		}
		future := n.raft.Apply(b, time.Second)
		if err := wait(ctx, future); err != nil {
			return nil, err
		}
		return future.Response(), nil
	case "snapshot":
		if err := n.authoritative(ctx); err != nil {
			return nil, err
		}
		if err := wait(ctx, n.raft.Snapshot()); err != nil {
			return nil, err
		}
		return map[string]uint64{"applied": n.raft.AppliedIndex()}, nil
	case "add-nonvoter", "promote", "remove":
		return n.changeMembership(ctx, request)
	default:
		return nil, fmt.Errorf("unknown control operation")
	}
}

func (n *node) changeMembership(ctx context.Context, r controlRequest) (any, error) {
	if !uuidPattern.MatchString(r.NodeID) || r.ExpectedIndex == 0 || r.ExpectedIndex > maxSafeInteger {
		return nil, fmt.Errorf("node UUID and nonzero expected configuration index required")
	}
	if err := n.authoritative(ctx); err != nil {
		return nil, err
	}
	configuration, err := n.configuration(ctx)
	if err != nil {
		return nil, err
	}
	if configuration.Index != r.ExpectedIndex {
		return nil, fmt.Errorf("configuration changed; refresh before retrying")
	}
	var member *raft.Server
	for _, s := range configuration.Servers {
		if string(s.ID) == r.NodeID {
			copy := s
			member = &copy
		}
	}
	var future raft.IndexFuture
	switch r.Operation {
	case "add-nonvoter":
		if member != nil || !loopbackAddress(r.Address, false) {
			return nil, fmt.Errorf("new nonvoter and loopback address required")
		}
		for _, s := range configuration.Servers {
			if string(s.Address) == r.Address {
				return nil, fmt.Errorf("address already belongs to another member")
			}
		}
		future = n.raft.AddNonvoter(raft.ServerID(r.NodeID), raft.ServerAddress(r.Address), r.ExpectedIndex, time.Second)
	case "promote":
		if member == nil || member.Suffrage != raft.Nonvoter || string(member.Address) != r.Address {
			return nil, fmt.Errorf("admit as matching nonvoter before promotion")
		}
		commit := n.raft.CommitIndex()
		var status statusView
		for {
			if err := n.transport.exchange(ctx, member.ID, member.Address, "control", controlRequest{Operation: "status"}, &status, nil); err != nil {
				return nil, err
			}
			if status.Applied >= commit {
				break
			}
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("nonvoter has not caught up: %w", ctx.Err())
			case <-time.After(25 * time.Millisecond):
			}
		}
		future = n.raft.AddVoter(member.ID, member.Address, r.ExpectedIndex, time.Second)
	case "remove":
		if member == nil || (member.Suffrage == raft.Voter && configuration.Voters <= 1) {
			return nil, fmt.Errorf("member missing or last voter cannot be removed")
		}
		future = n.raft.RemoveServer(member.ID, r.ExpectedIndex, time.Second)
	}
	if err := wait(ctx, future); err != nil {
		return nil, err
	}
	return map[string]uint64{"index": future.Index()}, nil
}

func (n *node) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if !n.transport.authenticated(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSnapshotBytes+maxEnvelopeBytes)
	defer r.Body.Close()
	reader := bufio.NewReader(r.Body)
	e, err := readEnvelope(reader)
	if err != nil {
		http.Error(w, "invalid envelope", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.URL.Path == "/v1/raft" {
		n.transport.serveRaft(w, r, e, reader)
		return
	}
	if err := n.wire.accept(e, "control"); err != nil || e.Error != nil {
		http.Error(w, "invalid envelope", http.StatusBadRequest)
		return
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		http.Error(w, "trailing request bytes", http.StatusBadRequest)
		return
	}
	var request controlRequest
	if err := decodeStrict(e.Body, &request); err != nil {
		http.Error(w, "invalid control request", http.StatusBadRequest)
		return
	}
	select {
	case n.controls <- struct{}{}:
		defer func() { <-n.controls }()
	default:
		http.Error(w, "control capacity exhausted", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel = context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	value, err := n.control(ctx, request)
	n.transport.reply(w, e, value, err)
}
