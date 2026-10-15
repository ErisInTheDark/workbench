package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testWait = 5 * time.Second

func listenLocal(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	return listener
}

func portOf(address net.Addr) int {
	return address.(*net.TCPAddr).Port
}

func startEcho(t *testing.T) int {
	listener := listenLocal(t)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_, _ = io.Copy(conn, conn)
				conn.Close()
			}()
		}
	}()
	return portOf(listener.Addr())
}

// startProxy imitates Codex's managed proxy: CONNECT to any reachable target, 502 otherwise.
func startProxy(t *testing.T) int {
	listener := listenLocal(t)
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				reader := bufio.NewReader(client)
				request, err := http.ReadRequest(reader)
				if err != nil || request.Method != http.MethodConnect {
					client.Close()
					return
				}
				upstream, err := net.Dial("tcp", request.Host)
				if err != nil {
					_, _ = io.WriteString(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
					client.Close()
					return
				}
				_, _ = io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n")
				pipe(&bufferedConn{Conn: client, reader: reader}, upstream)
			}()
		}
	}()
	return portOf(listener.Addr())
}

type brokerConn struct {
	net.Conn
	reader *bufio.Reader
	first  map[string]any
}

func (c *brokerConn) sendLine(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(c, line+"\n"); err != nil {
		t.Fatal(err)
	}
}

func (c *brokerConn) readMessage(t *testing.T) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(testWait))
	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := json.Unmarshal(line, &message); err != nil {
		t.Fatal(err)
	}
	return message
}

type fakeBroker struct {
	port    int
	control chan *brokerConn
	data    chan *brokerConn
}

func startBroker(t *testing.T) *fakeBroker {
	listener := listenLocal(t)
	broker := &fakeBroker{port: portOf(listener.Addr()), control: make(chan *brokerConn, 4), data: make(chan *brokerConn, 4)}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				accepted := &brokerConn{Conn: conn, reader: bufio.NewReader(conn)}
				line, err := accepted.reader.ReadBytes('\n')
				if err != nil || json.Unmarshal(line, &accepted.first) != nil {
					conn.Close()
					return
				}
				if accepted.first["type"] == "hello" {
					broker.control <- accepted
				} else {
					broker.data <- accepted
				}
			}()
		}
	}()
	return broker
}

func receive[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(testWait):
		t.Fatal("timed out waiting for relay traffic")
		panic("unreachable")
	}
}

func relayEnv(proxyPort int, brokerPort int) map[string]string {
	return map[string]string{
		relayEnvKey:  fmt.Sprintf(`{"broker":"127.0.0.1:%d","token":"secret"}`, brokerPort),
		"HTTP_PROXY": fmt.Sprintf("http://127.0.0.1:%d", proxyPort),
	}
}

func assertEcho(t *testing.T, conn net.Conn, text string) {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(testWait))
	if _, err := io.WriteString(conn, text); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, len(text))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if string(reply) != text {
		t.Fatalf("echo = %q, want %q", reply, text)
	}
}

type mirroredListener struct {
	hostPort int
	address  net.Addr
}

// recordingListen binds stand-ins on ephemeral ports, since host and test share one namespace.
func recordingListen(t *testing.T, bound chan<- mirroredListener, owned *sync.Map) listenFunc {
	return func(port int) []net.Listener {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Error(err)
			return nil
		}
		owned.Store(portOf(listener.Addr()), true)
		bound <- mirroredListener{hostPort: port, address: listener.Addr()}
		return []net.Listener{listener}
	}
}

func startTestRelay(t *testing.T, deps dependencies, env map[string]string, broker *fakeBroker, hostPorts ...int) (*relay, *brokerConn) {
	t.Helper()
	type started struct {
		relay *relay
		err   error
	}
	result := make(chan started, 1)
	go func() {
		relay, err := startRelay(env, deps, io.Discard)
		result <- started{relay, err}
	}()
	control := receive(t, broker.control)
	if control.first["token"] != "secret" {
		t.Fatalf("hello = %v", control.first)
	}
	ports, _ := json.Marshal(hostPorts)
	control.sendLine(t, fmt.Sprintf(`{"type":"hostPorts","ports":%s}`, ports))
	outcome := receive(t, result)
	if outcome.err != nil {
		t.Fatal(outcome.err)
	}
	t.Cleanup(outcome.relay.close)
	return outcome.relay, control
}

