// No exports. Own coalesced, cancellable discovery of known host-tailnet peers.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"tailscale.com/client/local"
)

type daemonIdentity struct {
	Protocol int `json:"protocol"`
	DaemonID string `json:"daemonId"`
	Hostname string `json:"hostname"`
	State string `json:"state"`
	WakeEnabled bool `json:"wakeEnabled"`
}

type daemonBrowserEndpoints struct {
	HTTPOrigin string `json:"httpOrigin"`
	SecureOrigin *string `json:"secureOrigin"`
}

type daemonDescriptor struct {
	Identity daemonIdentity `json:"identity"`
	Endpoints *daemonBrowserEndpoints `json:"endpoints"`
}

type discoveredDaemon struct {
	Kind string `json:"phase"`
	PeerID string `json:"peerId"`
	Hostname string `json:"hostname"`
	Identity *daemonIdentity `json:"identity,omitempty"`
	Origin string `json:"origin,omitempty"`
	Endpoints *daemonBrowserEndpoints `json:"endpoints,omitempty"`
	Message string `json:"message,omitempty"`
}

type daemonDiscoverySnapshot struct {
	Error string `json:"error,omitempty"`
	Refreshing bool `json:"refreshing"`
	Peers []discoveredDaemon `json:"peers"`
}

type daemonDiscoveryPeer struct {
	id string
	hostname string
	address netip.Addr
}

type daemonDiscovery struct {
	mu sync.Mutex
	cancel context.CancelFunc
	done chan struct{}
	dirty bool
	closed bool
	publish func(daemonDiscoverySnapshot)
	peers func(context.Context) ([]daemonDiscoveryPeer, error)
	probe func(context.Context, daemonDiscoveryPeer) (daemonDescriptor, string, error)
	warn func(error)
}

func (owner *networkProcess) refreshDiscovery() {
	if owner.discovery == nil {
		owner.discovery = newDaemonDiscovery(func(snapshot daemonDiscoverySnapshot) {
			encoded, err := json.Marshal(struct {
				Event string `json:"event"`
				Snapshot daemonDiscoverySnapshot `json:"snapshot"`
			}{Event: "daemon-discovery", Snapshot: snapshot})
			if err == nil { _, err = owner.output.Write(append(encoded, '\n')) }
			if err != nil { owner.cancel() }
		}, func(err error) { fmt.Fprintln(os.Stderr, err.Error()) })
	}
	owner.discovery.refresh(owner.ctx)
}

func newDaemonDiscovery(publish func(daemonDiscoverySnapshot), warn func(error)) *daemonDiscovery {
	return &daemonDiscovery{publish: publish, warn: warn, peers: hostDiscoveryPeers, probe: probeDaemonIdentity}
}

func (owner *daemonDiscovery) refresh(parent context.Context) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.closed { return }
	if owner.done != nil { owner.dirty = true; return }
	ctx, cancel := context.WithCancel(parent)
	owner.cancel = cancel
	done := make(chan struct{})
	owner.done = done
	go func() {
		defer close(done)
		defer cancel()
		for {
			owner.run(ctx)
			owner.mu.Lock()
			if owner.closed || ctx.Err() != nil || !owner.dirty {
				owner.done = nil
				owner.mu.Unlock()
				return
			}
			owner.dirty = false
			owner.mu.Unlock()
		}
	}()
}

func (owner *daemonDiscovery) close() {
	owner.mu.Lock()
	owner.closed = true
	if owner.cancel != nil { owner.cancel() }
	done := owner.done
	owner.mu.Unlock()
	if done != nil { <-done }
}

func (owner *daemonDiscovery) run(ctx context.Context) {
	peers, err := owner.peers(ctx)
	if err != nil {
		if ctx.Err() == nil {
			owner.warn(errors.New("Tailscale daemon discovery could not read peers"))
			owner.publish(daemonDiscoverySnapshot{Peers: []discoveredDaemon{}, Error: "Tailscale daemon discovery could not read peers."})
		}
		return
	}
	if len(peers) > 4096 { peers = peers[:4096] }
	snapshot := daemonDiscoverySnapshot{Refreshing: true, Peers: make([]discoveredDaemon, len(peers))}
	for index, peer := range peers {
		snapshot.Peers[index] = discoveredDaemon{Kind: "pending", PeerID: peer.id, Hostname: peer.hostname}
	}
	owner.publish(snapshot)
	var mu sync.Mutex
	var workers sync.WaitGroup
	jobs := make(chan int)
	for range min(4, len(peers)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				descriptor, origin, err := owner.probe(ctx, peers[index])
				if ctx.Err() != nil { return }
				mu.Lock()
				item := &snapshot.Peers[index]
				if err != nil {
					item.Kind, item.Message = "failed", "Workbench identity could not be verified."
				} else {
					item.Kind, item.Identity, item.Origin, item.Endpoints = "verified", &descriptor.Identity, origin, descriptor.Endpoints
				}
				// Every publication owns its slice; no worker mutates an emitted value.
				copy := snapshot
				copy.Peers = append([]discoveredDaemon{}, snapshot.Peers...)
				owner.publish(copy)
				mu.Unlock()
			}
		}()
	}
