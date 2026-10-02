// No exports. Own one read-only commit snapshot: tree navigation, display names, synthetic metadata and contained symlinks.
package main

import (
	"bytes"
	"context"
	"errors"
	"hash/fnv"
	"path"
	"strings"
	"sync"
	"time"
)

var (
	errNotFound    = errors.New("not found")
	errNotDir      = errors.New("not a directory")
	errEscape      = errors.New("symlink leaves the repository snapshot")
	errUnavailable = errors.New("repository content is unavailable")
)

type nodeKind uint8

const (
	nodeDirectory nodeKind = iota
	nodeFile
	nodeSymlink
)

// node describes one snapshot entry. rawPath uses repository names and anchors
// inode numbers and symlink containment; display names are host-safe.
type node struct {
	kind       nodeKind
	executable bool
	oid        string
	tree       string // directory tree oid; empty for gitlinks
	rawPath    string
	size       int64
	inode      uint64
}

type treeEntry struct {
	raw     string
	display string
	mode    string
	oid     string
}

type treeListing struct {
	entries   []treeEntry
	byDisplay map[string]int
}

type snapshot struct {
	repo     *gitRepo
	commit   string
	modified time.Time
	windows  bool
	oidBytes int
	rootTree string
	mu       sync.Mutex
	trees    map[string]*treeListing
}

func newSnapshot(repo *gitRepo, commit string, windows bool) (*snapshot, error) {
	info, err := repo.readCommit(commit)
	if err != nil {
		return nil, err
	}
	return &snapshot{
		repo: repo, commit: commit, modified: info.modified, windows: windows,
		oidBytes: len(commit) / 2, rootTree: info.tree, trees: make(map[string]*treeListing),
	}, nil
}

func (snap *snapshot) root() node {
	return node{kind: nodeDirectory, tree: snap.rootTree, inode: 1}
}

func inodeFor(rawPath string) uint64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(rawPath))
	value := hash.Sum64()
	if value < 2 {
		value += 2
	}
	return value
}

func (snap *snapshot) listing(tree string) (*treeListing, error) {
	snap.mu.Lock()
	cached := snap.trees[tree]
	snap.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	kind, data, present, err := snap.repo.reader.contents(tree)
	if err != nil {
		return nil, err
	}
	if !present || kind != "tree" {
		return nil, errUnavailable
	}
	listing := &treeListing{byDisplay: make(map[string]int)}
	for len(data) > 0 {
		space := bytes.IndexByte(data, ' ')
		if space < 0 {
			return nil, errUnavailable
		}
		rest := data[space+1:]
		nul := bytes.IndexByte(rest, 0)
		if nul < 0 || len(rest) < nul+1+snap.oidBytes {
			return nil, errUnavailable
		}
		raw := string(rest[:nul])
		entry := treeEntry{
			raw:     raw,
			display: escapeName(raw, snap.windows),
			mode:    string(data[:space]),
			oid:     hexEncode(rest[nul+1 : nul+1+snap.oidBytes]),
		}
		listing.byDisplay[entry.display] = len(listing.entries)
		listing.entries = append(listing.entries, entry)
		data = rest[nul+1+snap.oidBytes:]
	}
	snap.mu.Lock()
	snap.trees[tree] = listing
	snap.mu.Unlock()
	return listing, nil
}

func hexEncode(raw []byte) string {
	const digits = "0123456789abcdef"
	output := make([]byte, len(raw)*2)
	for index, value := range raw {
		output[index*2] = digits[value>>4]
		output[index*2+1] = digits[value&0x0f]
	}
	return string(output)
}

func (snap *snapshot) nodeFor(parent node, entry treeEntry) node {
	raw := entry.raw
	if parent.rawPath != "" {
		raw = parent.rawPath + "/" + entry.raw
	}
	result := node{oid: entry.oid, rawPath: raw, inode: inodeFor(raw)}
	switch entry.mode {
	case "40000":
		result.kind, result.tree = nodeDirectory, entry.oid
	case "160000":
		result.kind = nodeDirectory // submodule: present as an empty directory
	case "120000":
		result.kind = nodeSymlink
	default:
		result.kind, result.executable = nodeFile, entry.mode == "100755"
	}
	return result
}

