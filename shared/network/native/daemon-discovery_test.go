// No exports. Protect discovery coalescing, cancellation, incomplete-publication re-probes and non-tailnet rejection.
package main

import (
	"context"
	"encoding/json"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"
)

const testDaemonID = "063e3626-50f7-4635-950e-cdff695d0bc1"

func testPeers() []daemonDiscoveryPeer {
	return []daemonDiscoveryPeer{
		{id: "complete", hostname: "complete", address: netip.MustParseAddr("100.64.1.2")},
		{id: "incomplete", hostname: "incomplete", address: netip.MustParseAddr("100.64.1.3")},
	}
}

func testDescriptor(peer daemonDiscoveryPeer, published bool) (daemonDescriptor, string) {
	origin := "http://" + peer.address.String() + ":52739"
	descriptor := daemonDescriptor{Identity: daemonIdentity{Protocol: 1, DaemonID: testDaemonID, Hostname: peer.hostname, State: "ready"}}
	if published { descriptor.Endpoints = &daemonBrowserEndpoints{HTTPOrigin: origin} }
	return descriptor, origin
}

func manualRetries() (func(time.Duration) <-chan time.Time, <-chan chan time.Time) {
	timers := make(chan chan time.Time, 8)
	return func(time.Duration) <-chan time.Time {
		timer := make(chan time.Time, 1)
		timers <- timer
		return timer
	}, timers
}

func runningDiscovery(owner *daemonDiscovery) <-chan struct{} {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.done
}

func nextRetry(t *testing.T, done <-chan struct{}, timers <-chan chan time.Time) chan time.Time {
	t.Helper()
	select {
	case timer := <-timers: return timer
	case <-done:
		t.Fatal("discovery stopped while a peer publication was incomplete")
		return nil
	}
}

func TestDiscoveryReprobesIncompletePublicationUntilEndpointsAppear(t *testing.T) {
	var walks, completeProbes, incompleteProbes atomic.Int32
	after, timers := manualRetries()
	published := make(chan daemonDiscoverySnapshot, 64)
	owner := &daemonDiscovery{
		peers: func(context.Context) ([]daemonDiscoveryPeer, error) { walks.Add(1); return testPeers(), nil },
		probe: func(ctx context.Context, peer daemonDiscoveryPeer) (daemonDescriptor, string, error) {
			if peer.id == "complete" {
				completeProbes.Add(1)
				descriptor, origin := testDescriptor(peer, true)
				return descriptor, origin, nil
			}
			descriptor, origin := testDescriptor(peer, incompleteProbes.Add(1) >= 3)
			return descriptor, origin, nil
		},
		publish: func(snapshot daemonDiscoverySnapshot) { published <- snapshot },
		warn: func(error) { t.Error("unexpected discovery failure") },
		after: after,
	}
	defer owner.close()
	owner.refresh(t.Context())
	done := runningDiscovery(owner)
	nextRetry(t, done, timers) <- time.Time{}
	nextRetry(t, done, timers) <- time.Time{}
	<-done
	var last daemonDiscoverySnapshot
	for len(published) > 0 { last = <-published }
	if len(last.Peers) != 2 || last.Peers[1].Endpoints == nil || last.Peers[0].Endpoints == nil {
		t.Fatalf("final publication lacks verified endpoints: %+v", last)
	}
	if walks.Load() != 1 || completeProbes.Load() != 1 || incompleteProbes.Load() != 3 {
		t.Fatalf("re-probes touched more than the incomplete peer: walks=%d complete=%d incomplete=%d",
			walks.Load(), completeProbes.Load(), incompleteProbes.Load())
	}
}

func TestDiscoveryRetryWaitYieldsToRefreshAndClose(t *testing.T) {
	var walks atomic.Int32
	after, timers := manualRetries()
	owner := &daemonDiscovery{
		peers: func(context.Context) ([]daemonDiscoveryPeer, error) { walks.Add(1); return testPeers()[1:], nil },
		probe: func(ctx context.Context, peer daemonDiscoveryPeer) (daemonDescriptor, string, error) {
			descriptor, origin := testDescriptor(peer, false)
			return descriptor, origin, nil
		},
		publish: func(daemonDiscoverySnapshot) {},
		warn: func(error) { t.Error("unexpected discovery failure") },
		after: after,
	}
	owner.refresh(t.Context())
	done := runningDiscovery(owner)
	nextRetry(t, done, timers)
	owner.refresh(t.Context())
	nextRetry(t, done, timers)
	if walks.Load() != 2 { t.Fatalf("refresh during a retry wait ran %d walks", walks.Load()) }
	owner.close()
	select {
	case <-done:
	default: t.Fatal("close returned before the retry wait ended")
	}
}

