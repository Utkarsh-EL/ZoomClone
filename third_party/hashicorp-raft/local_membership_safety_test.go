// SPDX-License-Identifier: MPL-2.0
package raft

import (
	"container/list"
	"errors"
	"testing"

	"github.com/hashicorp/go-hclog"
	"github.com/stretchr/testify/require"
)

type rejectedConfigurationStore struct {
	LogStore
	err error
}

func (s *rejectedConfigurationStore) StoreLogs(logs []*Log) error {
	for _, entry := range logs {
		if entry.Type == LogConfiguration {
			return s.err
		}
	}
	return s.LogStore.StoreLogs(logs)
}

func TestLocalFailedMembershipWriteCannotChangeQuorum(t *testing.T) {
	// Run the serialized leader operation directly, so no scheduling can hide
	// the window between a failed write and installing phantom membership.
	configuration := Configuration{Servers: []Server{
		{ID: "a", Address: "a", Suffrage: Voter},
		{ID: "b", Address: "b", Suffrage: Voter},
		{ID: "c", Address: "c", Suffrage: Voter},
		{ID: "d", Address: "d", Suffrage: Voter},
	}}
	writeError := errors.New("injected atomic membership write failure")
	store := NewInmemStore()
	require.NoError(t, store.StoreLog(&Log{Index: 1, Term: 1, Type: LogConfiguration, Data: EncodeConfiguration(configuration)}))
	r := &Raft{
		localID: "a", protocolVersion: ProtocolVersionMax,
		logs:   &rejectedConfigurationStore{LogStore: store, err: writeError},
		stable: store,
		logger: hclog.NewNullLogger(), shutdownCh: make(chan struct{}),
	}
	r.conf.Store(*DefaultConfig())
	r.setLatestConfiguration(configuration, 1)
	r.setCommittedConfiguration(configuration, 1)
	r.setCurrentTerm(1)
	r.setLastLog(1, 1)
	r.setState(Leader)
	r.leaderState.inflight = list.New()
	r.leaderState.commitment = newCommitment(make(chan struct{}, 1), configuration, 2)
	r.leaderState.replState = make(map[ServerID]*followerReplication)
	for _, peer := range configuration.Servers[1:] {
		r.leaderState.replState[peer.ID] = &followerReplication{peer: peer, stopCh: make(chan uint64, 1)}
	}
	future := &configurationChangeFuture{req: configurationChangeRequest{command: RemoveServer, serverID: "d"}}
	future.init()
	r.appendConfigurationEntry(future)
	require.ErrorIs(t, future.Error(), writeError)
	require.Equal(t, configuration, r.configurations.latest, "unwritten membership changed election quorum")
	require.Len(t, r.leaderState.commitment.matchIndexes, 4, "unwritten membership changed commit quorum")
	require.Contains(t, r.leaderState.replState, ServerID("d"), "failed removal stopped replication")
	require.Equal(t, Shutdown, r.State(), "uncertain durable write must stop service before another election")
	select {
	case <-r.shutdownCh:
	default:
		t.Fatal("storage failure did not synchronously close shutdown channel")
	}
	last, err := store.LastIndex()
	require.NoError(t, err)
	require.Equal(t, uint64(1), last)
}
