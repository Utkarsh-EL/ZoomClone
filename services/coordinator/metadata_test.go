package main

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"

	"github.com/hashicorp/raft"
)

const clusterID = "00000000-0000-4000-8000-000000000001"
const meetingID = "00000000-0000-4000-8000-000000000002"
const runtimeID = "00000000-0000-4000-8000-000000000003"
const incarnation = "00000000-0000-4000-8000-000000000004"
const attemptID = "00000000-0000-4000-8000-000000000005"

func apply(t *testing.T, m *metadata, index uint64, c Command) Result {
	t.Helper()
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return m.Apply(&raft.Log{Index: index, Data: b}).(Result)
}

func TestReservationRetryAndConflicts(t *testing.T) {
	m := newMetadata(clusterID)
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "demo-lab"}
	first := apply(t, m, 1, c)
	if first.Code != "OK" {
		t.Fatal(first)
	}
	if got := apply(t, m, 2, c); got != first {
		t.Fatalf("retry changed outcome: %+v != %+v", got, first)
	}
	c.Code = "other"
	if got := apply(t, m, 3, c); got.Code != "ID_CONFLICT" {
		t.Fatal(got)
	}
	c.ID, c.MeetingID, c.Code = runtimeID, runtimeID, "demo-lab"
	if got := apply(t, m, 4, c); got.Code != "CODE_TAKEN" {
		t.Fatal(got)
	}
	if len(m.view().Meetings) != 1 {
		t.Fatal("conflict created a meeting")
	}
	v := m.view()
	delete(v.Meetings, meetingID)
	if len(m.view().Meetings) != 1 {
		t.Fatal("view aliases FSM")
	}
}

func TestAssignmentUsesRegisteredIncarnationAndGenerationCAS(t *testing.T) {
	m := newMetadata(clusterID)
	apply(t, m, 1, Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "demo"})
	r := Command{ID: runtimeID, Kind: "register", RuntimeID: runtimeID, Incarnation: incarnation}
	if got := apply(t, m, 2, r); got.Code != "OK" {
		t.Fatal(got)
	}
	c := Command{ID: attemptID, Kind: "assign", MeetingID: meetingID, RuntimeID: runtimeID, Incarnation: incarnation, AttemptID: attemptID}
	if got := apply(t, m, 3, c); got.Code != "OK" || got.Generation != 1 {
		t.Fatal(got)
	}
	c.ID = incarnation
	if got := apply(t, m, 4, c); got.Code != "GENERATION_CONFLICT" {
		t.Fatal(got)
	}
	c.ID, c.ExpectedGeneration, c.Incarnation = clusterID, 1, runtimeID
	if got := apply(t, m, 5, c); got.Code != "RUNTIME_MISMATCH" {
		t.Fatal(got)
	}
	r.ID, r.Incarnation = "00000000-0000-4000-8000-000000000008", attemptID
	if got := apply(t, m, 6, r); got.Code != "REVISION_CONFLICT" {
		t.Fatal(got)
	}
	r.ID, r.ExpectedRevision = incarnation, 1
	if got := apply(t, m, 7, r); got.Code != "ID_CONFLICT" {
		t.Fatal("rejected outcomes must also be stable", got)
	}
	r.ID = "00000000-0000-4000-8000-000000000006"
	if got := apply(t, m, 8, r); got.Code != "OK" || got.Revision != 2 {
		t.Fatal(got)
	}
	c.ID, c.Incarnation, c.AttemptID = "00000000-0000-4000-8000-000000000007", attemptID, runtimeID
	if got := apply(t, m, 9, c); got.Code != "OK" || got.Generation != 2 {
		t.Fatal(got)
	}
	if m.view().Meetings[meetingID].Assignment.Incarnation != attemptID {
		t.Fatal("wrong candidate")
	}
}

type memorySink struct {
	bytes.Buffer
	canceled bool
}

func (s *memorySink) ID() string    { return "test" }
func (s *memorySink) Cancel() error { s.canceled = true; return nil }
func (s *memorySink) Close() error  { return nil }

