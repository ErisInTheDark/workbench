// No exports. Own the system git CLI edge: partial bare repositories, exact ref pinning and object reads.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// gitRunner runs the system git with prompts disabled and lazy promisor fetches off,
// so missing blobs surface to the batcher instead of one network round trip each.
type gitRunner struct {
	executable string
	allowFile  bool
}

type gitError struct {
	operation string
	detail    string
}

func (err *gitError) Error() string {
	if err.detail == "" {
		return "git " + err.operation + " failed"
	}
	return "git " + err.operation + " failed: " + err.detail
}

var credentialPattern = regexp.MustCompile(`://[^/\s@]+@`)

// sanitizeGitDetail keeps one bounded stderr line and strips URL userinfo.
func sanitizeGitDetail(stderr []byte) string {
	lines := strings.Split(strings.TrimSpace(string(stderr)), "\n")
	line := ""
	for index := len(lines) - 1; index >= 0; index-- {
		if candidate := strings.TrimSpace(lines[index]); candidate != "" {
			line = candidate
			break
		}
	}
	line = credentialPattern.ReplaceAllString(line, "://")
	if len(line) > 240 {
		line = line[:240] + "..."
	}
	return line
}

func (runner gitRunner) command(ctx context.Context, directory string, args ...string) *exec.Cmd {
	// A background daemon must never block on credential UI; agents see an access error instead.
	full := append([]string{"-c", "credential.interactive=never"}, args...)
	if runner.allowFile {
		full = append([]string{"-c", "protocol.file.allow=always"}, full...)
	}
	var command *exec.Cmd
	if ctx == nil {
		command = exec.Command(runner.executable, full...)
	} else {
		command = exec.CommandContext(ctx, runner.executable, full...)
	}
	command.Dir = directory
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_NO_LAZY_FETCH=1", "GCM_INTERACTIVE=never")
	hideWindow(command)
	return command
}

func (runner gitRunner) run(ctx context.Context, directory string, stdin io.Reader, args ...string) ([]byte, error) {
	command := runner.command(ctx, directory, args...)
	var stdout, stderr bytes.Buffer
	command.Stdin = stdin
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &gitError{operation: args[0], detail: sanitizeGitDetail(stderr.Bytes())}
	}
	return stdout.Bytes(), nil
}

var gitVersionPattern = regexp.MustCompile(`git version (\d+)\.(\d+)`)

// probeGit requires 2.44+, the first release honouring GIT_NO_LAZY_FETCH.
func probeGit(ctx context.Context, runner gitRunner) (present bool, err error) {
	if _, err := exec.LookPath(runner.executable); err != nil {
		return false, nil
	}
	output, err := runner.run(ctx, "", nil, "--version")
	if err != nil {
		return false, err
	}
	match := gitVersionPattern.FindSubmatch(output)
	if match == nil {
		return false, errors.New("unrecognised git version output")
	}
	major, _ := strconv.Atoi(string(match[1]))
	minor, _ := strconv.Atoi(string(match[2]))
	return major > 2 || (major == 2 && minor >= 44), nil
}

// gitRepo is one Workbench-owned bare partial clone. Fetches are serialized
// because depth-limited fetches share the shallow lock.
type gitRepo struct {
	runner    gitRunner
	directory string
	fetchMu   sync.Mutex
	reader    *objectReader
	blobs     *blobFetcher
}

const ownedMarker = "workbench.owned"

func randomSuffix() string {
	random := make([]byte, 6)
	_, _ = rand.Read(random)
	return hex.EncodeToString(random)
}

