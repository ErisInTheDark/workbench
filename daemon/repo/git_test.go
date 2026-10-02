package main

import (
	"context"
	"strings"
	"testing"
)

func TestResolveRefMatchesBranchesAndTagsExactly(t *testing.T) {
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	commit := source.simpleCommit("hello\n", 1_700_000_000)
	source.setRef("refs/heads/release", commit)
	source.setRef("refs/heads/feature/nested", commit)
	source.setRef("refs/tags/v1", commit)
	source.setRef("refs/heads/both", commit)
	source.setRef("refs/tags/both", commit)
	repo := openTestRepo(t, runner, source)
	ctx := context.Background()

	cases := []struct{ ref, kind, want string }{
		{"", "", "HEAD"},
		{"release", "", "refs/heads/release"},
		{"feature/nested", "", "refs/heads/feature/nested"},
		{"v1", "", "refs/tags/v1"},
		{"both", "branch", "refs/heads/both"},
		{"both", "tag", "refs/tags/both"},
	}
	for _, entry := range cases {
		got, err := repo.resolveRef(ctx, entry.ref, entry.kind)
		if err != nil || got != entry.want {
			t.Fatalf("resolveRef(%q, %q) = %q, %v; want %q", entry.ref, entry.kind, got, err, entry.want)
		}
	}
	if _, err := repo.resolveRef(ctx, "both", ""); err == nil || !strings.Contains(err.Error(), "--kind") {
		t.Fatalf("an ambiguous ref should ask for --kind, got %v", err)
	}
	// "nested" is only a suffix of a real branch and must not match it.
	for _, ref := range []string{"nested", "missing", "v1"} {
		kind := ""
		if ref == "v1" {
			kind = "branch"
		}
		if _, err := repo.resolveRef(ctx, ref, kind); err == nil {
			t.Fatalf("resolveRef(%q, %q) should fail", ref, kind)
		}
	}
	for _, ref := range []string{"-upload-pack=evil", "a..b", "a b", "bad~1"} {
		if _, err := repo.resolveRef(ctx, ref, ""); err == nil {
			t.Fatalf("invalid ref %q was accepted", ref)
		}
	}
}

func TestFetchRefPinsEachCommitAsTheRemoteMoves(t *testing.T) {
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	first := source.simpleCommit("one\n", 1_700_000_000)
	repo := openTestRepo(t, runner, source)
	ctx := context.Background()

	got, err := repo.fetchRef(ctx, "refs/heads/main")
	if err != nil || got != first {
		t.Fatalf("first fetch = %q, %v; want %q", got, err, first)
	}
	second := source.simpleCommit("two\n", 1_700_000_100, first)
	got, err = repo.fetchRef(ctx, "refs/heads/main")
	if err != nil || got != second {
		t.Fatalf("second fetch = %q, %v; want %q", got, err, second)
	}
	for _, commit := range []string{first, second} {
		info, err := repo.readCommit(commit)
		if err != nil || info.tree == "" {
			t.Fatalf("pinned commit %s is unreadable: %v", commit, err)
		}
	}
	if info, _ := repo.readCommit(second); info.modified.Unix() != 1_700_000_100 {
		t.Fatalf("commit time = %v", info.modified)
	}
}

func TestBlobsStayRemoteUntilRead(t *testing.T) {
	runner := requireGit(t)
	source := newSourceRepo(t, runner)
	source.simpleCommit("lazy content\n", 1_700_000_000)
	blob := source.blob("lazy content\n")
	repo := openTestRepo(t, runner, source)
	ctx := context.Background()
	if _, err := repo.fetchRef(ctx, "refs/heads/main"); err != nil {
		t.Fatal(err)
	}
	if _, _, present, err := repo.reader.info(blob); err != nil || present {
		t.Fatalf("blob should be absent after a blob:none fetch (present=%v, err=%v)", present, err)
	}
	if err := repo.ensureBlobs(ctx, []string{blob}); err != nil {
		t.Fatal(err)
	}
	kind, data, present, err := repo.reader.contents(blob)
	if err != nil || !present || kind != "blob" || string(data) != "lazy content\n" {
		t.Fatalf("blob read = %q %q %v %v", kind, data, present, err)
	}
}

func TestGitFailureDetailOmitsUserinfo(t *testing.T) {
	detail := sanitizeGitDetail([]byte("fatal: unable to access 'https://user:secret@host/x/': 403\n"))
	if strings.Contains(detail, "secret") || strings.Contains(detail, "user") {
		t.Fatalf("credential leaked into %q", detail)
	}
}
