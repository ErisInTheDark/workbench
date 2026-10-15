// No exports. Mirrors host loopback listeners into the sandbox namespace, tunnelling each connection through the proxy.
package main

import (
	"net"
	"strconv"
	"sync"
)

// listenFunc binds the namespace-local listeners standing in for one host port.
type listenFunc func(port int) []net.Listener

func listenLoopback(port int) []net.Listener {
	var listeners []net.Listener
	for _, host := range []string{"127.0.0.1", "::1"} {
		if listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port))); err == nil {
			listeners = append(listeners, listener)
		}
	}
	return listeners
}

type mirror struct {
	proxy  string
	listen listenFunc
	mu     sync.Mutex
	ports  map[int][]net.Listener
	closed bool
}

func newMirror(proxy string, listen listenFunc) *mirror {
	return &mirror{proxy: proxy, listen: listen, ports: map[int][]net.Listener{}}
}

// update makes the mirrored set match ports. Ports the namespace already uses stay unmirrored.
func (m *mirror) update(ports []int) {
	wanted := map[int]struct{}{}
	for _, port := range ports {
		wanted[port] = struct{}{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	for port, listeners := range m.ports {
		if _, keep := wanted[port]; !keep {
			closeListeners(listeners)
			delete(m.ports, port)
		}
	}
	for port := range wanted {
		if _, held := m.ports[port]; held {
			continue
		}
		listeners := m.listen(port)
		if len(listeners) == 0 {
			continue
		}
		m.ports[port] = listeners
		for _, listener := range listeners {
			go m.serve(listener, loopbackTarget(listener, port))
		}
	}
}

// owned reports the namespace ports bound by the mirror itself.
func (m *mirror) owned() map[int]struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	owned := map[int]struct{}{}
	for _, listeners := range m.ports {
		for _, listener := range listeners {
			if address, ok := listener.Addr().(*net.TCPAddr); ok {
				owned[address.Port] = struct{}{}
			}
		}
	}
	return owned
}

func (m *mirror) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for port, listeners := range m.ports {
		closeListeners(listeners)
		delete(m.ports, port)
	}
}

func (m *mirror) serve(listener net.Listener, target string) {
	for {
		client, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			upstream, err := dialThroughProxy(m.proxy, target)
			if err != nil {
				client.Close()
				return
			}
			pipe(client, upstream)
		}()
	}
}

func closeListeners(listeners []net.Listener) {
	for _, listener := range listeners {
		listener.Close()
	}
}
