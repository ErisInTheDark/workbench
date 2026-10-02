package main

import (
	"context"
	"errors"
	"slices"
	"testing"
)

type vfsFixture struct {
	snap    *snapshot
	fetches *int
}

func newVFSFixture(t *testing.T, windows bool) vfsFixture {
	t.Helper()
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	nested := source.tree(
		treeSpec{"100644", "nested.txt", source.blob("nested\n")},
		treeSpec{"120000", "up", source.blob("../README.md")},
	)
	gitlinkTarget := source.simpleCommit("submodule\n", 1_600_000_000)
	root := source.tree(
		treeSpec{"100644", "README.md", source.blob("readme\n")},
		treeSpec{"100755", "run.sh", source.blob("#!/bin/sh\n")},
		treeSpec{"100644", "con", source.blob("reserved\n")},
		treeSpec{"100644", "a:b", source.blob("colon\n")},
		treeSpec{"040000", "dir", nested},
		treeSpec{"160000", "sub", gitlinkTarget},
		treeSpec{"120000", "link-in", source.blob("README.md")},
		treeSpec{"120000", "link-out", source.blob("../../outside")},
		treeSpec{"120000", "link-abs", source.blob("/etc/passwd")},
	)
	commit := source.commit(root, 1_700_000_000)
	source.setRef("refs/heads/main", commit)
	repo := openTestRepo(t, runner, source)
	fetches := 0
	fetch := repo.blobs.fetch
	repo.blobs.fetch = func(ctx context.Context, oids []string) error {
		fetches++
		return fetch(ctx, oids)
	}
	if _, err := repo.fetchRef(context.Background(), "refs/heads/main"); err != nil {
		t.Fatal(err)
	}
	snap, err := newSnapshot(repo, commit, windows)
	if err != nil {
		t.Fatal(err)
	}
	return vfsFixture{snap: snap, fetches: &fetches}
}

func TestSnapshotListsHostSafeNamesWithOneFetchPerDirectory(t *testing.T) {
	fixture := newVFSFixture(t, true)
	ctx := context.Background()
	entries, nodes, err := fixture.snap.children(ctx, fixture.snap.root())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	sizes := map[string]int64{}
	for index, entry := range entries {
		names = append(names, entry.display)
		sizes[entry.display] = nodes[index].size
	}
	for _, want := range []string{"~63on", "a~3Ab", "README.md", "dir", "sub"} {
		if !slices.Contains(names, want) {
			t.Fatalf("listing %v lacks %q", names, want)
		}
	}
	if *fixture.fetches != 1 {
		t.Fatalf("listing a directory took %d fetches, want 1", *fixture.fetches)
	}
	if sizes["README.md"] != int64(len("readme\n")) || sizes["link-in"] != int64(len("README.md")) {
		t.Fatalf("unexpected sizes %v", sizes)
	}
	reserved, err := fixture.snap.resolve(ctx, "/~63on")
	if err != nil {
		t.Fatal(err)
	}
	if data, err := fixture.snap.read(ctx, reserved); err != nil || string(data) != "reserved\n" {
		t.Fatalf("read escaped name = %q, %v", data, err)
	}
	if *fixture.fetches != 1 {
		t.Fatalf("reading an already-listed file fetched again (%d fetches)", *fixture.fetches)
	}
}

func TestSnapshotMetadataAndSpecialEntries(t *testing.T) {
	fixture := newVFSFixture(t, false)
	ctx := context.Background()
	script, err := fixture.snap.resolve(ctx, "run.sh")
	if err != nil || script.kind != nodeFile || !script.executable {
		t.Fatalf("run.sh = %+v, %v", script, err)
	}
	if fixture.snap.modified.Unix() != 1_700_000_000 {
		t.Fatalf("snapshot time = %v", fixture.snap.modified)
	}
	sub, err := fixture.snap.resolve(ctx, "sub")
	if err != nil || sub.kind != nodeDirectory {
		t.Fatalf("gitlink = %+v, %v", sub, err)
	}
	if entries, _, err := fixture.snap.children(ctx, sub); err != nil || len(entries) != 0 {
		t.Fatalf("gitlink should be an empty directory, got %v, %v", entries, err)
	}
	nested, err := fixture.snap.resolve(ctx, "/dir/nested.txt")
	if err != nil {
		t.Fatal(err)
	}
	if data, err := fixture.snap.read(ctx, nested); err != nil || string(data) != "nested\n" {
		t.Fatalf("nested read = %q, %v", data, err)
	}
	again, _ := fixture.snap.resolve(ctx, "dir/nested.txt")
	if again.inode != nested.inode || nested.inode == fixture.snap.root().inode {
		t.Fatal("inodes should be stable per path and distinct from the root")
	}
	if _, err := fixture.snap.resolve(ctx, "dir/missing"); !errors.Is(err, errNotFound) {
		t.Fatalf("missing path error = %v", err)
	}
	if _, err := fixture.snap.resolve(ctx, "README.md/child"); !errors.Is(err, errNotDir) {
		t.Fatalf("file-as-directory error = %v", err)
	}
}

func TestSnapshotSymlinksStayInsideTheSnapshot(t *testing.T) {
	fixture := newVFSFixture(t, false)
	ctx := context.Background()
	for path, want := range map[string]string{"link-in": "README.md", "dir/up": "../README.md"} {
		item, err := fixture.snap.resolve(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		if target, err := fixture.snap.readlink(ctx, item); err != nil || target != want {
			t.Fatalf("readlink(%s) = %q, %v", path, target, err)
		}
	}
	for _, path := range []string{"link-out", "link-abs"} {
		item, err := fixture.snap.resolve(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.snap.readlink(ctx, item); !errors.Is(err, errEscape) {
			t.Fatalf("readlink(%s) should refuse to escape, got %v", path, err)
		}
	}
}
