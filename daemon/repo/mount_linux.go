//go:build linux

// No exports. Own the Linux FUSE mount adapter: go-fuse nodes over one snapshot, mounted read-only.
package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

type fuseNode struct {
	fs.Inode
	snap *snapshot
	item node
}

type blobHandle struct {
	data []byte
}

type linuxMount struct {
	server    *fuse.Server
	directory string
}

var (
	_ fs.NodeLookuper   = (*fuseNode)(nil)
	_ fs.NodeGetattrer  = (*fuseNode)(nil)
	_ fs.NodeReaddirer  = (*fuseNode)(nil)
	_ fs.NodeOpener     = (*fuseNode)(nil)
	_ fs.NodeReadlinker = (*fuseNode)(nil)
	_ fs.FileReader     = (*blobHandle)(nil)
)

func mountSnapshot(snap *snapshot, directory string) (mountedFS, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	timeout := 24 * time.Hour
	root := &fuseNode{snap: snap, item: snap.root()}
	server, err := fs.Mount(directory, root, &fs.Options{
		AttrTimeout:  &timeout,
		EntryTimeout: &timeout,
		UID:          uint32(os.Getuid()),
		GID:          uint32(os.Getgid()),
		MountOptions: fuse.MountOptions{
			FsName:  "workbench-repo",
			Name:    "workbench",
			Options: []string{"ro", "default_permissions"},
		},
	})
	if err != nil {
		_ = os.Remove(directory)
		return nil, errors.New("FUSE could not mount the repository")
	}
	return &linuxMount{server: server, directory: directory}, nil
}

func (mount *linuxMount) unmount() error {
	if err := mount.server.Unmount(); err != nil {
		return errors.New("FUSE unmount failed")
	}
	mount.server.Wait()
	return nil
}

// unmountStale lazily detaches a mount left by a previous process.
func unmountStale(directory string) {
	for _, helper := range []string{"fusermount3", "fusermount"} {
		if executable, err := exec.LookPath(helper); err == nil {
			command := exec.Command(executable, "-u", "-z", "--", directory)
			if command.Run() == nil {
				return
			}
		}
	}
}

func fuseErrno(err error) syscall.Errno {
	switch {
	case errors.Is(err, errNotFound):
		return syscall.ENOENT
	case errors.Is(err, errNotDir):
		return syscall.ENOTDIR
	case errors.Is(err, errEscape):
		return syscall.EACCES
	case errors.Is(err, context.Canceled):
		return syscall.EINTR
	default:
		return syscall.EIO
	}
}

func fuseMode(item node) uint32 {
	switch item.kind {
	case nodeDirectory:
		return fuse.S_IFDIR | 0o555
	case nodeSymlink:
		return fuse.S_IFLNK | 0o777
	default:
		if item.executable {
			return fuse.S_IFREG | 0o555
		}
		return fuse.S_IFREG | 0o444
	}
}

func (n *fuseNode) fill(item node, attr *fuse.Attr) {
	attr.Mode = fuseMode(item)
	attr.Ino = item.inode
	attr.Size = uint64(item.size)
	attr.Blocks = (attr.Size + 511) / 512
	attr.Blksize = 4096
	attr.Nlink = 1
	if item.kind == nodeDirectory {
		attr.Nlink = 2
	}
	modified := n.snap.modified
	attr.SetTimes(&modified, &modified, &modified)
	attr.Owner = fuse.Owner{Uid: uint32(os.Getuid()), Gid: uint32(os.Getgid())}
}

func (n *fuseNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	item, err := n.snap.child(ctx, n.item, name)
	if err != nil {
		return nil, fuseErrno(err)
	}
	n.fill(item, &out.Attr)
	child := &fuseNode{snap: n.snap, item: item}
	return n.NewInode(ctx, child, fs.StableAttr{Mode: fuseMode(item) & syscall.S_IFMT, Ino: item.inode}), 0
}

func (n *fuseNode) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	n.fill(n.item, &out.Attr)
	return 0
}

func (n *fuseNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	entries, nodes, err := n.snap.children(ctx, n.item)
	if err != nil {
		return nil, fuseErrno(err)
	}
	list := make([]fuse.DirEntry, len(entries))
	for index, entry := range entries {
		list[index] = fuse.DirEntry{Name: entry.display, Mode: fuseMode(nodes[index]) & syscall.S_IFMT, Ino: nodes[index].inode}
	}
	return fs.NewListDirStream(list), 0
}

func (n *fuseNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR|syscall.O_TRUNC|syscall.O_APPEND|syscall.O_CREAT) != 0 {
		return nil, 0, syscall.EROFS
	}
	data, err := n.snap.read(ctx, n.item)
	if err != nil {
		return nil, 0, fuseErrno(err)
	}
	return &blobHandle{data: data}, fuse.FOPEN_KEEP_CACHE, 0
}

func (handle *blobHandle) Read(_ context.Context, destination []byte, offset int64) (fuse.ReadResult, syscall.Errno) {
	if offset >= int64(len(handle.data)) {
		return fuse.ReadResultData(nil), 0
	}
	end := offset + int64(len(destination))
	if end > int64(len(handle.data)) {
		end = int64(len(handle.data))
	}
	return fuse.ReadResultData(handle.data[offset:end]), 0
}

func (n *fuseNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	target, err := n.snap.readlink(ctx, n.item)
	if err != nil {
		return nil, fuseErrno(err)
	}
	return []byte(target), 0
}
