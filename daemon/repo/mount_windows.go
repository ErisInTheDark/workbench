//go:build windows

// No exports. Own the WinFsp mount adapter: cgofuse callbacks over one snapshot, read-only.
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/winfsp/cgofuse/fuse"
)

type winfspFS struct {
	fuse.FileSystemBase
	snap    *snapshot
	ctx     context.Context
	ready   chan struct{}
	once    sync.Once
	mu      sync.Mutex
	handles map[uint64][]byte
	next    uint64
}

type winfspMount struct {
	host   *fuse.FileSystemHost
	cancel context.CancelFunc
	done   chan struct{}
}

// mountSnapshot mounts at directory, which must not exist: WinFsp creates the
// directory reparse point itself and removes it on unmount.
func mountSnapshot(snap *snapshot, directory string) (mountedFS, error) {
	if err := os.MkdirAll(filepath.Dir(directory), 0o700); err != nil {
		return nil, err
	}
	if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("mount directory is occupied")
	}
	ctx, cancel := context.WithCancel(context.Background())
	filesystem := &winfspFS{snap: snap, ctx: ctx, ready: make(chan struct{}), handles: make(map[uint64][]byte)}
	host := fuse.NewFileSystemHost(filesystem)
	host.SetCapReaddirPlus(true)
	host.SetCapCaseInsensitive(false)
	mount := &winfspMount{host: host, cancel: cancel, done: make(chan struct{})}
	mounted := make(chan bool, 1)
	go func() {
		defer close(mount.done)
		mounted <- host.Mount(directory, []string{"-o", "uid=-1,gid=-1", "-o", "FileInfoTimeout=-1", "-o", "volname=workbench-repo"})
	}()
	failed := func(ok bool) error {
		cancel()
		if ok {
			return errors.New("WinFsp mount ended before it became ready")
		}
		return errors.New("WinFsp could not mount the repository")
	}
	select {
	case <-filesystem.ready:
	case ok := <-mounted:
		return nil, failed(ok)
	}
	// WinFsp runs FUSE init before it attaches the mount point, so Init alone does
	// not mean the path resolves. Wait for the path for as long as the mount lives;
	// Mount returning first is the failure signal, so no deadline is needed.
	for {
		if _, err := os.Stat(directory); err == nil {
			return mount, nil
		}
		select {
		case ok := <-mounted:
			return nil, failed(ok)
		case <-time.After(mountPollInterval):
		}
	}
}

// mountPollInterval only paces the readiness check above; it is not a deadline.
const mountPollInterval = 5 * time.Millisecond

func (mount *winfspMount) unmount() error {
	mount.cancel()
	if !mount.host.Unmount() {
		return errors.New("WinFsp unmount failed")
	}
	<-mount.done
	return nil
}

// unmountStale is a no-op: WinFsp mounts end with their process, leaving at most
// a dead directory that the sweep removes.
func unmountStale(string) {}

func (filesystem *winfspFS) Init() {
	filesystem.once.Do(func() { close(filesystem.ready) })
}

func winfspErrno(err error) int {
	switch {
	case errors.Is(err, errNotFound):
		return -fuse.ENOENT
	case errors.Is(err, errNotDir):
		return -fuse.ENOTDIR
	case errors.Is(err, errEscape):
		return -fuse.EACCES
	default:
		return -fuse.EIO
	}
}

func (filesystem *winfspFS) fillStat(item node, stat *fuse.Stat_t) {
	*stat = fuse.Stat_t{}
	switch item.kind {
	case nodeDirectory:
		stat.Mode = fuse.S_IFDIR | 0o555
		stat.Nlink = 2
	case nodeSymlink:
		stat.Mode = fuse.S_IFLNK | 0o777
		stat.Nlink = 1
	default:
		stat.Mode = fuse.S_IFREG | 0o444
		if item.executable {
			stat.Mode |= 0o111
		}
		stat.Nlink = 1
	}
	stat.Ino = item.inode
	stat.Size = item.size
	stat.Blksize = 4096
	stat.Blocks = (item.size + 511) / 512
	modified := fuse.NewTimespec(filesystem.snap.modified)
	stat.Atim, stat.Mtim, stat.Ctim, stat.Birthtim = modified, modified, modified, modified
}

func (filesystem *winfspFS) Statfs(_ string, stat *fuse.Statfs_t) int {
	*stat = fuse.Statfs_t{Bsize: 4096, Frsize: 4096, Namemax: 255}
	return 0
}

func (filesystem *winfspFS) Getattr(path string, stat *fuse.Stat_t, _ uint64) int {
	item, err := filesystem.snap.resolve(filesystem.ctx, path)
	if err != nil {
		return winfspErrno(err)
	}
	filesystem.fillStat(item, stat)
	return 0
}

