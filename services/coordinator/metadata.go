package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sync"

	"github.com/hashicorp/raft"
)

const maxSnapshotBytes = 32 << 20
const maxSafeInteger = uint64(1<<53 - 1)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var codePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// Command contains coordination metadata only. Assignment is desired ownership,
// never authorization to access a meeting's database or media.
type Command struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	MeetingID          string `json:"meetingId,omitempty"`
	Code               string `json:"code,omitempty"`
	RuntimeID          string `json:"runtimeId,omitempty"`
	Incarnation        string `json:"incarnation,omitempty"`
	AttemptID          string `json:"attemptId,omitempty"`
	ExpectedGeneration uint64 `json:"expectedGeneration,omitempty"`
	ExpectedRevision   uint64 `json:"expectedRevision,omitempty"`
	LogicalTime        uint64 `json:"logicalTime,omitempty"`
}

type Result struct {
	Code       string `json:"code"`
	ID         string `json:"id"`
	Index      uint64 `json:"index"`
	Generation uint64 `json:"generation,omitempty"`
	Revision   uint64 `json:"revision,omitempty"`
}

type Assignment struct {
	RuntimeID   string `json:"runtimeId"`
	Incarnation string `json:"incarnation"`
	AttemptID   string `json:"attemptId"`
}

type Meeting struct {
	ID         string      `json:"id"`
	Code       string      `json:"code"`
	Generation uint64      `json:"generation"`
	Assignment *Assignment `json:"assignment,omitempty"`
}

type Runtime struct {
	ID          string `json:"id"`
	Incarnation string `json:"incarnation"`
	Revision    uint64 `json:"revision"`
}

type savedOutcome struct {
	Digest string `json:"digest"`
	Result Result `json:"result"`
}

type State struct {
	Version   int                     `json:"version"`
	Cluster   string                  `json:"cluster"`
	HighWater uint64                  `json:"highWater"`
	Meetings  map[string]Meeting      `json:"meetings"`
	Codes     map[string]string       `json:"codes"`
	Runtimes  map[string]Runtime      `json:"runtimes"`
	Attempts  map[string]bool         `json:"attempts"`
	Outcomes  map[string]savedOutcome `json:"outcomes"`
}

type metadata struct {
	mu sync.RWMutex
	s  State
}

func newMetadata(cluster string) *metadata {
	return &metadata{s: State{Version: 1, Cluster: cluster,
		Meetings: map[string]Meeting{}, Codes: map[string]string{}, Runtimes: map[string]Runtime{},
		Attempts: map[string]bool{}, Outcomes: map[string]savedOutcome{}}}
}

func decodeStrict(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("unexpected trailing JSON")
	}
	return nil
}

func (c Command) valid() bool {
	if !uuidPattern.MatchString(c.ID) || c.ExpectedGeneration >= maxSafeInteger || c.ExpectedRevision >= maxSafeInteger || c.LogicalTime > maxSafeInteger {
		return false
	}
	switch c.Kind {
	case "reserve":
		return uuidPattern.MatchString(c.MeetingID) && codePattern.MatchString(c.Code) && c.RuntimeID == "" && c.Incarnation == "" && c.AttemptID == "" && c.ExpectedRevision == 0 && c.ExpectedGeneration == 0
	case "register":
		return uuidPattern.MatchString(c.RuntimeID) && uuidPattern.MatchString(c.Incarnation) && c.MeetingID == "" && c.Code == "" && c.AttemptID == "" && c.ExpectedGeneration == 0
	case "assign":
		return uuidPattern.MatchString(c.MeetingID) && uuidPattern.MatchString(c.RuntimeID) && uuidPattern.MatchString(c.Incarnation) && uuidPattern.MatchString(c.AttemptID) && c.Code == "" && c.ExpectedRevision == 0
	}
	return false
}