func TestSnapshotRetainsStableOutcomesAndRejectsWrongCluster(t *testing.T) {
	m := newMetadata(clusterID)
	c := Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "demo", LogicalTime: 82}
	want := apply(t, m, 7, c)
	snapshot, err := m.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Release()
	sink := &memorySink{}
	if err := snapshot.Persist(sink); err != nil {
		t.Fatal(err)
	}
	n := newMetadata(clusterID)
	if err := n.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err != nil {
		t.Fatal(err)
	}
	c.LogicalTime = 120 // A retransmission is a new send event, not new command content.
	if got := apply(t, n, 10, c); got != want {
		t.Fatal(got, want)
	}
	if n.view().HighWater != 120 {
		t.Fatal("causal stamp was not restored/advanced")
	}
	wrong := newMetadata(runtimeID)
	if err := wrong.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err == nil {
		t.Fatal("cross-cluster snapshot accepted")
	}
	if err := n.Restore(io.NopCloser(bytes.NewBufferString(`{"version":1}`))); err == nil {
		t.Fatal("incomplete snapshot accepted")
	}
}

func TestMalformedMetadataCannotMutateState(t *testing.T) {
	m := newMetadata(clusterID)
	for i, c := range []Command{
		{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "../escape"},
		{ID: "", Kind: "reserve", MeetingID: meetingID, Code: "demo"},
		{ID: meetingID, Kind: "assign", MeetingID: "not-a-uuid"},
		{ID: meetingID, Kind: "unexpected"},
	} {
		if got := apply(t, m, uint64(i+1), c); got.Code != "INVALID" {
			t.Fatal(got)
		}
	}
	if len(m.view().Meetings) != 0 {
		t.Fatal("invalid command mutated state")
	}
}

func TestActivationAndRenewalGuardSupersededAttempts(t *testing.T) {
	m := newMetadata(clusterID)
	apply(t, m, 1, Command{ID: meetingID, Kind: "reserve", MeetingID: meetingID, Code: "activation"})
	apply(t, m, 2, Command{ID: runtimeID, Kind: "register", RuntimeID: runtimeID, Incarnation: incarnation})
	apply(t, m, 3, Command{ID: attemptID, Kind: "assign", MeetingID: meetingID, RuntimeID: runtimeID, Incarnation: incarnation, AttemptID: attemptID})
	index := uint64(4)
	send := func(kind string, revision uint64) Result {
		index++
		return apply(t, m, index, Command{ID: newUUID(), Kind: kind, MeetingID: meetingID, RuntimeID: runtimeID, Incarnation: incarnation, AttemptID: attemptID, ExpectedGeneration: 1, ExpectedRevision: revision})
	}
	if got := send("confirm-ready", 0); got.Code != "PHASE_CONFLICT" {
		t.Fatal(got)
	}
	if got := send("activation-intent", 0); got.Code != "OK" {
		t.Fatal(got)
	}
	if got := send("confirm-ready", 0); got.Code != "OK" {
		t.Fatal(got)
	}
	if got := send("renew", 0); got.Code != "OK" || got.Revision != 1 {
		t.Fatal(got)
	}
	if got := send("renew", 0); got.Code != "REVISION_CONFLICT" {
		t.Fatal(got)
	}
	replacement := Command{ID: newUUID(), Kind: "assign", MeetingID: meetingID, RuntimeID: runtimeID, Incarnation: incarnation, AttemptID: newUUID(), ExpectedGeneration: 1}
	if got := apply(t, m, 20, replacement); got.Code != "REVISION_CONFLICT" {
		t.Fatal("stale suspicion replaced renewed owner", got)
	}
	replacement.ID = newUUID()
	replacement.ExpectedRevision = 1
	if got := apply(t, m, 21, replacement); got.Code != "OK" {
		t.Fatal(got)
	}
	if got := send("confirm-ready", 1); got.Code != "GENERATION_CONFLICT" {
		t.Fatal("late candidate became ready", got)
	}
	if got := send("renew", 1); got.Code != "GENERATION_CONFLICT" {
		t.Fatal(got)
	}
	snapshot, _ := m.Snapshot()
	sink := &memorySink{}
	_ = snapshot.Persist(sink)
	restored := newMetadata(clusterID)
	if err := restored.Restore(io.NopCloser(bytes.NewReader(sink.Bytes()))); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(m.view())
	c, _ := json.Marshal(restored.view())
	if !bytes.Equal(b, c) {
		t.Fatal("activation state not retained")
	}
}
