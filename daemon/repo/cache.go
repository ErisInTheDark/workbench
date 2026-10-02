// No exports. Own the on-disk repository cache and live mounts: coalesced opens, mounts, eviction and stale sweeps.
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

type mountedFS interface {
	unmount() error
}

type warmResult struct {
	Key    string `json:"key"`
	Commit string `json:"commit"`
	Path   string `json:"path"`
}

type repoSlot struct {
	ready chan struct{}
	repo  *gitRepo
	err   error
}

type mountSlot struct {
	ready chan struct{}
	key   repositoryKey
	path  string
	fs    mountedFS
	err   error
}

// repoService lays out <root>/git/<key>.git bare repositories and
// <root>/mounts/<key>/<commit> mount points. Lease policy belongs to the daemon.
type repoService struct {
	root    string
	runner  gitRunner
	windows bool
	mount   func(*snapshot, string) (mountedFS, error)
	mu      sync.Mutex
	repos   map[repositoryKey]*repoSlot
	mounts  map[string]*mountSlot
	closed  bool
}

var errServiceClosed = errors.New("repository service is closing")

func newRepoService(root string, runner gitRunner) *repoService {
	return &repoService{
		root: root, runner: runner, windows: hostUsesWindowsNames, mount: mountSnapshot,
		repos: make(map[repositoryKey]*repoSlot), mounts: make(map[string]*mountSlot),
	}
}

func (service *repoService) gitPath(key repositoryKey) string {
	return filepath.Join(service.root, "git", filepath.FromSlash(string(key))+".git")
}

func (service *repoService) mountPath(key repositoryKey, commit string) string {
	return filepath.Join(service.root, "mounts", filepath.FromSlash(string(key)), commit)
}

// parseKey accepts only keys this service could have produced.
func parseKey(value string) (repositoryKey, error) {
	segments := strings.Split(value, "/")
	if len(segments) < 2 {
		return "", errors.New("invalid repository key")
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || escapeName(unescapeName(segment), true) != segment {
			return "", errors.New("invalid repository key")
		}
	}
	return repositoryKey(value), nil
}

func waitReady(ctx context.Context, ready chan struct{}) error {
	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (service *repoService) openRepo(ctx context.Context, key repositoryKey, remote string) (*gitRepo, error) {
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return nil, errServiceClosed
	}
	slot, found := service.repos[key]
	if !found {
		slot = &repoSlot{ready: make(chan struct{})}
		service.repos[key] = slot
	}
	service.mu.Unlock()
	if found {
		if err := waitReady(ctx, slot.ready); err != nil {
			return nil, err
		}
		if slot.err != nil {
			return nil, slot.err
		}
		return slot.repo, nil
	}
	slot.repo, slot.err = openRepo(context.WithoutCancel(ctx), service.runner, service.gitPath(key), remote)
	if slot.err != nil {
		service.mu.Lock()
		delete(service.repos, key)
		service.mu.Unlock()
	}
	close(slot.ready)
	return slot.repo, slot.err
}

// warm resolves the ref, fetches its tip, and mounts that exact commit.
func (service *repoService) warm(ctx context.Context, remote string, ref string, kind string) (warmResult, error) {
	if kind != "" && kind != "branch" && kind != "tag" {
		return warmResult{}, errors.New("kind must be branch or tag")
	}
	key, err := parseRemote(remote, service.runner.allowFile)
	if err != nil {
		return warmResult{}, err
	}
	repo, err := service.openRepo(ctx, key, remote)
	if err != nil {
		return warmResult{}, err
	}
	if err := repo.setRemote(ctx, remote); err != nil {
		return warmResult{}, err
	}
	fullRef, err := repo.resolveRef(ctx, ref, kind)
	if err != nil {
		return warmResult{}, err
	}
	commit, err := repo.fetchRef(ctx, fullRef)
	if err != nil {
		return warmResult{}, err
	}
	path, err := service.ensureMount(ctx, key, repo, commit)
	if err != nil {
		return warmResult{}, err
	}
	return warmResult{Key: string(key), Commit: commit, Path: path}, nil
}

// remount restores a leased commit from cache without touching the network.
func (service *repoService) remount(ctx context.Context, key repositoryKey, commit string) (string, error) {
	if !isObjectID(commit) {
		return "", errors.New("invalid commit")
	}
	repo, err := service.openRepo(ctx, key, "")
	if err != nil {
		return "", err
	}
	return service.ensureMount(ctx, key, repo, commit)
}

func (service *repoService) ensureMount(ctx context.Context, key repositoryKey, repo *gitRepo, commit string) (string, error) {
	identity := string(key) + "@" + commit
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return "", errServiceClosed
	}
	slot, found := service.mounts[identity]
	if !found {
		slot = &mountSlot{ready: make(chan struct{}), key: key, path: service.mountPath(key, commit)}
		service.mounts[identity] = slot
	}
	service.mu.Unlock()
	if found {
		if err := waitReady(ctx, slot.ready); err != nil {
			return "", err
		}
		if slot.err != nil {
			return "", slot.err
		}
		return slot.path, nil
	}
	snap, err := newSnapshot(repo, commit, service.windows)
	if err == nil {
		slot.fs, err = service.mount(snap, slot.path)
	}
	slot.err = err
	if err != nil {
		service.mu.Lock()
		delete(service.mounts, identity)
		service.mu.Unlock()
	}
	close(slot.ready)
	return slot.path, err
}

