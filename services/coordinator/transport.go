package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/hashicorp/raft"
)

// HTTP transports only library-defined RPCs; election/commit logic stays in Raft.
// Pipelining is deliberately unsupported: the library uses bounded sequential
// AppendEntries instead, so no alternate route can omit stamps/authentication.
type httpTransport struct {
	wire      *wire
	address   string
	consumer  chan raft.RPC
	client    *http.Client
	mu        sync.RWMutex
	heartbeat func(raft.RPC)
}

func newTransport(w *wire, address string) *httpTransport {
	return &httpTransport{wire: w, address: address, consumer: make(chan raft.RPC), client: &http.Client{
		Timeout:       10 * time.Second,
		Transport:     &http.Transport{Proxy: nil, MaxIdleConns: 32, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("redirect refused") },
	}}
}

func loopbackAddress(address string, allowZero bool) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	p, err := strconv.Atoi(port)
	return ip != nil && ip.IsLoopback() && err == nil && p >= 0 && p <= 65535 && (allowZero || p != 0)
}

func (t *httpTransport) Consumer() <-chan raft.RPC                               { return t.consumer }
func (t *httpTransport) LocalAddr() raft.ServerAddress                           { return raft.ServerAddress(t.address) }
func (t *httpTransport) EncodePeer(_ raft.ServerID, a raft.ServerAddress) []byte { return []byte(a) }
func (t *httpTransport) DecodePeer(a []byte) raft.ServerAddress                  { return raft.ServerAddress(a) }
func (t *httpTransport) AppendEntriesPipeline(raft.ServerID, raft.ServerAddress) (raft.AppendPipeline, error) {
	return nil, raft.ErrPipelineReplicationNotSupported
}
func (t *httpTransport) Close() error { t.client.CloseIdleConnections(); return nil }
func (t *httpTransport) SetHeartbeatHandler(f func(raft.RPC)) {
	t.mu.Lock()
	t.heartbeat = f
	t.mu.Unlock()
}

func (t *httpTransport) exchange(ctx context.Context, id raft.ServerID, address raft.ServerAddress, kind string, args, response any, data io.Reader) error {
	if !loopbackAddress(string(address), false) {
		return fmt.Errorf("only literal loopback targets are enabled")
	}
	body, err := json.Marshal(args)
	if err != nil {
		return err
	}
	e, err := t.wire.packet(kind, newUUID(), body, nil)
	if err != nil {
		return err
	}
	header, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if len(header)+1 > maxEnvelopeBytes {
		return fmt.Errorf("envelope too large")
	}
	var source io.Reader = bytes.NewReader(append(header, '\n'))
	if data != nil {
		source = io.MultiReader(source, data)
	}
	path := "/v1/raft"
	if kind == "control" {
		path = "/v1/control"
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://"+string(address)+path, source)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.wire.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("raft HTTP status %d", resp.StatusCode)
	}
	r := bufio.NewReader(resp.Body)
	reply, err := readEnvelope(r)
	if err != nil {
		return err
	}
	if reply.RequestID != e.RequestID || reply.NodeID != string(id) {
		return fmt.Errorf("uncorrelated raft reply")
	}
	if err := t.wire.accept(reply, kind+".reply"); err != nil {
		return err
	}
	if _, err := r.ReadByte(); err != io.EOF {
		return fmt.Errorf("trailing raft reply bytes")
	}
	if reply.Error != nil {
		return fmt.Errorf("%s: %s", reply.Error.Code, reply.Error.Message)
	}
	return json.Unmarshal(reply.Body, response)
}

func (t *httpTransport) AppendEntries(id raft.ServerID, a raft.ServerAddress, args *raft.AppendEntriesRequest, resp *raft.AppendEntriesResponse) error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	return t.exchange(ctx, id, a, "raft.append", args, resp, nil)
}
func (t *httpTransport) RequestVote(id raft.ServerID, a raft.ServerAddress, args *raft.RequestVoteRequest, resp *raft.RequestVoteResponse) error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	return t.exchange(ctx, id, a, "raft.vote", args, resp, nil)
}
func (t *httpTransport) RequestPreVote(id raft.ServerID, a raft.ServerAddress, args *raft.RequestPreVoteRequest, resp *raft.RequestPreVoteResponse) error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	return t.exchange(ctx, id, a, "raft.pre-vote", args, resp, nil)
}
func (t *httpTransport) TimeoutNow(id raft.ServerID, a raft.ServerAddress, args *raft.TimeoutNowRequest, resp *raft.TimeoutNowResponse) error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	return t.exchange(ctx, id, a, "raft.timeout-now", args, resp, nil)
}
func (t *httpTransport) InstallSnapshot(id raft.ServerID, a raft.ServerAddress, args *raft.InstallSnapshotRequest, resp *raft.InstallSnapshotResponse, data io.Reader) error {
	if args.Size <= 0 || args.Size > maxSnapshotBytes {
		return fmt.Errorf("snapshot size outside bounds")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return t.exchange(ctx, id, a, "raft.snapshot", args, resp, io.LimitReader(data, args.Size))
}

func (t *httpTransport) authenticated(r *http.Request) bool {
	return subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+t.wire.token)) == 1
}