func TestDiscoveryDescriptorKeepsOnlyVerifiedEndpoints(t *testing.T) {
	origin := "http://100.64.1.2:52739"
	identity := `{"protocol":1,"daemonId":"063e3626-50f7-4635-950e-cdff695d0bc1","hostname":"peer","state":"sleeping","wakeEnabled":true}`
	for _, test := range []struct {
		name string
		body string
		secure string
	}{
		{"legacy", identity, ""},
		{"published", `{"identity":` + identity + `,"endpoints":{"httpOrigin":"` + origin + `","secureOrigin":"https://peer.wb.inthedark.boo:32123"}}`, "https://peer.wb.inthedark.boo:32123"},
		{"without private TLS", `{"identity":` + identity + `,"endpoints":{"httpOrigin":"` + origin + `","secureOrigin":null}}`, ""},
		{"wrong peer", `{"identity":` + identity + `,"endpoints":{"httpOrigin":"http://100.64.1.3:52739","secureOrigin":"https://peer.wb.inthedark.boo:32123"}}`, ""},
		{"external secure host", `{"identity":` + identity + `,"endpoints":{"httpOrigin":"` + origin + `","secureOrigin":"https://example.com:32123"}}`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			descriptor, err := decodeDaemonDescriptor([]byte(test.body), origin)
			if err != nil { t.Fatal(err) }
			secure := ""
			if descriptor.Endpoints != nil && descriptor.Endpoints.SecureOrigin != nil {
				secure = *descriptor.Endpoints.SecureOrigin
			}
			if descriptor.Identity.DaemonID != "063e3626-50f7-4635-950e-cdff695d0bc1" || secure != test.secure {
				t.Fatalf("wrong verified descriptor: %+v", descriptor)
			}
			if test.name == "without private TLS" {
				encoded, err := json.Marshal(descriptor.Endpoints)
				if err != nil { t.Fatal(err) }
				if string(encoded) != `{"httpOrigin":"` + origin + `","secureOrigin":null}` {
					t.Fatalf("nullable endpoint changed on the wire: %s", encoded)
				}
			}
		})
	}
}

func TestDiscoveryCoalescesInvalidationsAndOwnsCancellation(t *testing.T) {
	var reads atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	published := make(chan daemonDiscoverySnapshot, 16)
	owner := &daemonDiscovery{
		peers: func(context.Context) ([]daemonDiscoveryPeer, error) {
			reads.Add(1)
			return []daemonDiscoveryPeer{{id: "peer", hostname: "peer", address: netip.MustParseAddr("100.64.1.2")}}, nil
		},
		probe: func(ctx context.Context, peer daemonDiscoveryPeer) (daemonDescriptor, string, error) {
			if reads.Load() == 1 { close(entered); select { case <-release: case <-ctx.Done(): } }
			return daemonDescriptor{Identity: daemonIdentity{Protocol: 1, DaemonID: "063e3626-50f7-4635-950e-cdff695d0bc1", Hostname: "peer", State: "sleeping"}}, "http://100.64.1.2:52739", ctx.Err()
		},
		publish: func(snapshot daemonDiscoverySnapshot) { published <- snapshot },
		warn: func(error) { t.Error("unexpected discovery failure") },
		after: func(time.Duration) <-chan time.Time { return nil },
	}
	owner.refresh(t.Context())
	<-entered
	for range 20 { owner.refresh(t.Context()) }
	close(release)
	completed := 0
	for completed < 2 {
		snapshot := <-published
		if !snapshot.Refreshing {
			completed++
			if len(snapshot.Peers) != 1 || snapshot.Peers[0].Kind != "verified" { t.Fatal("peer observation was not verified") }
		}
	}
	owner.close()
	if reads.Load() != 2 { t.Fatalf("burst spawned %d peer walks", reads.Load()) }
	owner.refresh(t.Context())
	if reads.Load() != 2 { t.Fatal("disposed discovery accepted more work") }
}

func TestDiscoveryNeverProbesNonTailnetDestinations(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "192.168.1.2", "8.8.8.8", "::1"} {
		_, _, err := probeDaemonIdentity(t.Context(), daemonDiscoveryPeer{address: netip.MustParseAddr(address)})
		if err == nil { t.Fatalf("accepted non-tailnet address %s", address) }
	}
}