func (filesystem *winfspFS) Opendir(path string) (int, uint64) {
	item, err := filesystem.snap.resolve(filesystem.ctx, path)
	if err != nil {
		return winfspErrno(err), ^uint64(0)
	}
	if item.kind != nodeDirectory {
		return -fuse.ENOTDIR, ^uint64(0)
	}
	return 0, 0
}

func (filesystem *winfspFS) Readdir(path string, fill func(string, *fuse.Stat_t, int64) bool, _ int64, _ uint64) int {
	directory, err := filesystem.snap.resolve(filesystem.ctx, path)
	if err != nil {
		return winfspErrno(err)
	}
	entries, nodes, err := filesystem.snap.children(filesystem.ctx, directory)
	if err != nil {
		return winfspErrno(err)
	}
	var stat fuse.Stat_t
	filesystem.fillStat(directory, &stat)
	if !fill(".", &stat, 0) || !fill("..", nil, 0) {
		return 0
	}
	for index, entry := range entries {
		filesystem.fillStat(nodes[index], &stat)
		if !fill(entry.display, &stat, 0) {
			break
		}
	}
	return 0
}

func (filesystem *winfspFS) Open(path string, flags int) (int, uint64) {
	if flags&fuse.O_ACCMODE != fuse.O_RDONLY || flags&(fuse.O_TRUNC|fuse.O_APPEND|fuse.O_CREAT) != 0 {
		return -fuse.EROFS, ^uint64(0)
	}
	item, err := filesystem.snap.resolve(filesystem.ctx, path)
	if err != nil {
		return winfspErrno(err), ^uint64(0)
	}
	if item.kind == nodeDirectory {
		return -fuse.EISDIR, ^uint64(0)
	}
	data, err := filesystem.snap.read(filesystem.ctx, item)
	if err != nil {
		return winfspErrno(err), ^uint64(0)
	}
	filesystem.mu.Lock()
	defer filesystem.mu.Unlock()
	filesystem.next++
	filesystem.handles[filesystem.next] = data
	return 0, filesystem.next
}

func (filesystem *winfspFS) Read(_ string, buffer []byte, offset int64, handle uint64) int {
	filesystem.mu.Lock()
	data, ok := filesystem.handles[handle]
	filesystem.mu.Unlock()
	if !ok {
		return -fuse.EBADF
	}
	if offset >= int64(len(data)) {
		return 0
	}
	return copy(buffer, data[offset:])
}

func (filesystem *winfspFS) Release(_ string, handle uint64) int {
	filesystem.mu.Lock()
	delete(filesystem.handles, handle)
	filesystem.mu.Unlock()
	return 0
}

func (filesystem *winfspFS) Readlink(path string) (int, string) {
	item, err := filesystem.snap.resolve(filesystem.ctx, path)
	if err != nil {
		return winfspErrno(err), ""
	}
	target, err := filesystem.snap.readlink(filesystem.ctx, item)
	if err != nil {
		return winfspErrno(err), ""
	}
	return 0, strings.ReplaceAll(target, "/", `\`)
}

func (filesystem *winfspFS) Access(path string, mask uint32) int {
	if mask&2 != 0 {
		return -fuse.EROFS
	}
	if _, err := filesystem.snap.resolve(filesystem.ctx, path); err != nil {
		return winfspErrno(err)
	}
	return 0
}

func (*winfspFS) Mknod(string, uint32, uint64) int        { return -fuse.EROFS }
func (*winfspFS) Mkdir(string, uint32) int                { return -fuse.EROFS }
func (*winfspFS) Unlink(string) int                       { return -fuse.EROFS }
func (*winfspFS) Rmdir(string) int                        { return -fuse.EROFS }
func (*winfspFS) Link(string, string) int                 { return -fuse.EROFS }
func (*winfspFS) Symlink(string, string) int              { return -fuse.EROFS }
func (*winfspFS) Rename(string, string) int               { return -fuse.EROFS }
func (*winfspFS) Chmod(string, uint32) int                { return -fuse.EROFS }
func (*winfspFS) Chown(string, uint32, uint32) int        { return -fuse.EROFS }
func (*winfspFS) Utimens(string, []fuse.Timespec) int     { return -fuse.EROFS }
func (*winfspFS) Truncate(string, int64, uint64) int      { return -fuse.EROFS }
func (*winfspFS) Write(string, []byte, int64, uint64) int { return -fuse.EROFS }
func (*winfspFS) Setxattr(string, string, []byte, int) int { return -fuse.EROFS }
func (*winfspFS) Removexattr(string, string) int          { return -fuse.EROFS }
func (*winfspFS) Create(string, int, uint32) (int, uint64) { return -fuse.EROFS, ^uint64(0) }
