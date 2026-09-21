// No exports. Own bounded private-file replacement without following redirected credential paths.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func ensurePrivateDirectory(directory string) error {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	existing := absolute
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return errors.New("private credential path has no existing ancestor")
		}
		existing = parent
	}
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return fmt.Errorf("resolve private credential ancestor: %w", err)
	}
	equal := resolved == existing
	if runtime.GOOS == "windows" {
		equal = strings.EqualFold(resolved, existing)
	}
	if !equal {
		return errors.New("refusing redirected private credential directory")
	}
	if err := os.MkdirAll(absolute, 0700); err != nil {
		return err
	}
	if err := protectPrivatePath(absolute, true); err != nil {
		return fmt.Errorf("protect private credential directory: %w", err)
	}
	return nil
}

func writePrivateFile(name string, data []byte) (result error) {
	if err := ensurePrivateDirectory(filepath.Dir(name)); err != nil {
		return err
	}
	if info, err := os.Lstat(name); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("refusing non-regular private credential destination")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(name), ".network-write-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer func() {
		if err := os.Remove(temporary); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, err)
		}
	}()
	if err := protectPrivatePath(temporary, false); err != nil {
		return errors.Join(fmt.Errorf("protect temporary credential file: %w", err), file.Close())
	}
	_, writeError := file.Write(data)
	syncError := file.Sync()
	closeError := file.Close()
	if err := errors.Join(writeError, syncError, closeError); err != nil {
		return err
	}
	return os.Rename(temporary, name)
}

func removePrivateFile(name string) error {
	if err := ensurePrivateDirectory(filepath.Dir(name)); err != nil { return err }
	info, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) { return nil }
	if err != nil { return err }
	if !info.Mode().IsRegular() { return errors.New("refusing non-regular private credential removal") }
	return os.Remove(name)
}
