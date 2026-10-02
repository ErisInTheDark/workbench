// No exports. Own test fixtures: plumbing-built source repositories served over file:// with partial-clone support.
package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type sourceRepo struct {
	t      *testing.T
	dir    string
	runner gitRunner
}

type treeSpec struct {
	mode string
	name string
	oid  string
}

// requireGit isolates git from user configuration and skips when git is too old for lazy-fetch control.
func requireGit(t *testing.T) gitRunner {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Workbench")
	t.Setenv("GIT_AUTHOR_EMAIL", "workbench@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Workbench")
	t.Setenv("GIT_COMMITTER_EMAIL", "workbench@example.invalid")
	runner := gitRunner{executable: "git", allowFile: true}
	present, err := probeGit(context.Background(), runner)
	if err != nil || !present {
		t.Skip("git 2.44+ is required")
	}
	return runner
}

func newSourceRepo(t *testing.T, runner gitRunner) *sourceRepo {
	t.Helper()
	source := &sourceRepo{t: t, dir: filepath.Join(t.TempDir(), "source.git"), runner: runner}
	source.git(nil, "init", "--bare", "--quiet", source.dir)
	source.git(nil, "-C", source.dir, "config", "uploadpack.allowFilter", "true")
	source.git(nil, "-C", source.dir, "config", "uploadpack.allowAnySHA1InWant", "true")
	return source
}

func (source *sourceRepo) git(stdin *string, args ...string) string {
	source.t.Helper()
	var input io.Reader
	if stdin != nil {
		input = strings.NewReader(*stdin)
	}
	output, err := source.runner.run(context.Background(), "", input, args...)
	if err != nil {
		source.t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output))
}

func (source *sourceRepo) blob(content string) string {
	return source.git(&content, "-C", source.dir, "hash-object", "-w", "--stdin")
}

func (source *sourceRepo) tree(entries ...treeSpec) string {
	var builder strings.Builder
	for _, entry := range entries {
		kind := "blob"
		switch entry.mode {
		case "040000":
			kind = "tree"
		case "160000":
			kind = "commit"
		}
		builder.WriteString(entry.mode + " " + kind + " " + entry.oid + "\t" + entry.name + "\x00")
	}
	input := builder.String()
	args := []string{"-C", source.dir, "mktree", "-z"}
	for _, entry := range entries {
		if entry.mode == "160000" {
			args = append(args, "--missing")
			break
		}
	}
	return source.git(&input, args...)
}

func (source *sourceRepo) commit(tree string, seconds int64, parents ...string) string {
	source.t.Setenv("GIT_COMMITTER_DATE", formatGitDate(seconds))
	source.t.Setenv("GIT_AUTHOR_DATE", formatGitDate(seconds))
	message := "fixture\n"
	args := []string{"-C", source.dir, "commit-tree", tree}
	for _, parent := range parents {
		args = append(args, "-p", parent)
	}
	return source.git(&message, args...)
}

func formatGitDate(seconds int64) string {
	return "@" + strconv.FormatInt(seconds, 10) + " +0000"
}

func (source *sourceRepo) setRef(name string, oid string) {
	source.git(nil, "-C", source.dir, "update-ref", name, oid)
}

func (source *sourceRepo) url() string {
	return "file:///" + strings.TrimPrefix(filepath.ToSlash(source.dir), "/")
}

// simpleCommit publishes one README commit on refs/heads/main and points HEAD at it.
func (source *sourceRepo) simpleCommit(content string, seconds int64, parents ...string) string {
	tree := source.tree(treeSpec{mode: "100644", name: "README.md", oid: source.blob(content)})
	commit := source.commit(tree, seconds, parents...)
	source.setRef("refs/heads/main", commit)
	source.git(nil, "-C", source.dir, "symbolic-ref", "HEAD", "refs/heads/main")
	return commit
}

// openTestRepo opens a cache repository pointed at source, as warm would.
func openTestRepo(t *testing.T, runner gitRunner, source *sourceRepo) *gitRepo {
	t.Helper()
	repo, err := openRepo(context.Background(), runner, filepath.Join(t.TempDir(), "cache.git"), source.url())
	if err != nil {
		t.Fatalf("open repo: %v", err)
	}
	t.Cleanup(repo.close)
	return repo
}
