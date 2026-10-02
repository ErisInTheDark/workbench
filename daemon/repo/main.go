// No exports. Own the sidecar entrypoint: one-shot host probe, or a served repository cache bound to its parent pipe.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

type probeResult struct {
	Status      string `json:"status"`
	Requirement string `json:"requirement,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: workbench-repo probe | serve --cache-dir <absolute path>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "probe":
		encoded, _ := json.Marshal(probe(context.Background(), gitRunner{executable: "git"}))
		fmt.Println(string(encoded))
	case "serve":
		if err := serve(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "Workbench repository process failed:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		os.Exit(2)
	}
}

// probe reports the first missing prerequisite; check failures are never
// reported as missing, so settings never sends users to install something present.
func probe(ctx context.Context, runner gitRunner) probeResult {
	requirement, err := probeDriver()
	if err != nil {
		return probeResult{Status: "checkFailed"}
	}
	if requirement != "" {
		return probeResult{Status: "missing", Requirement: requirement}
	}
	present, err := probeGit(ctx, runner)
	if err != nil {
		return probeResult{Status: "checkFailed"}
	}
	if !present {
		return probeResult{Status: "missing", Requirement: "git"}
	}
	return probeResult{Status: "available"}
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	cacheDirectory := flags.String("cache-dir", "", "repository cache directory")
	allowFile := flags.Bool("allow-file-remotes", false, "accept file:// remotes (tests only)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *cacheDirectory == "" || !filepath.IsAbs(*cacheDirectory) {
		return errors.New("an absolute cache directory is required")
	}
	if err := os.MkdirAll(*cacheDirectory, 0o700); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	service := newRepoService(filepath.Clean(*cacheDirectory), gitRunner{executable: "git", allowFile: *allowFile})
	protocolErr := serveProtocol(ctx, os.Stdin, os.Stdout, service.dispatch)
	return errors.Join(protocolErr, service.close())
}

func (service *repoService) dispatch(ctx context.Context, action string, payload json.RawMessage) (any, error) {
	switch action {
	case "warm":
		var request struct {
			URL  string `json:"url"`
			Ref  string `json:"ref"`
			Kind string `json:"kind"`
		}
		if err := decodeStrict(payload, &request); err != nil {
			return nil, err
		}
		return service.warm(ctx, request.URL, request.Ref, request.Kind)
	case "remount", "unmount":
		var request struct {
			Key    string `json:"key"`
			Commit string `json:"commit"`
		}
		if err := decodeStrict(payload, &request); err != nil {
			return nil, err
		}
		key, err := parseKey(request.Key)
		if err != nil {
			return nil, err
		}
		if action == "unmount" {
			return struct{}{}, service.unmount(key, request.Commit)
		}
		path, err := service.remount(ctx, key, request.Commit)
		return struct {
			Path string `json:"path"`
		}{path}, err
	case "evict":
		var request struct {
			Key string `json:"key"`
		}
		if err := decodeStrict(payload, &request); err != nil {
			return nil, err
		}
		key, err := parseKey(request.Key)
		if err != nil {
			return nil, err
		}
		return struct{}{}, service.evict(key)
	case "sweep":
		var request struct {
			Keep []string `json:"keep"`
		}
		if err := decodeStrict(payload, &request); err != nil {
			return nil, err
		}
		return struct{}{}, service.sweep(request.Keep)
	default:
		return nil, errors.New("unknown action")
	}
}
