// No exports. Reads loopback-reachable TCP listeners from the calling process's network namespace.
package main

import (
	"encoding/hex"
	"errors"
	"io/fs"
	"net"
	"os"
	"strconv"
	"strings"
)

const tcpListenState = "0A"

// readListeningPorts reports TCP ports listening on loopback or wildcard addresses in this namespace.
func readListeningPorts() (map[int]struct{}, error) {
	ports := map[int]struct{}{}
	for _, table := range []string{"/proc/self/net/tcp", "/proc/self/net/tcp6"} {
		contents, err := os.ReadFile(table)
		if errors.Is(err, fs.ErrNotExist) && strings.HasSuffix(table, "6") {
			continue
		}
		if err != nil {
			return nil, err
		}
		for port := range parseListeningPorts(string(contents)) {
			ports[port] = struct{}{}
		}
	}
	return ports, nil
}

// parseListeningPorts reads one /proc/net/tcp or tcp6 table.
func parseListeningPorts(table string) map[int]struct{} {
	ports := map[int]struct{}{}
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || fields[3] != tcpListenState {
			continue
		}
		address, portHex, found := strings.Cut(fields[1], ":")
		if !found {
			continue
		}
		ip, ok := decodeProcAddress(address)
		port, err := strconv.ParseUint(portHex, 16, 16)
		if !ok || err != nil || port == 0 {
			continue
		}
		if ip.IsLoopback() || ip.IsUnspecified() {
			ports[int(port)] = struct{}{}
		}
	}
	return ports
}

// decodeProcAddress converts the kernel's host-order 32-bit words into an IP address.
func decodeProcAddress(text string) (net.IP, bool) {
	raw, err := hex.DecodeString(text)
	if err != nil || (len(raw) != net.IPv4len && len(raw) != net.IPv6len) {
		return nil, false
	}
	ip := make(net.IP, len(raw))
	for word := 0; word < len(raw); word += 4 {
		for offset := 0; offset < 4; offset++ {
			ip[word+offset] = raw[word+3-offset]
		}
	}
	return ip, true
}