// openRepo opens or creates the bare repository. A remote is required to create one.
func openRepo(ctx context.Context, runner gitRunner, directory string, remote string) (*gitRepo, error) {
	if _, err := os.Stat(directory); errors.Is(err, os.ErrNotExist) {
		if remote == "" {
			return nil, errors.New("repository is not cached; warm it again")
		}
		if err := createRepo(ctx, runner, directory, remote); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else if !isOwnedRepo(runner, directory) {
		return nil, errors.New("cache entry is not a Workbench-owned repository")
	}
	repo := &gitRepo{runner: runner, directory: directory}
	repo.reader = &objectReader{runner: runner, directory: directory}
	repo.blobs = newBlobFetcher(repo.fetchBlobs)
	return repo, nil
}

func createRepo(ctx context.Context, runner gitRunner, directory string, remote string) error {
	if err := os.MkdirAll(filepath.Dir(directory), 0o700); err != nil {
		return err
	}
	temporary := directory + ".tmp-" + randomSuffix()
	if _, err := runner.run(ctx, "", nil, "init", "--bare", "--quiet", temporary); err != nil {
		return err
	}
	settings := [][2]string{
		{"core.repositoryformatversion", "1"},
		{"extensions.partialClone", "origin"},
		{"remote.origin.url", remote},
		{"remote.origin.promisor", "true"},
		{"remote.origin.partialclonefilter", "blob:none"},
		{"gc.auto", "0"},
		{"maintenance.auto", "false"},
		{"fetch.writeCommitGraph", "false"},
		{ownedMarker, "true"},
	}
	for _, setting := range settings {
		if _, err := runner.run(ctx, temporary, nil, "config", setting[0], setting[1]); err != nil {
			_ = os.RemoveAll(temporary)
			return err
		}
	}
	if err := os.Rename(temporary, directory); err != nil {
		_ = os.RemoveAll(temporary)
		return err
	}
	return nil
}

// isOwnedRepo names the git dir explicitly so a non-repository can never
// borrow an enclosing repository's config through discovery.
func isOwnedRepo(runner gitRunner, directory string) bool {
	output, err := runner.run(context.Background(), "", nil, "--git-dir="+directory, "config", "--local", "--bool", ownedMarker)
	return err == nil && strings.TrimSpace(string(output)) == "true"
}

// setRemote adopts the newest remote spelling for the same key, such as ssh after https.
func (repo *gitRepo) setRemote(ctx context.Context, remote string) error {
	repo.fetchMu.Lock()
	defer repo.fetchMu.Unlock()
	_, err := repo.runner.run(ctx, repo.directory, nil, "config", "remote.origin.url", remote)
	return err
}

func (repo *gitRepo) close() {
	repo.blobs.close()
	repo.reader.close()
}

var refNamePattern = regexp.MustCompile(`^[A-Za-z0-9._/+-]+$`)

func validRefName(ref string) bool {
	return refNamePattern.MatchString(ref) && !strings.HasPrefix(ref, "-") && !strings.HasPrefix(ref, "/") &&
		!strings.HasSuffix(ref, "/") && !strings.HasSuffix(ref, ".") && !strings.HasSuffix(ref, ".lock") &&
		!strings.Contains(ref, "..") && !strings.Contains(ref, "//") && !strings.Contains(ref, "/.")
}

// resolveRef maps a user ref to one full remote refname. Branches and tags must
// match exactly; kind breaks ties, and an empty ref means the remote HEAD.
func (repo *gitRepo) resolveRef(ctx context.Context, ref string, kind string) (string, error) {
	if ref == "" {
		if kind != "" {
			return "", errors.New("--kind requires a ref")
		}
		return "HEAD", nil
	}
	if !validRefName(ref) {
		return "", errors.New("ref name is not valid")
	}
	branch, tag := "refs/heads/"+ref, "refs/tags/"+ref
	output, err := repo.runner.run(ctx, repo.directory, nil, "ls-remote", "--quiet", "origin", branch, tag)
	if err != nil {
		return "", err
	}
	var found []string
	for _, line := range strings.Split(string(output), "\n") {
		_, name, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if ok && (name == branch && kind != "tag" || name == tag && kind != "branch") {
			found = append(found, name)
		}
	}
	switch len(found) {
	case 0:
		if kind != "" {
			return "", fmt.Errorf("no %s named %q on the remote", kind, ref)
		}
		return "", fmt.Errorf("no branch or tag named %q on the remote", ref)
	case 1:
		return found[0], nil
	default:
		return "", fmt.Errorf("%q names both a branch and a tag; pass --kind branch or --kind tag", ref)
	}
}

// fetchRef fetches only the named ref's tip commit and trees, then pins it.
func (repo *gitRepo) fetchRef(ctx context.Context, fullRef string) (string, error) {
	repo.fetchMu.Lock()
	defer repo.fetchMu.Unlock()
	incoming := "refs/workbench/incoming"
	if _, err := repo.runner.run(ctx, repo.directory, nil,
		"fetch", "--quiet", "--filter=blob:none", "--depth=1", "--no-tags", "--no-write-fetch-head",
		"--recurse-submodules=no", "--force", "origin", "+"+fullRef+":"+incoming); err != nil {
		return "", err
	}
	output, err := repo.runner.run(ctx, repo.directory, nil, "rev-parse", "--verify", "--quiet", incoming+"^{commit}")
	if err != nil {
		return "", errors.New("ref does not point at a commit")
	}
	commit := strings.TrimSpace(string(output))
	if _, err := repo.runner.run(ctx, repo.directory, nil, "update-ref", "refs/workbench/pins/"+commit, commit); err != nil {
		return "", err
	}
	return commit, nil
}

// fetchBlobs mirrors git's own promisor fetch for explicit object IDs.
func (repo *gitRepo) fetchBlobs(ctx context.Context, oids []string) error {
	repo.fetchMu.Lock()
	defer repo.fetchMu.Unlock()
	_, err := repo.runner.run(ctx, repo.directory, strings.NewReader(strings.Join(oids, "\n")+"\n"),
		"-c", "fetch.negotiationAlgorithm=noop",
		"fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no",
		"--filter=blob:none", "--stdin", "origin")
	if err != nil {
		var failure *gitError
		if errors.As(err, &failure) {
			failure.operation = "blob fetch"
		}
	}
	return err
}

// ensureBlobs fetches any absent blobs in one batched request.
func (repo *gitRepo) ensureBlobs(ctx context.Context, oids []string) error {
	var missing []string
	for _, oid := range oids {
		_, _, present, err := repo.reader.info(oid)
		if err != nil {
			return err
		}
		if !present {
			missing = append(missing, oid)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	if err := repo.blobs.ensure(ctx, missing); err != nil {
		return err
	}
	for _, oid := range missing {
		if _, _, present, err := repo.reader.info(oid); err != nil {
			return err
		} else if !present {
			return errors.New("repository object is unavailable from the remote")
		}
	}
	return nil
}

type commitInfo struct {
	tree     string
	modified time.Time
}

func (repo *gitRepo) readCommit(oid string) (commitInfo, error) {
	kind, data, present, err := repo.reader.contents(oid)
	if err != nil {
		return commitInfo{}, err
	}
	if !present || kind != "commit" {
		return commitInfo{}, errors.New("commit is not cached; warm it again")
	}
	var info commitInfo
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			break
		}
		if tree, ok := strings.CutPrefix(line, "tree "); ok {
			info.tree = tree
		} else if committer, ok := strings.CutPrefix(line, "committer "); ok {
			fields := strings.Fields(committer)
			if len(fields) >= 2 {
				if seconds, err := strconv.ParseInt(fields[len(fields)-2], 10, 64); err == nil {
					info.modified = time.Unix(seconds, 0)
				}
			}
		}
	}
	if info.tree == "" {
		return commitInfo{}, errors.New("commit object is malformed")
	}
	return info, nil
}

// objectReader owns one long-lived cat-file process. Lazy fetching is disabled
// in its environment, so absent blobs report "missing" instead of blocking.
type objectReader struct {
	runner    gitRunner
	directory string
	mu        sync.Mutex
	command   *exec.Cmd
	stdin     io.WriteCloser
	stdout    *bufio.Reader
	closed    bool
}

func (reader *objectReader) startLocked() error {
	if reader.closed {
		return errors.New("repository reader is closed")
	}
	if reader.command != nil {
		return nil
	}
	command := reader.runner.command(nil, reader.directory, "cat-file", "--batch-command")
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return err
	}
	reader.command, reader.stdin, reader.stdout = command, stdin, bufio.NewReaderSize(stdout, 1<<16)
	return nil
}

