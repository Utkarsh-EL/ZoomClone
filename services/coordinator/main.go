package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/hashicorp/raft"
)

func parseConfig(args []string, token string) (nodeConfig, error) {
	var cfg nodeConfig
	var bootstrap, routesFile string
	flags := flag.NewFlagSet("coordinator", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.Cluster, "cluster", "", "stable cluster UUID")
	flags.StringVar(&cfg.ID, "id", "", "stable coordinator UUID")
	flags.StringVar(&cfg.Address, "listen", "", "literal loopback host:port")
	flags.StringVar(&cfg.DataDir, "data", "", "persistent node directory")
	flags.BoolVar(&cfg.New, "new", false, "explicitly initialize a new node in a new directory")
	flags.StringVar(&bootstrap, "bootstrap", "", "initial voter JSON file; only with --new")
	flags.StringVar(&routesFile, "routes", "", "source-specific logical-to-proxy endpoint JSON file")
	if err := flags.Parse(args); err != nil {
		return cfg, err
	}
	if flags.NArg() != 0 {
		return cfg, fmt.Errorf("unexpected positional arguments")
	}
	cfg.Token = token
	if len(token) < 32 {
		return cfg, fmt.Errorf("ZOOM_CLUSTER_TOKEN must contain at least 32 bytes")
	}
	if routesFile != "" {
		file, err := os.Open(routesFile)
		if err != nil {
			return cfg, err
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 65537))
		if err != nil {
			return cfg, err
		}
		if len(data) > 65536 {
			return cfg, fmt.Errorf("route file too large")
		}
		var routes map[string]string
		if err := decodeStrict(data, &routes); err != nil {
			return cfg, err
		}
		cfg.Routes, err = validateRoutes(routes)
		if err != nil {
			return cfg, err
		}
	}
	if bootstrap != "" {
		if !cfg.New {
			return cfg, fmt.Errorf("--bootstrap requires --new; never bootstrap during restart")
		}
		file, err := os.Open(bootstrap)
		if err != nil {
			return cfg, err
		}
		defer file.Close()
		b, err := io.ReadAll(io.LimitReader(file, 65537))
		if err != nil {
			return cfg, err
		}
		if len(b) > 65536 {
			return cfg, fmt.Errorf("bootstrap file too large")
		}
		var peers []struct {
			ID      string `json:"id"`
			Address string `json:"address"`
		}
		if err := decodeStrict(b, &peers); err != nil {
			return cfg, err
		}
		if len(peers) == 0 {
			return cfg, fmt.Errorf("bootstrap requires at least one voter")
		}
		for _, p := range peers {
			cfg.Bootstrap = append(cfg.Bootstrap, raft.Server{ID: raft.ServerID(p.ID), Address: raft.ServerAddress(p.Address), Suffrage: raft.Voter})
		}
	}
	return cfg, nil
}

func run(ctx context.Context, args []string, token string) error {
	cfg, err := parseConfig(args, token)
	if err != nil {
		return err
	}
	cfg.Output = os.Stdout
	n, err := openNode(cfg)
	if err != nil {
		return err
	}
	defer n.close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"event": "helper.started", "nodeId": cfg.ID,
		"clusterId": cfg.Cluster, "incarnation": n.wire.incarnation, "address": n.address, "pid": os.Getpid()}); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Getenv("ZOOM_CLUSTER_TOKEN")); err != nil {
		fmt.Fprintln(os.Stderr, "coordinator:", err)
		os.Exit(1)
	}
}