func (m *metadata) Apply(log *raft.Log) any {
	var c Command
	if decodeStrict(log.Data, &c) != nil || !c.valid() {
		return Result{Code: "INVALID", ID: c.ID, Index: log.Index}
	}
	stamp := c.LogicalTime
	c.LogicalTime = 0 // Retransmission timestamps do not change semantic identity.
	canonical, _ := json.Marshal(c)
	digestBytes := sha256.Sum256(canonical)
	digest := hex.EncodeToString(digestBytes[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	m.s.HighWater = max(m.s.HighWater, stamp)
	if previous, ok := m.s.Outcomes[c.ID]; ok {
		if previous.Digest == digest {
			return previous.Result
		}
		return Result{Code: "ID_CONFLICT", ID: c.ID, Index: log.Index}
	}
	r := Result{Code: "OK", ID: c.ID, Index: log.Index}
	switch c.Kind {
	case "reserve":
		if _, ok := m.s.Codes[c.Code]; ok {
			r.Code = "CODE_TAKEN"
			break
		}
		if _, ok := m.s.Meetings[c.MeetingID]; ok {
			r.Code = "MEETING_EXISTS"
			break
		}
		m.s.Codes[c.Code] = c.MeetingID
		m.s.Meetings[c.MeetingID] = Meeting{ID: c.MeetingID, Code: c.Code}
	case "register":
		old := m.s.Runtimes[c.RuntimeID]
		if old.Revision != c.ExpectedRevision {
			r.Code = "REVISION_CONFLICT"
			break
		}
		r.Revision = old.Revision + 1
		m.s.Runtimes[c.RuntimeID] = Runtime{ID: c.RuntimeID, Incarnation: c.Incarnation, Revision: r.Revision}
	case "assign":
		meeting, ok := m.s.Meetings[c.MeetingID]
		if !ok {
			r.Code = "UNKNOWN_MEETING"
			break
		}
		if meeting.Generation != c.ExpectedGeneration {
			r.Code = "GENERATION_CONFLICT"
			break
		}
		runtime, ok := m.s.Runtimes[c.RuntimeID]
		if !ok || runtime.Incarnation != c.Incarnation {
			r.Code = "RUNTIME_MISMATCH"
			break
		}
		if m.s.Attempts[c.AttemptID] {
			r.Code = "ATTEMPT_REUSED"
			break
		}
		meeting.Generation++
		meeting.Assignment = &Assignment{RuntimeID: c.RuntimeID, Incarnation: c.Incarnation, AttemptID: c.AttemptID}
		m.s.Meetings[c.MeetingID] = meeting
		m.s.Attempts[c.AttemptID] = true
		r.Generation = meeting.Generation
	}
	m.s.Outcomes[c.ID] = savedOutcome{Digest: digest, Result: r}
	return r
}

func (m *metadata) view() State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// All fields are JSON values; cloning also detaches nested assignment pointers.
	b, _ := json.Marshal(m.s)
	var result State
	_ = json.Unmarshal(b, &result)
	return result
}

type metadataSnapshot struct{ data []byte }

func (m *metadata) Snapshot() (raft.FSMSnapshot, error) {
	b, err := json.Marshal(m.view())
	if err != nil {
		return nil, err
	}
	if len(b) > maxSnapshotBytes {
		return nil, fmt.Errorf("coordinator snapshot exceeds %d bytes", maxSnapshotBytes)
	}
	return &metadataSnapshot{data: b}, nil
}

func (s *metadataSnapshot) Persist(sink raft.SnapshotSink) error {
	if _, err := sink.Write(s.data); err != nil {
		_ = sink.Cancel()
		return err
	}
	if err := sink.Close(); err != nil {
		_ = sink.Cancel()
		return err
	}
	return nil
}
func (s *metadataSnapshot) Release() {}

func (m *metadata) Restore(reader io.ReadCloser) error {
	defer reader.Close()
	b, err := io.ReadAll(io.LimitReader(reader, maxSnapshotBytes+1))
	if err != nil {
		return err
	}
	if len(b) > maxSnapshotBytes {
		return fmt.Errorf("snapshot too large")
	}
	var s State
	if err := decodeStrict(b, &s); err != nil {
		return err
	}
	if s.Version != 1 || s.Cluster != m.s.Cluster || s.Meetings == nil || s.Codes == nil || s.Runtimes == nil || s.Attempts == nil || s.Outcomes == nil || s.HighWater > maxSafeInteger {
		return fmt.Errorf("invalid snapshot identity or structure")
	}
	for id, meeting := range s.Meetings {
		if !uuidPattern.MatchString(id) || meeting.ID != id || !codePattern.MatchString(meeting.Code) || s.Codes[meeting.Code] != id || meeting.Generation > maxSafeInteger {
			return fmt.Errorf("invalid snapshot meeting")
		}
		if a := meeting.Assignment; a != nil {
			if meeting.Generation == 0 || !uuidPattern.MatchString(a.RuntimeID) || !uuidPattern.MatchString(a.Incarnation) || !uuidPattern.MatchString(a.AttemptID) || !s.Attempts[a.AttemptID] {
				return fmt.Errorf("invalid snapshot assignment")
			}
		} else if meeting.Generation != 0 {
			return fmt.Errorf("missing snapshot assignment")
		}
	}
	if len(s.Codes) != len(s.Meetings) {
		return fmt.Errorf("invalid snapshot code index")
	}
	for id, runtime := range s.Runtimes {
		if !uuidPattern.MatchString(id) || runtime.ID != id || !uuidPattern.MatchString(runtime.Incarnation) || runtime.Revision == 0 || runtime.Revision > maxSafeInteger {
			return fmt.Errorf("invalid snapshot runtime")
		}
	}
	for id, outcome := range s.Outcomes {
		digest, err := hex.DecodeString(outcome.Digest)
		if !uuidPattern.MatchString(id) || outcome.Result.ID != id || err != nil || len(digest) != sha256.Size || outcome.Result.Code == "" {
			return fmt.Errorf("invalid snapshot outcome")
		}
	}
	m.mu.Lock()
	m.s = s
	m.mu.Unlock()
	return nil
}