func (reader *objectReader) resetLocked() {
	if reader.command == nil {
		return
	}
	_ = reader.stdin.Close()
	_ = reader.command.Process.Kill()
	_ = reader.command.Wait()
	reader.command, reader.stdin, reader.stdout = nil, nil, nil
}

func (reader *objectReader) close() {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	reader.closed = true
	reader.resetLocked()
}

// request sends one command and parses its header; withBody also reads content.
func (reader *objectReader) request(command string, oid string, withBody bool) (kind string, size int64, data []byte, present bool, err error) {
	if !isObjectID(oid) {
		return "", 0, nil, false, errors.New("invalid object id")
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if err := reader.startLocked(); err != nil {
		return "", 0, nil, false, err
	}
	fail := func(cause error) (string, int64, []byte, bool, error) {
		reader.resetLocked()
		return "", 0, nil, false, fmt.Errorf("repository object read failed: %w", cause)
	}
	if _, err := io.WriteString(reader.stdin, command+" "+oid+"\n"); err != nil {
		return fail(err)
	}
	header, err := reader.stdout.ReadString('\n')
	if err != nil {
		return fail(err)
	}
	fields := strings.Fields(header)
	if len(fields) == 2 && fields[1] == "missing" {
		return "", 0, nil, false, nil
	}
	if len(fields) != 3 {
		return fail(errors.New("unexpected cat-file header"))
	}
	size, err = strconv.ParseInt(fields[2], 10, 64)
	if err != nil || size < 0 {
		return fail(errors.New("unexpected cat-file size"))
	}
	if !withBody {
		return fields[1], size, nil, true, nil
	}
	data = make([]byte, size+1)
	if _, err := io.ReadFull(reader.stdout, data); err != nil {
		return fail(err)
	}
	return fields[1], size, data[:size], true, nil
}

func (reader *objectReader) info(oid string) (kind string, size int64, present bool, err error) {
	kind, size, _, present, err = reader.request("info", oid, false)
	return
}

func (reader *objectReader) contents(oid string) (kind string, data []byte, present bool, err error) {
	kind, _, data, present, err = reader.request("contents", oid, true)
	return
}

func isObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}
