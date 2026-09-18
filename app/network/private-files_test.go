// No exports. Protect private-file replacement and reject redirected state before creating descendants.
package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateFileReplacementAndKeyPersistence(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "private")
	destination := filepath.Join(directory, "credential")
	if err := writePrivateFile(destination, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(destination, []byte("second")); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(destination)
	if err != nil || string(body) != "second" {
		t.Fatal("private replacement did not persist the complete new content")
	}
	first, _, err := persistentLeafRequest(directory, "desktop.wb.inthedark.boo")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := persistentLeafRequest(directory, "desktop.wb.inthedark.boo")
	if err != nil || !first.Equal(second) {
		t.Fatal("reopening setup silently changed the installation certificate key")
	}
}

func TestPrivateDirectoryRejectsRedirectBeforeWriting(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	redirect := filepath.Join(root, "redirect")
	if err := os.Symlink(outside, redirect); err != nil {
		if errors.Is(err, os.ErrPermission) {
			t.Skip("this host does not permit test-owned symlinks")
		}
		t.Fatal(err)
	}
	if err := ensurePrivateDirectory(filepath.Join(redirect, "must-not-exist")); err == nil {
		t.Fatal("redirected state directory was accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "must-not-exist")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("redirected directory was written before being rejected")
	}
}
