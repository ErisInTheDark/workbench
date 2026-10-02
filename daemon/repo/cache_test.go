package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeMount struct {
	directory string
	unmounted bool
}

func (mount *fakeMount) unmount() error {
	mount.unmounted = true
	return nil
}

type serviceFixture struct {
	service *repoService
	mounts  *[]*fakeMount
}

func newServiceFixture(t *testing.T, runner gitRunner, root string) serviceFixture {
	t.Helper()
	var mounts []*fakeMount
	service := newRepoService(root, runner)
	service.mount = func(_ *snapshot, directory string) (mountedFS, error) {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, err
		}
		mount := &fakeMount{directory: directory}
		mounts = append(mounts, mount)
		return mount, nil
	}
	t.Cleanup(func() { _ = service.close() })
	return serviceFixture{service: service, mounts: &mounts}
}

func TestWarmPinsCommitsAndReusesLiveMounts(t *testing.T) {
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	first := source.simpleCommit("one\n", 1_700_000_000)
	fixture := newServiceFixture(t, runner, t.TempDir())
	ctx := context.Background()

	warmed, err := fixture.service.warm(ctx, source.url(), "main", "")
	if err != nil {
		t.Fatal(err)
	}
	if warmed.Commit != first || filepath.Base(warmed.Path) != first {
		t.Fatalf("warm = %+v, want commit %s in the path", warmed, first)
	}
	again, err := fixture.service.warm(ctx, source.url(), "", "")
	if err != nil || again.Path != warmed.Path || len(*fixture.mounts) != 1 {
		t.Fatalf("re-warming the same commit should reuse its mount (%+v, %v, %d mounts)", again, err, len(*fixture.mounts))
	}
	second := source.simpleCommit("two\n", 1_700_000_100, first)
	moved, err := fixture.service.warm(ctx, source.url(), "main", "")
	if err != nil || moved.Commit != second || moved.Path == warmed.Path {
		t.Fatalf("a moved ref should mount a new path (%+v, %v)", moved, err)
	}
	if (*fixture.mounts)[0].unmounted {
		t.Fatal("warming a newer commit must not unmount the older one")
	}
}

