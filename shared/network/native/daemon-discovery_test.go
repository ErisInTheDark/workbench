// No exports. Protect discovery coalescing, cancellation and non-tailnet rejection.
package main

import (
	"context"
	"encoding/json"
	"net/netip"
	"sync/atomic"
	"testing"
)

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
