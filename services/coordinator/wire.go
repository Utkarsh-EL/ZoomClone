package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"
)

const maxEnvelopeBytes = 1 << 20

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	Version     int             `json:"version"`
	ClusterID   string          `json:"clusterId"`
	NodeID      string          `json:"nodeId"`
	Incarnation string          `json:"incarnation"`
	RequestID   string          `json:"requestId"`
	Lamport     uint64          `json:"lamport"`
	Kind        string          `json:"kind"`
	Body        json.RawMessage `json:"body"`
	Error       *wireError      `json:"error,omitempty"`
}

type wire struct {
	mu                              sync.Mutex
	cluster, id, incarnation, token string
	clock                           uint64
	output                          io.Writer
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (w *wire) packet(kind, id string, body json.RawMessage, failure *wireError) (envelope, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.clock >= maxSafeInteger-1 {
		return envelope{}, fmt.Errorf("logical clock exhausted")
	}
	w.clock++
	e := envelope{Version: 1, ClusterID: w.cluster, NodeID: w.id, Incarnation: w.incarnation,
		RequestID: id, Lamport: w.clock, Kind: kind, Body: body, Error: failure}
	w.trace("send", e)
	return e, nil
}

func (w *wire) observe(stamp uint64) {
	w.mu.Lock()
	w.clock = max(w.clock, stamp)
	w.mu.Unlock()
}

// accept runs for all RPCs, including heartbeat fast paths and snapshot headers.
func (w *wire) accept(e envelope, kind string) error {
	if e.Version != 1 || e.ClusterID != w.cluster || !uuidPattern.MatchString(e.NodeID) || !uuidPattern.MatchString(e.Incarnation) || !uuidPattern.MatchString(e.RequestID) || e.Lamport == 0 || e.Lamport >= maxSafeInteger || e.Kind != kind || len(e.Body) == 0 {
		return fmt.Errorf("invalid protocol envelope")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if max(w.clock, e.Lamport) >= maxSafeInteger-2 {
		return fmt.Errorf("logical clock exhausted")
	}
	w.clock = max(w.clock, e.Lamport) + 1
	w.trace("receive", e)
	return nil
}

// Caller holds mu. Bodies and credentials never enter the transport trace.
func (w *wire) trace(direction string, e envelope) {
	if w.output == nil {
		return
	}
	_ = json.NewEncoder(w.output).Encode(map[string]any{
		"event": direction, "time": time.Now().UTC().Format(time.RFC3339Nano), "nodeId": w.id,
		"incarnation": w.incarnation, "clusterId": w.cluster, "requestId": e.RequestID,
		"kind": e.Kind, "lamport": w.clock, "remoteLamport": e.Lamport,
	})
}

// A bounded NDJSON header is followed by raw bytes only for snapshot requests.
func readEnvelope(r *bufio.Reader) (envelope, error) {
	var data []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(data)+len(part) > maxEnvelopeBytes {
			return envelope{}, fmt.Errorf("envelope too large")
		}
		data = append(data, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return envelope{}, fmt.Errorf("incomplete envelope: %w", err)
		}
		break
	}
	var e envelope
	if err := decodeStrict(data, &e); err != nil {
		return e, err
	}
	return e, nil
}
