package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCLIParsesExplicitInitializationAndRejectsTypos(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.json")
	if err := os.WriteFile(path, []byte(`[{"id":"10000000-0000-4000-8000-000000000001","address":"127.0.0.1:7901"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--cluster", clusterID, "--id", "10000000-0000-4000-8000-000000000001", "--listen", "127.0.0.1:7901", "--data", filepath.Join(t.TempDir(), "state"), "--new", "--bootstrap", path}
	cfg, err := parseConfig(args, testToken)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.New || cfg.Cluster != clusterID || len(cfg.Bootstrap) != 1 || cfg.Token != testToken {
		t.Fatal("configuration was not preserved")
	}
	for _, tail := range [][]string{{"--typo"}, {"unexpected"}} {
		if _, err := parseConfig(append(args, tail...), testToken); err == nil {
			t.Fatal("invalid CLI accepted", tail)
		}
	}
	if _, err := parseConfig(args, ""); err == nil {
		t.Fatal("missing environment credential accepted")
	}
}
