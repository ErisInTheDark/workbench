// No exports. `workbench-relay -- <command> [args...]` runs one sandboxed command with host loopback relayed into its
// network namespace, its own loopback listeners exposed to the host through the daemon's broker, and loopback kept off
// Codex's proxy.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
)

func main() {
	os.Exit(run(os.Args[1:], os.Environ(), os.Stdin, os.Stdout, os.Stderr, defaultDependencies()))
}

func run(args []string, environ []string, stdin io.Reader, stdout io.Writer, stderr io.Writer, deps dependencies) int {
	if len(args) < 2 || args[0] != "--" {
		fmt.Fprintln(stderr, "usage: workbench-relay -- <command> [args...]")
		return 2
	}
	relay, err := startRelay(environment(environ), deps, stderr)
	childEnv := withoutRelayConfig(environ)
	if err != nil {
		fmt.Fprintf(stderr, "workbench relay unavailable: %v\n", err)
	} else {
		defer relay.close()
		childEnv = withLoopbackProxyBypass(childEnv)
	}
	return runChild(args[1:], childEnv, stdin, stdout, stderr)
}

var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// withLoopbackProxyBypass keeps loopback off Codex's forward proxy, which drops protocol upgrades; the relay
// already makes host ports and the command's own listeners directly reachable.
func withLoopbackProxyBypass(environ []string) []string {
	bypassed := make([]string, 0, len(environ)+2)
	seen := map[string]bool{}
	for _, entry := range environ {
		key, value, _ := strings.Cut(entry, "=")
		if key == "NO_PROXY" || key == "no_proxy" {
			seen[key] = true
			entry = key + "=" + withLoopbackHosts(value)
		}
		bypassed = append(bypassed, entry)
	}
	for _, key := range []string{"NO_PROXY", "no_proxy"} {
		if !seen[key] {
			bypassed = append(bypassed, key+"="+withLoopbackHosts(""))
		}
	}
	return bypassed
}

func withLoopbackHosts(value string) string {
	hosts := []string{}
	present := map[string]bool{}
	for _, host := range strings.Split(value, ",") {
		if host = strings.TrimSpace(host); host != "" && !present[host] {
			present[host] = true
			hosts = append(hosts, host)
		}
	}
	for _, host := range loopbackHosts {
		if !present[host] {
			hosts = append(hosts, host)
		}
	}
	return strings.Join(hosts, ",")
}

func environment(environ []string) map[string]string {
	env := make(map[string]string, len(environ))
	for _, entry := range environ {
		if key, value, found := strings.Cut(entry, "="); found {
			env[key] = value
		}
	}
	return env
}

func withoutRelayConfig(environ []string) []string {
	kept := make([]string, 0, len(environ))
	for _, entry := range environ {
		if !strings.HasPrefix(entry, relayEnvKey+"=") {
			kept = append(kept, entry)
		}
	}
	return kept
}

// runChild runs the command in the foreground, forwarding termination signals and its exit status.
func runChild(argv []string, environ []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	command := exec.Command(argv[0], argv[1:]...)
	command.Env = environ
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	if err := command.Start(); err != nil {
		fmt.Fprintf(stderr, "workbench relay: %v\n", err)
		if errors.Is(err, exec.ErrNotFound) {
			return 127
		}
		return 126
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case received := <-signals:
				_ = command.Process.Signal(received)
			case <-done:
				return
			}
		}
	}()
	if err := command.Wait(); err != nil && command.ProcessState == nil {
		fmt.Fprintf(stderr, "workbench relay: %v\n", err)
		return 1
	}
	return exitCode(command.ProcessState)
}

func exitCode(state *os.ProcessState) int {
	if code := state.ExitCode(); code >= 0 {
		return code
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return 1
}
