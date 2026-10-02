//go:build windows

// No exports. Own Windows host edges: WinFsp detection and windowless child processes.
package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

const hostUsesWindowsNames = true

// probeDriver mirrors cgofuse's own WinFsp lookup: the 32-bit registry view
// holds InstallDir, and the x64 DLL lives under its bin directory.
func probeDriver() (requirement string, err error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\WinFsp`, registry.QUERY_VALUE|registry.WOW64_32KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return "winfsp", nil
	}
	if err != nil {
		return "", err
	}
	defer key.Close()
	directory, _, err := key.GetStringValue("InstallDir")
	if errors.Is(err, registry.ErrNotExist) {
		return "winfsp", nil
	}
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(directory, "bin", "winfsp-x64.dll")); errors.Is(err, os.ErrNotExist) {
		return "winfsp", nil
	} else if err != nil {
		return "", err
	}
	return "", nil
}

// hideWindow keeps git children from flashing consoles when the sidecar itself has none.
func hideWindow(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