// withSizes resolves blob sizes, fetching every absent sibling blob in one batch:
// whoever stats one file in a directory is about to stat the rest.
func (snap *snapshot) withSizes(ctx context.Context, nodes []node) error {
	var oids []string
	for _, item := range nodes {
		if item.kind != nodeDirectory {
			oids = append(oids, item.oid)
		}
	}
	if len(oids) == 0 {
		return nil
	}
	if err := snap.repo.ensureBlobs(ctx, oids); err != nil {
		return err
	}
	for index := range nodes {
		if nodes[index].kind == nodeDirectory {
			continue
		}
		_, size, present, err := snap.repo.reader.info(nodes[index].oid)
		if err != nil {
			return err
		}
		if !present {
			return errUnavailable
		}
		nodes[index].size = size
	}
	return nil
}

// children lists a directory with sizes resolved.
func (snap *snapshot) children(ctx context.Context, directory node) ([]treeEntry, []node, error) {
	if directory.kind != nodeDirectory {
		return nil, nil, errNotDir
	}
	if directory.tree == "" {
		return nil, nil, nil
	}
	listing, err := snap.listing(directory.tree)
	if err != nil {
		return nil, nil, err
	}
	nodes := make([]node, len(listing.entries))
	for index, entry := range listing.entries {
		nodes[index] = snap.nodeFor(directory, entry)
	}
	if err := snap.withSizes(ctx, nodes); err != nil {
		return nil, nil, err
	}
	return listing.entries, nodes, nil
}

// child resolves one display name with its size; absent siblings are fetched together.
func (snap *snapshot) child(ctx context.Context, directory node, display string) (node, error) {
	if directory.kind != nodeDirectory {
		return node{}, errNotDir
	}
	if directory.tree == "" {
		return node{}, errNotFound
	}
	listing, err := snap.listing(directory.tree)
	if err != nil {
		return node{}, err
	}
	index, ok := listing.byDisplay[display]
	if !ok {
		return node{}, errNotFound
	}
	result := snap.nodeFor(directory, listing.entries[index])
	if result.kind == nodeDirectory {
		return result, nil
	}
	if _, _, present, err := snap.repo.reader.info(result.oid); err != nil {
		return node{}, err
	} else if !present {
		siblings := make([]node, len(listing.entries))
		for position, entry := range listing.entries {
			siblings[position] = snap.nodeFor(directory, entry)
		}
		if err := snap.withSizes(ctx, siblings); err != nil {
			return node{}, err
		}
		return siblings[index], nil
	}
	single := []node{result}
	if err := snap.withSizes(ctx, single); err != nil {
		return node{}, err
	}
	return single[0], nil
}

// resolve walks a slash-separated display path from the snapshot root.
func (snap *snapshot) resolve(ctx context.Context, displayPath string) (node, error) {
	current := snap.root()
	for _, segment := range strings.Split(displayPath, "/") {
		if segment == "" {
			continue
		}
		next, err := snap.child(ctx, current, segment)
		if err != nil {
			return node{}, err
		}
		current = next
	}
	return current, nil
}

func (snap *snapshot) read(ctx context.Context, item node) ([]byte, error) {
	if item.kind == nodeDirectory {
		return nil, errNotDir
	}
	if err := snap.repo.ensureBlobs(ctx, []string{item.oid}); err != nil {
		return nil, err
	}
	kind, data, present, err := snap.repo.reader.contents(item.oid)
	if err != nil {
		return nil, err
	}
	if !present || kind != "blob" {
		return nil, errUnavailable
	}
	return data, nil
}

// readlink returns a relative target with host-safe names, refusing any target
// that is absolute or climbs above the snapshot root.
func (snap *snapshot) readlink(ctx context.Context, item node) (string, error) {
	if item.kind != nodeSymlink {
		return "", errNotFound
	}
	data, err := snap.read(ctx, item)
	if err != nil {
		return "", err
	}
	target := string(data)
	if target == "" || strings.HasPrefix(target, "/") || strings.ContainsAny(target, "\\\x00") || (len(target) > 1 && target[1] == ':') {
		return "", errEscape
	}
	// Clean an unrooted path: rooted cleaning silently drops leading "..".
	resolved := path.Join(path.Dir(item.rawPath), target)
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return "", errEscape
	}
	segments := strings.Split(target, "/")
	for index, segment := range segments {
		if segment != "" && segment != "." && segment != ".." {
			segments[index] = escapeName(segment, snap.windows)
		}
	}
	return strings.Join(segments, "/"), nil
}
