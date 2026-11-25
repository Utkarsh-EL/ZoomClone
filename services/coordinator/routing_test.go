package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

func TestSourceRouteCoversPeerControlAndConsensus(t *testing.T) {
	nodes, _ := testCluster(t, 1)
	destination := leader(t, nodes)
	base, _ := url.Parse("http://" + destination.address)
	forward := httputil.NewSingleHostReverseProxy(base)
	var controls, consensus atomic.Int64
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/control" {
			controls.Add(1)
		} else {
			consensus.Add(1)
		}
		forward.ServeHTTP(w, r)
	}))
	defer proxy.Close()
	routes := map[string]string{"127.0.0.1:1": strings.TrimPrefix(proxy.URL, "http://")}
	source, err := openNode(nodeConfig{Cluster: clusterID, ID: runtimeID, Address: "127.0.0.1:0", DataDir: filepath.Join(t.TempDir(), "source"), Token: testToken, New: true, Output: io.Discard, Routes: routes})
	if err != nil {
		t.Fatal(err)
	}
	defer source.close()
	routes["127.0.0.1:1"] = "127.0.0.1:2" // Configuration must have been copied.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var status statusView
	if err := source.transport.exchange(ctx, raft.ServerID(destination.cfg.ID), "127.0.0.1:1", "control", controlRequest{Operation: "status"}, &status, nil); err != nil {
		t.Fatal(err)
	}
	var response raft.RequestPreVoteResponse
	if err := source.transport.RequestPreVote(raft.ServerID(destination.cfg.ID), "127.0.0.1:1", &raft.RequestPreVoteRequest{RPCHeader: raft.RPCHeader{ProtocolVersion: raft.ProtocolVersionMax, ID: []byte(source.cfg.ID), Addr: []byte(source.address)}, Term: 7}, &response); err != nil {
		t.Fatal(err)
	}
	if controls.Load() != 1 || consensus.Load() != 1 {
		t.Fatal("a peer exchange bypassed the configured route", controls.Load(), consensus.Load())
	}
}

func TestRouteConfigRejectsExternalTargets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(`{"127.0.0.1:7001":"example.com:80"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := parseConfig([]string{"--routes", path}, testToken); err == nil {
		t.Fatal("external route accepted")
	}
	if err := os.WriteFile(path, []byte(`{"127.0.0.1:7001":"127.0.0.1:9001"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := parseConfig([]string{"--routes", path}, testToken)
	if err != nil || cfg.Routes["127.0.0.1:7001"] != "127.0.0.1:9001" {
		t.Fatal("valid route file rejected", err)
	}
}

func TestRestartRejectsUnauditedLegacyHistory(t *testing.T) {
	nodes, configs := testCluster(t, 1)
	nodes[0].close()
	nodes[0] = nil
	path := filepath.Join(configs[0].DataDir, "identity.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var old identity
	if err := json.Unmarshal(data, &old); err != nil {
		t.Fatal(err)
	}
	old.Version = 1
	data, _ = json.Marshal(old)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := configs[0]
	cfg.New, cfg.Listener, cfg.Bootstrap = false, nil, nil
	if restarted, err := openNode(cfg); err == nil {
		restarted.close()
		t.Fatal("unaudited pre-fix history silently reused")
	}
}
