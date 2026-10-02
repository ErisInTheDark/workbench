package main

import (
	"strings"
	"testing"
)

var awkwardNames = []string{
	"normal.txt", "a/b", "~41", "~4", "~", "~zz", "A", "con", "CON.txt", "con ", "Com1", "lpt9.log", "COM10",
	"conin$", "trailing.", "space ", "a:b*?", "pipe|<>\"", "\x01ctl", "back\\slash", ".", "..", "...", "nul.tar.gz",
}

func TestPosixNamesPassThrough(t *testing.T) {
	for _, name := range awkwardNames {
		if !strings.Contains(name, "/") && escapeName(name, false) != name {
			t.Fatalf("posix name %q was rewritten to %q", name, escapeName(name, false))
		}
	}
}

func TestWindowsEscapingRoundTripsAndStaysHostSafe(t *testing.T) {
	{
		seen := make(map[string]string)
		for _, name := range awkwardNames {
			escaped := escapeName(name, true)
			if got := unescapeName(escaped); got != name {
				t.Fatalf("%q escaped to %q decoded to %q", name, escaped, got)
			}
			if previous, ok := seen[escaped]; ok {
				t.Fatalf("%q and %q both escape to %q", previous, name, escaped)
			}
			seen[escaped] = name
			if strings.ContainsAny(escaped, `/<>:"\|?*`) || strings.IndexFunc(escaped, func(r rune) bool { return r < 0x20 }) >= 0 {
				t.Fatalf("%q escaped to %q, which Win32 cannot open", name, escaped)
			}
			stem := strings.ToUpper(escaped)
			if dot := strings.IndexByte(stem, '.'); dot >= 0 {
				stem = stem[:dot]
			}
			if isReservedWindowsStem(strings.TrimRight(stem, " ")) {
				t.Fatalf("%q escaped to reserved %q", name, escaped)
			}
			if escaped != "." && escaped != ".." && (strings.HasSuffix(escaped, ".") || strings.HasSuffix(escaped, " ")) {
				t.Fatalf("%q escaped to %q with a trailing dot or space", name, escaped)
			}
		}
	}
}

func TestParseRemoteDerivesCredentialFreeKeys(t *testing.T) {
	accepted := map[string]repositoryKey{
		"https://GitHub.com/Team/Project.git": "github.com/Team/Project",
		"https://github.com/team/project/":    "github.com/team/project",
		"git@github.com:team/project.git":     "github.com/team/project",
		"ssh://git@host.example:2222/a/b.git": "host.example~3A2222/a/b",
		"http://host/group/sub/repo":          "host/group/sub/repo",
	}
	for raw, want := range accepted {
		got, err := parseRemote(raw, false)
		if err != nil || got != want {
			t.Fatalf("parseRemote(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	rejected := []string{
		"", "https://user:token@github.com/a/b", "https://token@github.com/a/b", "ssh://git:secret@host/a/b",
		"https://github.com/a/b?x=1", "https://github.com/a/b#main", "-oProxyCommand=evil:a/b", "ftp://host/a/b",
		"https://github.com/", "file:///tmp/repo", "relative/path", "C:\\repo", "host:", "a b:c/d",
	}
	for _, raw := range rejected {
		if key, err := parseRemote(raw, false); err == nil {
			t.Fatalf("parseRemote(%q) accepted as %q", raw, key)
		}
	}
	if _, err := parseRemote("file:///tmp/repo.git", true); err != nil {
		t.Fatalf("file remotes should be accepted when allowed: %v", err)
	}
}