func (service *repoService) unmount(key repositoryKey, commit string) error {
	identity := string(key) + "@" + commit
	service.mu.Lock()
	slot := service.mounts[identity]
	delete(service.mounts, identity)
	service.mu.Unlock()
	if slot == nil {
		return nil
	}
	return service.release(slot)
}

func (service *repoService) release(slot *mountSlot) error {
	<-slot.ready
	if slot.fs == nil {
		return nil
	}
	err := slot.fs.unmount()
	if err == nil {
		_ = os.Remove(slot.path)
		service.pruneEmptyParents(slot.path, filepath.Join(service.root, "mounts"))
	}
	return err
}

// evict unmounts every commit of one repository and deletes its verified cache.
func (service *repoService) evict(key repositoryKey) error {
	service.mu.Lock()
	var slots []*mountSlot
	for identity, slot := range service.mounts {
		if slot.key == key {
			slots = append(slots, slot)
			delete(service.mounts, identity)
		}
	}
	repoSlot := service.repos[key]
	delete(service.repos, key)
	service.mu.Unlock()
	var failures []error
	for _, slot := range slots {
		if err := service.release(slot); err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	if repoSlot != nil {
		<-repoSlot.ready
		if repoSlot.repo != nil {
			repoSlot.repo.close()
		}
	}
	return service.removeRepo(service.gitPath(key))
}

func (service *repoService) removeRepo(directory string) error {
	if _, err := os.Stat(directory); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if !isOwnedRepo(service.runner, directory) {
		return errors.New("refusing to delete a cache entry that Workbench does not own")
	}
	if err := os.RemoveAll(directory); err != nil {
		return err
	}
	service.pruneEmptyParents(directory, filepath.Join(service.root, "git"))
	return nil
}

func (service *repoService) pruneEmptyParents(start string, stop string) {
	for current := filepath.Dir(start); current != stop && strings.HasPrefix(current, stop+string(filepath.Separator)); current = filepath.Dir(current) {
		if os.Remove(current) != nil {
			return
		}
	}
}

var temporaryRepo = regexp.MustCompile(`\.git\.tmp-[0-9a-f]{12}$`)

// sweep deletes cached repositories without live leases and clears dead mount
// points left by an earlier process. Mount trees are only ever pruned with
// os.Remove, so nothing under a live mount can be deleted.
func (service *repoService) sweep(keep []string) error {
	kept := make(map[repositoryKey]bool)
	for _, value := range keep {
		key, err := parseKey(value)
		if err != nil {
			return err
		}
		kept[key] = true
	}
	service.mu.Lock()
	active := make(map[string]bool)
	for key := range service.repos {
		kept[key] = true
	}
	for _, slot := range service.mounts {
		active[slot.path] = true
	}
	service.mu.Unlock()
	gitRoot := filepath.Join(service.root, "git")
	var failures []error
	var visit func(string)
	visit = func(directory string) {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			child := filepath.Join(directory, entry.Name())
			relative, _ := filepath.Rel(gitRoot, child)
			switch {
			case temporaryRepo.MatchString(entry.Name()):
				// A live key may be creating this right now.
				key, err := parseKey(strings.TrimSuffix(filepath.ToSlash(relative[:len(relative)-len(".tmp-")-12]), ".git"))
				if err == nil && kept[key] {
					continue
				}
				if err := os.RemoveAll(child); err != nil {
					failures = append(failures, err)
				}
			case strings.HasSuffix(entry.Name(), ".git"):
				key, err := parseKey(strings.TrimSuffix(filepath.ToSlash(relative), ".git"))
				if err == nil && !kept[key] {
					if err := service.removeRepo(child); err != nil {
						failures = append(failures, err)
					}
				}
			default:
				visit(child)
				_ = os.Remove(child)
			}
		}
	}
	visit(gitRoot)
	service.sweepMounts(filepath.Join(service.root, "mounts"), active, true)
	return errors.Join(failures...)
}

func (service *repoService) sweepMounts(directory string, active map[string]bool, isRoot bool) {
	if active[directory] {
		return
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) && !isRoot {
			unmountStale(directory)
			_ = os.Remove(directory)
		}
		return
	}
	for _, entry := range entries {
		service.sweepMounts(filepath.Join(directory, entry.Name()), active, false)
	}
	if !isRoot {
		if isObjectID(filepath.Base(directory)) {
			unmountStale(directory)
		}
		_ = os.Remove(directory)
	}
}

func (service *repoService) close() error {
	service.mu.Lock()
	service.closed = true
	mounts := service.mounts
	repos := service.repos
	service.mounts = make(map[string]*mountSlot)
	service.repos = make(map[repositoryKey]*repoSlot)
	service.mu.Unlock()
	var failures []error
	for _, slot := range mounts {
		if err := service.release(slot); err != nil {
			failures = append(failures, err)
		}
	}
	for _, slot := range repos {
		<-slot.ready
		if slot.repo != nil {
			slot.repo.close()
		}
	}
	return errors.Join(failures...)
}