func (t *httpTransport) reply(w http.ResponseWriter, request envelope, value any, failure error) {
	body, err := json.Marshal(value)
	if err != nil {
		failure = err
		body = json.RawMessage("null")
	}
	var problem *wireError
	if failure != nil {
		problem = &wireError{Code: "UNAVAILABLE", Message: failure.Error()}
	}
	e, err := t.wire.packet(request.Kind+".reply", request.RequestID, body, problem)
	if err != nil {
		http.Error(w, "logical clock exhausted", http.StatusServiceUnavailable)
		return
	}
	b, err := json.Marshal(e)
	if err != nil || len(b)+1 > maxEnvelopeBytes {
		e.Body = json.RawMessage("null")
		e.Error = &wireError{Code: "REPLY_TOO_LARGE", Message: "response exceeds lab protocol bound"}
		b, _ = json.Marshal(e)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(append(b, '\n'))
}

func (t *httpTransport) serveRaft(w http.ResponseWriter, r *http.Request, e envelope, reader *bufio.Reader) {
	var command any
	switch e.Kind {
	case "raft.append":
		command = &raft.AppendEntriesRequest{}
	case "raft.vote":
		command = &raft.RequestVoteRequest{}
	case "raft.pre-vote":
		command = &raft.RequestPreVoteRequest{}
	case "raft.timeout-now":
		command = &raft.TimeoutNowRequest{}
	case "raft.snapshot":
		command = &raft.InstallSnapshotRequest{}
	default:
		http.Error(w, "unknown RPC", http.StatusBadRequest)
		return
	}
	if err := t.wire.accept(e, e.Kind); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if e.Error != nil {
		http.Error(w, "error on request", http.StatusBadRequest)
		return
	}
	if err := decodeStrict(e.Body, command); err != nil {
		http.Error(w, "invalid RPC body", http.StatusBadRequest)
		return
	}
	if err := validateRPC(command, e.NodeID); err != nil {
		http.Error(w, "invalid Raft payload", http.StatusBadRequest)
		return
	}
	responses := make(chan raft.RPCResponse, 1)
	rpc := raft.RPC{Command: command, RespChan: responses}
	var snapshot *io.LimitedReader
	if args, ok := command.(*raft.InstallSnapshotRequest); ok {
		if args.Size <= 0 || args.Size > maxSnapshotBytes {
			http.Error(w, "snapshot too large", http.StatusRequestEntityTooLarge)
			return
		}
		snapshot = &io.LimitedReader{R: reader, N: args.Size}
		rpc.Reader = snapshot
	} else if _, err := reader.ReadByte(); err != io.EOF {
		http.Error(w, "trailing request bytes", http.StatusBadRequest)
		return
	}
	t.mu.RLock()
	heartbeat := t.heartbeat
	t.mu.RUnlock()
	if a, ok := command.(*raft.AppendEntriesRequest); ok && a.Term != 0 && len(a.Entries) == 0 && a.PrevLogEntry == 0 && a.PrevLogTerm == 0 && a.LeaderCommitIndex == 0 && heartbeat != nil {
		heartbeat(rpc)
	} else {
		select {
		case t.consumer <- rpc:
		case <-r.Context().Done():
			return
		}
	}
	select {
	case result := <-responses:
		// A rejected snapshot can leave bytes unread. A successful one must consume it.
		if snapshot != nil && result.Error == nil && snapshot.N != 0 {
			if response, ok := result.Response.(*raft.InstallSnapshotResponse); ok && response.Success {
				result.Error = fmt.Errorf("incomplete snapshot stream")
			}
		}
		t.reply(w, e, result.Response, result.Error)
	case <-r.Context().Done():
	}
}
