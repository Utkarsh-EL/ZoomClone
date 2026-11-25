package main

import (
	"fmt"

	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"
)

var storeIdentityKey = []byte("ZoomClone.StoreIdentity.v1")

func bindStoreIdentity(store *raftboltdb.BoltStore, id string, initialize bool) error {
	if initialize {
		return store.Set(storeIdentityKey, []byte(id))
	}
	actual, err := store.Get(storeIdentityKey)
	if err != nil || string(actual) != id {
		return fmt.Errorf("durable store identity lost/mismatched; explicit replacement required")
	}
	// NewRaft always persists CurrentTerm, even for a not-yet-admitted node.
	// Snapshots alone cannot replace the stable voting state in this store.
	term, err := store.Get([]byte("CurrentTerm"))
	if err != nil || len(term) != 8 {
		return fmt.Errorf("durable voting term lost; explicit replacement required")
	}
	return nil
}

// Seed before NewRaft starts election goroutines. Snapshot Restore advances the
// same clock before those goroutines start; surviving log records also matter,
// including records not yet replayed by the new leader. Observing an uncommitted
// timestamp is harmless: a larger Lamport value alone never claims causality.
func seedClockFromLogs(store raft.LogStore, w *wire, snapshotIndex uint64) error {
	first, err := store.FirstIndex()
	if err != nil {
		return err
	}
	last, err := store.LastIndex()
	if err != nil {
		return err
	}
	// Snapshot installation may retain an older log prefix and a newer suffix,
	// with the interval between them represented only by the snapshot.
	for index := first; first != 0 && index <= last; index++ {
		var entry raft.Log
		if err := store.GetLog(index, &entry); err != nil {
			if err == raft.ErrLogNotFound && index <= snapshotIndex {
				continue
			}
			return err
		}
		if entry.Type == raft.LogCommand {
			var command Command
			if decodeStrict(entry.Data, &command) != nil || !command.valid() {
				return fmt.Errorf("invalid durable coordinator command")
			}
			w.observe(command.LogicalTime)
		}
		if index == ^uint64(0) {
			break
		}
	}
	return nil
}