loop:
	for index := range peers {
		select {
		case jobs <- index:
		case <-ctx.Done(): break loop
		}
	}
	close(jobs)
	workers.Wait()
	if ctx.Err() == nil {
		snapshot.Refreshing = false
		owner.publish(snapshot)
	}
}

func hostDiscoveryPeers(ctx context.Context) ([]daemonDiscoveryPeer, error) {
	client := &local.Client{}
	status, err := client.Status(ctx)
	if err != nil { return nil, err }
	peers := []daemonDiscoveryPeer{}
	for _, peer := range status.Peer {
		if peer.ID == "" || !peer.Online || len(peer.TailscaleIPs) == 0 { continue }
		address := peer.TailscaleIPs[0]
		for _, candidate := range peer.TailscaleIPs {
			if candidate.Is4() { address = candidate; break }
		}
		if !tailnetAddress(address) { continue }
		hostname := strings.Split(peer.DNSName, ".")[0]
		if hostname == "" { hostname = peer.HostName }
		if hostname == "" { hostname = string(peer.ID) }
		if len(hostname) > 253 { hostname = hostname[:253] }
		peers = append(peers, daemonDiscoveryPeer{id: string(peer.ID), hostname: hostname, address: address})
	}
	sort.Slice(peers, func(left, right int) bool { return peers[left].id < peers[right].id })
	return peers, nil
}

var daemonUUID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func probeDaemonIdentity(ctx context.Context, peer daemonDiscoveryPeer) (daemonDescriptor, string, error) {
	var descriptor daemonDescriptor
	if !tailnetAddress(peer.address) { return descriptor, "", errors.New("peer is not a tailnet address") }
	origin := "http://" + net.JoinHostPort(peer.address.String(), strconv.Itoa(int(daemonTailnetPort)))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/_workbench-service/identity", nil)
	if err != nil { return descriptor, "", err }
	request.Header.Set("x-workbench-identity-version", "2")
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil { return descriptor, "", err }
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK { return descriptor, "", errors.New("peer did not publish an identity") }
	bytes, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(bytes) > 16384 { return descriptor, "", errors.New("peer identity exceeded its limit") }
	descriptor, err = decodeDaemonDescriptor(bytes, origin)
	if err != nil { return daemonDescriptor{}, "", err }
	return descriptor, origin, nil
}

func decodeDaemonDescriptor(bytes []byte, origin string) (daemonDescriptor, error) {
	var envelope struct { Identity json.RawMessage `json:"identity"`; Endpoints *daemonBrowserEndpoints `json:"endpoints"` }
	if err := json.Unmarshal(bytes, &envelope); err != nil { return daemonDescriptor{}, err }
	var descriptor daemonDescriptor
	payload := bytes
	if len(envelope.Identity) != 0 {
		payload = envelope.Identity
		descriptor.Endpoints = envelope.Endpoints
	}
	if err := json.Unmarshal(payload, &descriptor.Identity); err != nil { return daemonDescriptor{}, err }
	identity := descriptor.Identity
	if identity.Protocol != 1 || !daemonUUID.MatchString(identity.DaemonID) || len(identity.Hostname) == 0 || len(identity.Hostname) > 253 {
		return daemonDescriptor{}, errors.New("peer identity is invalid")
	}
	switch identity.State {
	case "sleeping", "starting", "ready", "failed":
	default: return daemonDescriptor{}, errors.New("peer lifecycle is invalid")
	}
	if descriptor.Endpoints != nil && !validDaemonEndpoints(*descriptor.Endpoints, origin) { descriptor.Endpoints = nil }
	return descriptor, nil
}

func validDaemonEndpoints(endpoints daemonBrowserEndpoints, origin string) bool {
	if endpoints.HTTPOrigin != origin { return false }
	if endpoints.SecureOrigin == nil { return true }
	parsed, err := url.Parse(*endpoints.SecureOrigin)
	if err != nil || parsed == nil { return false }
	port, portError := strconv.Atoi(parsed.Port())
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Path != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || portError != nil || port < 1 || port > 65535 ||
		!strings.HasSuffix(parsed.Hostname(), ".wb.inthedark.boo") || parsed.String() != *endpoints.SecureOrigin {
		return false
	}
	return true
}
