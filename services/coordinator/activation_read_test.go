package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAuthoritativeReadRemainsBoundedAfterRenewalHistory(t *testing.T) {
	nodes, _ := testCluster(t, 1)
	n := leader(t, nodes)
	// A normal 1s renewal cadence reaches this history in about 83 minutes.
	// Seed retained outcomes directly so this boundary regression needs no sleeps.
	n.meta.mu.Lock()
	for i := 0; i < 5000; i++ {
		id := newUUID()
		n.meta.s.Outcomes[id] = savedOutcome{Digest: strings.Repeat("a", 64), Result: Result{ID: id, Code: "OK", Index: uint64(i + 1), Generation: 1, Revision: uint64(i + 1)}}
	}
	n.meta.mu.Unlock()
	value := call(t, n, controlRequest{Operation: "read"})
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if len(data)+1024 >= maxEnvelopeBytes {
		t.Fatalf("periodic renewals made authority reads unavailable: %d bytes", len(data))
	}
	if len(n.meta.view().Outcomes) != 5000 {
		t.Fatal("read projection discarded durable retry history")
	}
}