func TestRelayCarriesRawTcpToMirroredHostPorts(t *testing.T) {
	first, second := startEcho(t), startEcho(t)
	broker := startBroker(t)
	bound := make(chan mirroredListener, 4)
	deps := defaultDependencies()
	deps.listen = recordingListen(t, bound, &sync.Map{})
	deps.readListeners = func() (map[int]struct{}, error) { return map[int]struct{}{}, nil }

	_, control := startTestRelay(t, deps, relayEnv(startProxy(t), broker.port), broker, first)
	mirrored := receive(t, bound)
	if mirrored.hostPort != first {
		t.Fatalf("mirrored %d, want %d", mirrored.hostPort, first)
	}
	conn, err := net.Dial("tcp", mirrored.address.String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	assertEcho(t, conn, "raw bytes, no http")

	control.sendLine(t, fmt.Sprintf(`{"type":"hostPorts","ports":[%d,%d]}`, first, second))
	added := receive(t, bound)
	if added.hostPort != second {
		t.Fatalf("mirrored %d, want %d", added.hostPort, second)
	}
	late, err := net.Dial("tcp", added.address.String())
	if err != nil {
		t.Fatal(err)
	}
	defer late.Close()
	assertEcho(t, late, "service that appeared later")
}

func TestMirrorUpdateClosesRemovedPorts(t *testing.T) {
	bound := make(chan mirroredListener, 2)
	mirror := newMirror("127.0.0.1:1", recordingListen(t, bound, &sync.Map{}))
	defer mirror.close()
	mirror.update([]int{4242})
	address := receive(t, bound).address.String()
	mirror.update(nil)
	if conn, err := net.Dial("tcp", address); err == nil {
		conn.Close()
		t.Fatal("removed host port is still mirrored")
	}
}

func TestRelayExposesOnlyTheCommandsListenersAndCarriesReverseConnections(t *testing.T) {
	inner := startEcho(t)
	proxyPort := startProxy(t)
	broker := startBroker(t)
	owned := &sync.Map{}
	deps := defaultDependencies()
	deps.listen = recordingListen(t, make(chan mirroredListener, 4), owned)
	deps.readListeners = func() (map[int]struct{}, error) {
		listening := map[int]struct{}{inner: {}, proxyPort: {}}
		owned.Range(func(port, _ any) bool {
			listening[port.(int)] = struct{}{}
			return true
		})
		return listening, nil
	}

	_, control := startTestRelay(t, deps, relayEnv(proxyPort, broker.port), broker, startEcho(t))
	reported := control.readMessage(t)
	ports, _ := reported["ports"].([]any)
	if reported["type"] != "sandboxPorts" || len(ports) != 1 || int(ports[0].(float64)) != inner {
		t.Fatalf("sandboxPorts = %v, want only %d", reported, inner)
	}

	control.sendLine(t, fmt.Sprintf(`{"type":"open","id":"conn-1","port":%d}`, inner))
	data := receive(t, broker.data)
	defer data.Close()
	if data.first["type"] != "accept" || data.first["token"] != "secret" || data.first["id"] != "conn-1" {
		t.Fatalf("accept = %v", data.first)
	}
	assertEcho(t, &bufferedConn{Conn: data.Conn, reader: data.reader}, "host to sandbox")
}

func TestUnavailableBrokerStillRunsTheCommandWithoutRelayConfig(t *testing.T) {
	unused := listenLocal(t)
	brokerPort := portOf(unused.Addr())
	unused.Close()
	env := relayEnv(startProxy(t), brokerPort)
	environ := append(os.Environ(), "RELAY_TEST_CHILD_EXIT=7")
	for key, value := range env {
		environ = append(environ, key+"="+value)
	}
	var stderr bytes.Buffer

	code := run([]string{"--", os.Args[0], "-test.run=^TestHelperChild$"}, environ, nil, io.Discard, &stderr, defaultDependencies())

	if code != 7 {
		t.Fatalf("exit code = %d, want 7 (3 means the child saw %s); stderr: %s", code, relayEnvKey, stderr.String())
	}
	if !strings.Contains(stderr.String(), "workbench relay unavailable") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestHelperChild(t *testing.T) {
	code := os.Getenv("RELAY_TEST_CHILD_EXIT")
	if code == "" {
		return
	}
	if _, leaked := os.LookupEnv(relayEnvKey); leaked {
		os.Exit(3)
	}
	exit, _ := strconv.Atoi(code)
	os.Exit(exit)
}
