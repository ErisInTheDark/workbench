// No exports. Own reversible ~HH path escaping and repository keys derived from credential-free remote URLs.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"path"
	"strings"
)

// escapeName returns a single path component that the host filesystem can display.
// Windows mode escapes names Win32 cannot open. Escapes always start with '~', which
// is never a hex digit, so a literal '~' only needs escaping when two hex digits
// follow it; every output decodes back to exactly one input. Git tree names never
// contain '/' or NUL, so non-Windows content names pass through unchanged.
func escapeName(name string, windows bool) string {
	if !windows && !strings.ContainsAny(name, "/\x00") {
		return name
	}
	var builder strings.Builder
	upper := strings.ToUpper(name)
	stem := upper
	if dot := strings.IndexByte(stem, '.'); dot >= 0 {
		stem = stem[:dot]
	}
	reserved := windows && isReservedWindowsStem(strings.TrimRight(stem, " "))
	for index := 0; index < len(name); index++ {
		character := name[index]
		escape := false
		switch {
		case character == '/' || character == 0:
			escape = true
		case character == '~':
			escape = isHex(name, index+1) && isHex(name, index+2)
		case windows && (character < 0x20 || strings.IndexByte(`<>:"\|?*`, character) >= 0):
			escape = true
		case windows && index == 0 && reserved:
			escape = true
		case windows && index == len(name)-1 && (character == '.' || character == ' '):
			escape = name != "." && name != ".."
		}
		if escape {
			builder.WriteByte('~')
			builder.WriteByte(hexDigits[character>>4])
			builder.WriteByte(hexDigits[character&0x0f])
		} else {
			builder.WriteByte(character)
		}
	}
	return builder.String()
}

// unescapeName reverses escapeName.
func unescapeName(name string) string {
	var builder strings.Builder
	for index := 0; index < len(name); index++ {
		if name[index] == '~' && isHex(name, index+1) && isHex(name, index+2) {
			builder.WriteByte(hexValue(name[index+1])<<4 | hexValue(name[index+2]))
			index += 2
			continue
		}
		builder.WriteByte(name[index])
	}
	return builder.String()
}

const hexDigits = "0123456789ABCDEF"

func isHex(value string, index int) bool {
	if index >= len(value) {
		return false
	}
	character := value[index]
	return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')
}

func hexValue(character byte) byte {
	switch {
	case character >= '0' && character <= '9':
		return character - '0'
	case character >= 'a' && character <= 'f':
		return character - 'a' + 10
	default:
		return character - 'A' + 10
	}
}

func isReservedWindowsStem(stem string) bool {
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) {
		last := stem[3]
		return last >= '0' && last <= '9'
	}
	return false
}

// repositoryKey is the escaped, slash-separated cache identity of one remote,
// such as "github.com/team/project". It never contains credentials.
type repositoryKey string

var errUnsupportedRemote = errors.New("repository URL must be an https, http, ssh or scp-style git remote without credentials, query or fragment")

// parseRemote validates a remote and derives its repository key. Credentials are
// rejected rather than stripped so they can never be cached in git config.
func parseRemote(raw string, allowFile bool) (repositoryKey, error) {
	raw = strings.TrimSpace(raw)
	// A leading '-' could be read as a git or ssh option.
	if raw == "" || strings.HasPrefix(raw, "-") || strings.ContainsAny(raw, " \t\r\n\x00") {
		return "", errUnsupportedRemote
	}
	var host, remotePath string
	if scheme, _, found := strings.Cut(raw, "://"); found {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" {
			return "", errUnsupportedRemote
		}
		switch strings.ToLower(scheme) {
		case "https", "http":
			if parsed.User != nil {
				return "", errUnsupportedRemote
			}
		case "ssh", "git+ssh":
			if _, hasPassword := parsed.User.Password(); parsed.User != nil && hasPassword {
				return "", errUnsupportedRemote
			}
		case "file":
			if !allowFile {
				return "", errUnsupportedRemote
			}
			// Test-only remotes: a short digest keeps cache paths under Windows' path limit.
			digest := sha256.Sum256([]byte(parsed.Path))
			return keyFromSegments("local", hex.EncodeToString(digest[:8]))
		default:
			return "", errUnsupportedRemote
		}
		host, remotePath = strings.ToLower(parsed.Host), parsed.Path
	} else {
		// scp-like syntax: [user@]host:path. A colon before any slash is required.
		colon := strings.IndexByte(raw, ':')
		slash := strings.IndexByte(raw, '/')
		if colon <= 0 || (slash >= 0 && slash < colon) {
			return "", errUnsupportedRemote
		}
		authority := raw[:colon]
		// git reads "C:\path" and "C:/path" as local drive paths, never as hosts.
		if len(authority) == 1 {
			return "", errUnsupportedRemote
		}
		if at := strings.LastIndexByte(authority, '@'); at >= 0 {
			if strings.Contains(authority[:at], ":") {
				return "", errUnsupportedRemote
			}
			authority = authority[at+1:]
		}
		host, remotePath = strings.ToLower(authority), raw[colon+1:]
	}
	if host == "" || strings.HasPrefix(host, "-") {
		return "", errUnsupportedRemote
	}
	return keyFromSegments(host, remotePath)
}

func keyFromSegments(host string, remotePath string) (repositoryKey, error) {
	cleaned := path.Clean("/" + strings.ReplaceAll(remotePath, "\\", "/"))
	cleaned = strings.TrimSuffix(strings.TrimPrefix(cleaned, "/"), ".git")
	if cleaned == "" || cleaned == "." {
		return "", errUnsupportedRemote
	}
	segments := []string{escapeName(host, true)}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", errUnsupportedRemote
		}
		segments = append(segments, escapeName(segment, true))
	}
	return repositoryKey(strings.Join(segments, "/")), nil
}