func TestRemountRestoresALeasedCommitWithoutTheRemote(t *testing.T) {
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	source.simpleCommit("one\n", 1_700_000_000)
	root := t.TempDir()
	first := newServiceFixture(t, runner, root)
	warmed, err := first.service.warm(context.Background(), source.url(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.service.close(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(source.dir); err != nil {
		t.Fatal(err)
	}
	restarted := newServiceFixture(t, runner, root)
	key, _ := parseKey(warmed.Key)
	path, err := restarted.service.remount(context.Background(), key, warmed.Commit)
	if err != nil || path != warmed.Path {
		t.Fatalf("remount = %q, %v; want %q", path, err, warmed.Path)
	}
}

func TestPrefetchFetchesOneSubtreeInOneBatch(t *testing.T) {
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	top, shallow, deep, other := source.blob("top\n"), source.blob("shallow\n"), source.blob("deep\n"), source.blob("other\n")
	deepTree := source.tree(treeSpec{mode: "100644", name: "c.txt", oid: deep})
	subTree := source.tree(
		treeSpec{mode: "100644", name: "b.txt", oid: shallow},
		treeSpec{mode: "040000", name: "deep", oid: deepTree},
	)
	otherTree := source.tree(treeSpec{mode: "100644", name: "d.txt", oid: other})
	root := source.tree(
		treeSpec{mode: "100644", name: "a.txt", oid: top},
		treeSpec{mode: "040000", name: "other", oid: otherTree},
		treeSpec{mode: "040000", name: "sub", oid: subTree},
	)
	source.setRef("refs/heads/main", source.commit(root, 1_700_000_000))
	source.git(nil, "-C", source.dir, "symbolic-ref", "HEAD", "refs/heads/main")
	fixture := newServiceFixture(t, runner, t.TempDir())
	ctx := context.Background()
	warmed, err := fixture.service.warm(ctx, source.url(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	key, _ := parseKey(warmed.Key)
	repo := fixture.service.repos[key].repo
	fetches := 0
	repo.blobs = newBlobFetcher(func(ctx context.Context, oids []string) error {
		fetches++
		return repo.fetchBlobs(ctx, oids)
	})

	if err := fixture.service.prefetch(ctx, key, warmed.Commit, "sub"); err != nil {
		t.Fatal(err)
	}
	if fetches != 1 {
		t.Fatalf("prefetch ran %d fetches, want one batch for the whole subtree", fetches)
	}
	for name, oid := range map[string]string{"sub/b.txt": shallow, "sub/deep/c.txt": deep} {
		if _, _, present, err := repo.reader.info(oid); err != nil || !present {
			t.Fatalf("%s should be present after prefetch (%v)", name, err)
		}
	}
	for name, oid := range map[string]string{"a.txt": top, "other/d.txt": other} {
		if _, _, present, err := repo.reader.info(oid); err != nil || present {
			t.Fatalf("%s outside the subtree should stay lazy (present=%v, %v)", name, present, err)
		}
	}
	if err := fixture.service.prefetch(ctx, key, warmed.Commit, "missing"); !errors.Is(err, errNotFound) {
		t.Fatalf("prefetching an absent path = %v, want not found", err)
	}
}

func TestEvictUnmountsAndDeletesOnlyThatRepository(t *testing.T) {
	runner := requireGit(t)
	kept, evicted := newSourceRepo(t, runner), newSourceRepo(t, runner)
	kept.simpleCommit("kept\n", 1_700_000_000)
	evicted.simpleCommit("evicted\n", 1_700_000_000)
	fixture := newServiceFixture(t, runner, t.TempDir())
	ctx := context.Background()
	keptResult, err := fixture.service.warm(ctx, kept.url(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	// Both sources are named source.git in different temp directories, so their keys differ by path.
	evictedResult, err := fixture.service.warm(ctx, evicted.url(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	key, _ := parseKey(evictedResult.Key)
	if err := fixture.service.evict(key); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fixture.service.gitPath(key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("evicted repository still exists: %v", err)
	}
	keptKey, _ := parseKey(keptResult.Key)
	if _, err := os.Stat(fixture.service.gitPath(keptKey)); err != nil {
		t.Fatalf("unrelated repository was removed: %v", err)
	}
	unmounted := 0
	for _, mount := range *fixture.mounts {
		if mount.unmounted {
			unmounted++
		}
	}
	if unmounted != 1 {
		t.Fatalf("expected exactly the evicted mount to unmount, got %d", unmounted)
	}
}

func TestSweepRemovesUnleasedOwnedCachesAndKeepsEverythingElse(t *testing.T) {
	runner := requireGit(t)
	leased, stale := newSourceRepo(t, runner), newSourceRepo(t, runner)
	leased.simpleCommit("leased\n", 1_700_000_000)
	stale.simpleCommit("stale\n", 1_700_000_000)
	root := t.TempDir()
	first := newServiceFixture(t, runner, root)
	ctx := context.Background()
	leasedResult, err := first.service.warm(ctx, leased.url(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	staleResult, err := first.service.warm(ctx, stale.url(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.service.close(); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(root, "git", "someone", "else.git")
	if err := os.MkdirAll(foreign, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "precious"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(root, "mounts", "host", "repo", leasedResult.Commit)
	if err := os.MkdirAll(leftover, 0o700); err != nil {
		t.Fatal(err)
	}

	restarted := newServiceFixture(t, runner, root)
	err = restarted.service.sweep([]string{leasedResult.Key})
	if err == nil {
		t.Fatal("sweep should report the cache entry it refused to delete")
	}
	leasedKey, _ := parseKey(leasedResult.Key)
	staleKey, _ := parseKey(staleResult.Key)
	if _, err := os.Stat(restarted.service.gitPath(leasedKey)); err != nil {
		t.Fatalf("leased repository was removed: %v", err)
	}
	if _, err := os.Stat(restarted.service.gitPath(staleKey)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unleased repository survived: %v", err)
	}
	if _, err := os.Stat(filepath.Join(foreign, "precious")); err != nil {
		t.Fatalf("a directory without the ownership marker was touched: %v", err)
	}
	if _, err := os.Stat(leftover); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("dead mount directory survived: %v", err)
	}
}
