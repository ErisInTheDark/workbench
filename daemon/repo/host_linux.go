//go:build linux

// No exports. Own Linux host edges: FUSE device and unprivileged mount helper detection.
package main

import (
	"errors"
	"os"
	"os/exec"
)

const hostUsesWindowsNames = false

func probeDriver() (requirement string, err error) {
	if _, err := os.Stat("/dev/fuse"); errors.Is(err, os.ErrNotExist) {
		return "fuse", nil
	} else if err != nil {
		return "", err
	}
	if _, err := exec.LookPath("fusermount3"); err == nil {
		return "", nil
	}
	if _, err := exec.LookPath("fusermount"); err == nil {
		return "", nil
	}
	return "fuse", nil
}

func hideWindow(*exec.Cmd) {}
