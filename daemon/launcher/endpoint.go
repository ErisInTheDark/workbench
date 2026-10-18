// No exports. Local daemon discovery so wb follows daemon restarts without trusting an inherited origin.
// Mirrors package/workbench-data-root.mjs, shared/http/workbench-daemon-endpoint.ts,
// shared/process/workbench-daemon-endpoint.ts and shared/process/verify-workbench-daemon-endpoint.ts.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	maxPublicationBytes = 16_384
	healthTimeout       = 2 * time.Second
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type daemonEndpoint struct {
	Version    int    `json:"version"`
	InstanceID string `json:"instanceId"`
	PID        int64  `json:"pid"`
	Origin     string `json:"origin"`
}

func resolveOrigin() (string, error) {
	root, err := dataRoot()
	if err != nil {
		return "", err
	}
	endpoint, err := readEndpoint(filepath.Join(root, "daemon", "runtime.json"))
	if err != nil {
		return "", err
	}
	if endpoint == nil {
		return "", errors.New("The Workbench daemon has not published an endpoint.")
	}
	if err := verifyEndpoint(*endpoint); err != nil {
		return "", fmt.Errorf("The published daemon endpoint is stale or unreachable (%v) Run `wb ports` to inspect active listeners; do not restart Workbench automatically.", err)
	}
	return endpoint.Origin, nil
}

func dataRoot() (string, error) {
	if override := strings.TrimSpace(os.Getenv("WORKBENCH_DATA_ROOT")); override != "" {
		return filepath.Abs(override)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("Workbench data root could not be resolved: %w", err)
	}
	if runtime.GOOS == "windows" {
		base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Abs(filepath.Join(base, "inthedark", "wb"))
	}
	base := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if base == "" || !filepath.IsAbs(base) {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "inthedark", "wb"), nil
}

func readEndpoint(file string) (*daemonEndpoint, error) {
	handle, err := os.Open(file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("Local daemon endpoint could not be opened.")
	}
	defer handle.Close()
	data, err := io.ReadAll(io.LimitReader(handle, maxPublicationBytes+1))
	if err != nil {
		return nil, errors.New("Local daemon endpoint could not be opened.")
	}
	if len(data) > maxPublicationBytes {
		return nil, errors.New("Local daemon endpoint exceeds its size limit.")
	}
	endpoint, err := parseEndpoint(data)
	if err != nil {
		return nil, errors.New("Local daemon endpoint is invalid.")
	}
	return &endpoint, nil
}

// A publication is only trusted while the daemon's health response still names the same process instance.
func verifyEndpoint(published daemonEndpoint) error {
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirected") },
		Timeout:       healthTimeout,
		Transport:     &http.Transport{},
	}
	response, err := client.Get(published.Origin + "/healthz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("Daemon health endpoint is unavailable.")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPublicationBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxPublicationBytes {
		return errors.New("Daemon health response exceeds its size limit.")
	}
	actual, err := parseEndpoint(data)
	if err != nil {
		return errors.New("Daemon health response is invalid.")
	}
	if actual != published {
		return errors.New("Daemon health identity does not match its publication.")
	}
	return nil
}

func parseEndpoint(data []byte) (daemonEndpoint, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var endpoint daemonEndpoint
	if err := decoder.Decode(&endpoint); err != nil {
		return endpoint, err
	}
	if decoder.More() {
		return endpoint, errors.New("trailing data")
	}
	if endpoint.Version != 1 || !uuidPattern.MatchString(endpoint.InstanceID) || endpoint.PID < 1 || !isLoopbackOrigin(endpoint.Origin) {
		return endpoint, errors.New("invalid endpoint")
	}
	return endpoint, nil
}

func isLoopbackOrigin(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" {
		return false
	}
	port, err := strconv.Atoi(parsed.Port())
	return err == nil && port > 0 && port <= 65_535 && value == "http://127.0.0.1:"+strconv.Itoa(port)
}
