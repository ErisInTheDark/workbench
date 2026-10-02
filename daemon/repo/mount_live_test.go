package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// TestLiveMount needs the host driver (WinFsp or FUSE). Run with WORKBENCH_REPO_LIVE=1.
func TestLiveMount(t *testing.T) {
	if os.Getenv("WORKBENCH_REPO_LIVE") != "1" {
		t.Skip("set WORKBENCH_REPO_LIVE=1 to mount for real")
	}
	runner := requireGit(t)
	if requirement, err := probeDriver(); err != nil || requirement != "" {
		t.Fatalf("host driver unavailable (requirement %q, err %v)", requirement, err)
	}
	source := newSourceRepo(t, runner)
	nested := source.tree(treeSpec{"100644", "nested.txt", source.blob("nested\n")})
	root := source.tree(
		treeSpec{"100644", "README.md", source.blob("live readme\n")},
		treeSpec{"100644", "con", source.blob("reserved\n")},
		treeSpec{"040000", "dir", nested},
	)
	commit := source.commit(root, 1_700_000_000)
	source.setRef("refs/heads/main", commit)
	source.git(nil, "-C", source.dir, "symbolic-ref", "HEAD", "refs/heads/main")

	cache := t.TempDir()
	service := newRepoService(cache, runner)
	t.Cleanup(func() { _ = service.close() })
	ctx := context.Background()
	warmed, err := service.warm(ctx, source.url(), "main", "")
	if err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(warmed.Path)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	reserved := escapeName("con", hostUsesWindowsNames)
	for _, want := range []string{"README.md", "dir", reserved} {
		if !slices.Contains(names, want) {
			t.Fatalf("mounted listing %v lacks %q", names, want)
		}
	}
	if data, err := os.ReadFile(filepath.Join(warmed.Path, "dir", "nested.txt")); err != nil || string(data) != "nested\n" {
		t.Fatalf("nested read = %q, %v", data, err)
	}
	if data, err := os.ReadFile(filepath.Join(warmed.Path, reserved)); err != nil || string(data) != "reserved\n" {
		t.Fatalf("escaped read = %q, %v", data, err)
	}
	if info, err := os.Stat(filepath.Join(warmed.Path, "README.md")); err != nil || info.Size() != int64(len("live readme\n")) {
		t.Fatalf("stat = %v, %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(warmed.Path, "README.md"), []byte("changed"), 0o600); err == nil {
		t.Fatal("writing an existing file should fail")
	}
	if err := os.WriteFile(filepath.Join(warmed.Path, "new.txt"), []byte("new"), 0o600); err == nil {
		t.Fatal("creating a file should fail")
	}
	if err := os.Mkdir(filepath.Join(warmed.Path, "newdir"), 0o700); err == nil {
		t.Fatal("creating a directory should fail")
	}

	key, _ := parseKey(warmed.Key)
	if err := service.unmount(key, commit); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(warmed.Path, "README.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("content should be gone after unmount, got %v", err)
	}
	path, err := service.remount(ctx, key, commit)
	if err != nil || path != warmed.Path {
		t.Fatalf("remount = %q, %v", path, err)
	}
	if data, err := os.ReadFile(filepath.Join(path, "README.md")); err != nil || string(data) != "live readme\n" {
		t.Fatalf("read after remount = %q, %v", data, err)
	}
}
