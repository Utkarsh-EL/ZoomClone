package main

import (
	"fmt"

	"github.com/hashicorp/raft"
)

// DecodeConfiguration panics on bad msgpack; keep this serialization failure at
// the HTTP boundary, before it can reach a consensus goroutine.
func decodeConfiguration(data []byte) (configuration raft.Configuration, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("invalid configuration encoding")
		}
	}()
	configuration = raft.DecodeConfiguration(data)
	ids, addresses := map[raft.ServerID]bool{}, map[raft.ServerAddress]bool{}
	voters := 0
	for _, s := range configuration.Servers {
		if !uuidPattern.MatchString(string(s.ID)) || !loopbackAddress(string(s.Address), false) || ids[s.ID] || addresses[s.Address] || (s.Suffrage != raft.Voter && s.Suffrage != raft.Nonvoter) {
			return configuration, fmt.Errorf("invalid configuration member")
		}
		ids[s.ID], addresses[s.Address] = true, true
		if s.Suffrage == raft.Voter {
			voters++
		}
	}
	if voters == 0 {
		return configuration, fmt.Errorf("configuration requires voters")
	}
	return configuration, nil
}

func validateRPC(command any, sender string) error {
	header, ok := command.(raft.WithRPCHeader)
	if !ok {
		return fmt.Errorf("missing Raft header")
	}
	h := header.GetRPCHeader()
	if h.ProtocolVersion != raft.ProtocolVersionMax || string(h.ID) != sender || !loopbackAddress(string(h.Addr), false) {
		return fmt.Errorf("Raft sender/header mismatch")
	}
	validTail := func(index, term, current uint64) bool {
		return (index == 0 && term == 0) || (index > 0 && term > 0 && term <= current)
	}
	switch r := command.(type) {
	case *raft.AppendEntriesRequest:
		if r.Term == 0 || !validTail(r.PrevLogEntry, r.PrevLogTerm, r.Term) {
			return fmt.Errorf("invalid append term/index")
		}
		index := r.PrevLogEntry
		for _, entry := range r.Entries {
			if entry == nil || index == ^uint64(0) || entry.Index != index+1 || entry.Term == 0 || entry.Term > r.Term {
				return fmt.Errorf("invalid append entry")
			}
			index++
			switch entry.Type {
			case raft.LogCommand, raft.LogNoop, raft.LogBarrier:
			case raft.LogConfiguration:
				if _, err := decodeConfiguration(entry.Data); err != nil {
					return err
				}
			default:
				return fmt.Errorf("unsupported log type")
			}
		}
	case *raft.RequestVoteRequest:
		if r.Term == 0 || !validTail(r.LastLogIndex, r.LastLogTerm, r.Term) {
			return fmt.Errorf("invalid vote term/index")
		}
	case *raft.RequestPreVoteRequest:
		if r.Term == 0 || !validTail(r.LastLogIndex, r.LastLogTerm, r.Term) {
			return fmt.Errorf("invalid pre-vote term/index")
		}
	case *raft.InstallSnapshotRequest:
		if r.Term == 0 || r.SnapshotVersion != raft.SnapshotVersionMax || r.Size <= 0 || r.Size > maxSnapshotBytes || r.LastLogIndex == 0 || r.LastLogTerm == 0 || r.LastLogTerm > r.Term || r.ConfigurationIndex == 0 || r.ConfigurationIndex > r.LastLogIndex {
			return fmt.Errorf("invalid snapshot metadata")
		}
		if _, err := decodeConfiguration(r.Configuration); err != nil {
			return err
		}
	case *raft.TimeoutNowRequest:
	default:
		return fmt.Errorf("unsupported RPC")
	}
	return nil
}
