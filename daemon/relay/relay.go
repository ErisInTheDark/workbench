// No exports. Owns one command's broker control connection: host port mirroring and reverse forwarding of sandbox listeners.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"strconv"
	"sync"
	"time"
)

type dependencies struct {
	listen        listenFunc
	dialLocal     func(port int) (net.Conn, error)
	readListeners func() (map[int]struct{}, error)
	// How often sandbox listeners are rescanned; a new server becomes host-reachable within one interval.
	pollInterval time.Duration
	// How long the broker may take to send the first host ports before the command starts unrelayed.
	startupTimeout time.Duration
}

func defaultDependencies() dependencies {
	return dependencies{
		listen:         listenLoopback,
		dialLocal:      dialLoopback,
		readListeners:  readListeningPorts,
		pollInterval:   500 * time.Millisecond,
		startupTimeout: 5 * time.Second,
	}
}

func dialLoopback(port int) (net.Conn, error) {
	var failures []error
	for _, host := range []string{"127.0.0.1", "::1"} {
		conn, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err == nil {
			return conn, nil
		}
		failures = append(failures, err)
	}
	return nil, errors.Join(failures...)
}

type relay struct {
	config     relayConfig
	proxy      string
	proxyPorts map[int]struct{}
	deps       dependencies
	stderr     io.Writer
	control    net.Conn
	reader     *bufio.Reader
	writeMu    sync.Mutex
	mirror     *mirror
	stop       chan struct{}
	stopOnce   sync.Once
}

// startRelay connects to the broker and mirrors the first host port set before returning.
func startRelay(env map[string]string, deps dependencies, stderr io.Writer) (*relay, error) {
	raw, ok := env[relayEnvKey]
	if !ok {
		return nil, fmt.Errorf("%s is not set", relayEnvKey)
	}
	config, err := parseRelayConfig(raw)
	if err != nil {
		return nil, err
	}
	proxy, err := proxyAddress(env)
	if err != nil {
		return nil, err
	}
	control, err := dialThroughProxy(proxy, config.Broker)
	if err != nil {
		return nil, fmt.Errorf("broker: %w", err)
	}
	r := &relay{
		config: config, proxy: proxy, proxyPorts: proxyPorts(env), deps: deps, stderr: stderr,
		control: control, reader: bufio.NewReaderSize(control, maxMessageBytes),
		mirror: newMirror(proxy, deps.listen), stop: make(chan struct{}),
	}
	first, err := r.handshake()
	if err != nil {
		r.close()
		return nil, fmt.Errorf("broker: %w", err)
	}
	r.mirror.update(first.Ports)
	go r.readControl()
	go r.pollSandboxPorts()
	return r, nil
}

func (r *relay) handshake() (brokerMessage, error) {
	if err := r.send(helloMessage{Type: "hello", Token: r.config.Token}); err != nil {
		return brokerMessage{}, err
	}
	if err := r.control.SetReadDeadline(time.Now().Add(r.deps.startupTimeout)); err != nil {
		return brokerMessage{}, err
	}
	first, err := r.receive()
	if err != nil {
		return brokerMessage{}, err
	}
	if first.Type != "hostPorts" {
		return brokerMessage{}, fmt.Errorf("expected hostPorts, got %s", first.Type)
	}
	return first, r.control.SetReadDeadline(time.Time{})
}

func (r *relay) close() {
	r.stopOnce.Do(func() {
		close(r.stop)
		r.control.Close()
		r.mirror.close()
	})
}

func (r *relay) stopped() bool {
	select {
	case <-r.stop:
		return true
	default:
		return false
	}
}

func (r *relay) send(message any) error {
	line, err := encodeMessage(message)
	if err != nil {
		return err
	}
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	_, err = r.control.Write(line)
	return err
}

func (r *relay) receive() (brokerMessage, error) {
	line, err := r.reader.ReadSlice('\n')
	if err != nil {
		return brokerMessage{}, err
	}
	return parseBrokerMessage(line)
}

func (r *relay) readControl() {
	for {
		message, err := r.receive()
		if err != nil {
			if !r.stopped() {
				fmt.Fprintf(r.stderr, "workbench relay disconnected: %v\n", err)
				r.close()
			}
			return
		}
		switch message.Type {
		case "hostPorts":
			r.mirror.update(message.Ports)
		case "open":
			go r.openReverse(message.ID, message.Port)
		}
	}
}

// pollSandboxPorts reports the command's own loopback listeners so the broker can expose them on the host.
func (r *relay) pollSandboxPorts() {
	ticker := time.NewTicker(r.deps.pollInterval)
	defer ticker.Stop()
	var reported map[int]struct{}
	for {
		listening, err := r.deps.readListeners()
		if err != nil {
			fmt.Fprintf(r.stderr, "workbench relay cannot read sandbox listeners: %v\n", err)
			return
		}
		for port := range r.mirror.owned() {
			delete(listening, port)
		}
		for port := range r.proxyPorts {
			delete(listening, port)
		}
		if reported == nil || !maps.Equal(listening, reported) {
			if err := r.send(sandboxPortsMessage(listening)); err != nil {
				return
			}
			reported = listening
		}
		select {
		case <-r.stop:
			return
		case <-ticker.C:
		}
	}
}

// openReverse carries one host connection, accepted by the broker, to a sandbox listener.
func (r *relay) openReverse(id string, port int) {
	upstream, err := dialThroughProxy(r.proxy, r.config.Broker)
	if err != nil {
		return
	}
	line, err := encodeMessage(acceptMessage{Type: "accept", Token: r.config.Token, ID: id})
	if err == nil {
		_, err = upstream.Write(line)
	}
	if err != nil {
		upstream.Close()
		return
	}
	local, err := r.deps.dialLocal(port)
	if err != nil {
		upstream.Close()
		return
	}
	pipe(upstream, local)
}
