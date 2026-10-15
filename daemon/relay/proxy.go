// No exports. Opens raw TCP tunnels through Codex's managed HTTP proxy and pipes connections.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Bounds one proxy handshake so a wedged proxy fails a single connection instead of hanging it.
const proxyHandshakeTimeout = 10 * time.Second

var proxyEnvKeys = []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY", "FTP_PROXY"}

// proxyAddress returns Codex's in-namespace HTTP proxy endpoint.
func proxyAddress(env map[string]string) (string, error) {
	for _, key := range []string{"HTTP_PROXY", "http_proxy"} {
		if value := strings.TrimSpace(env[key]); value != "" {
			host, port, ok := loopbackProxyEndpoint(value)
			if !ok {
				return "", fmt.Errorf("%s is not a loopback proxy", key)
			}
			return net.JoinHostPort(host, strconv.Itoa(port)), nil
		}
	}
	return "", errors.New("HTTP_PROXY is not set")
}

// proxyPorts lists namespace-local proxy bridge ports, which belong to Codex rather than the command.
func proxyPorts(env map[string]string) map[int]struct{} {
	ports := map[int]struct{}{}
	for _, key := range proxyEnvKeys {
		for _, name := range []string{key, strings.ToLower(key)} {
			if _, port, ok := loopbackProxyEndpoint(env[name]); ok {
				ports[port] = struct{}{}
			}
		}
	}
	return ports
}

func loopbackProxyEndpoint(value string) (string, int, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", 0, false
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", 0, false
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return "", 0, false
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || !validPort(port) {
		return "", 0, false
	}
	return host, port, true
}

// dialThroughProxy opens a CONNECT tunnel to target; bytes the target sent early stay readable.
func dialThroughProxy(proxy string, target string) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", proxy, proxyHandshakeTimeout)
	if err != nil {
		return nil, err
	}
	if err := conn.SetDeadline(time.Now().Add(proxyHandshakeTimeout)); err != nil {
		conn.Close()
		return nil, err
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		conn.Close()
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		conn.Close()
		return nil, fmt.Errorf("proxy refused %s: %s", target, response.Status)
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, err
	}
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}

func (c *bufferedConn) CloseWrite() error {
	closeWrite(c.Conn)
	return nil
}

// pipe copies both directions, propagating half-closes, then closes both connections.
func pipe(left net.Conn, right net.Conn) {
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(left, right)
		closeWrite(left)
		close(done)
	}()
	_, _ = io.Copy(right, left)
	closeWrite(right)
	<-done
	left.Close()
	right.Close()
}

func closeWrite(conn net.Conn) {
	if writer, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = writer.CloseWrite()
		return
	}
	conn.Close()
}

func loopbackTarget(listener net.Listener, port int) string {
	host := "127.0.0.1"
	if address, ok := listener.Addr().(*net.TCPAddr); ok && address.IP.To4() == nil {
		host = "::1"
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}
