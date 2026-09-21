//go:build !windows

// No exports. Restrict network credentials to the process user on Unix hosts.
package main

import (
	"errors"
	"os"
)

func trustCurrentUserRoot(encoded []byte) error {
	return errors.New("install the downloaded private CA using this device's certificate settings")
}

func protectPrivatePath(path string, directory bool) error {
	if directory {
		return os.Chmod(path, 0700)
	}
	return os.Chmod(path, 0600)
}
