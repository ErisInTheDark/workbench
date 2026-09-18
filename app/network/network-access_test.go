// No exports. Protect device/app isolation and fail-closed network identity.
package main

import (
	"context"
	"testing"
)

func TestAccessRevocationClosesOwnedConnection(t *testing.T) {
	access := &networkAccess{}
	closed := false
	ctx, release, err := access.admit(context.Background(), "phone", "nas", func() error { closed = true; return nil })
	if err != nil { t.Fatal(err) }
	defer release()
	if err := access.apply(&networkGroup{Access: "selected", Grants: []networkGrant{}}); err != nil { t.Fatal(err) }
	if ctx.Err() == nil || !closed { t.Fatal("revocation acknowledged without closing the device's active app connection") }
	if _, _, err := access.admit(context.Background(), "phone", "nas"); err == nil { t.Fatal("revoked device reconnected") }
}

func TestNetworkAccess(t *testing.T) {
	group := &networkGroup{
		ID: "network", Revision: 1, OwnerNodeID: "owner", DNSNodeID: "nas",
		Access: "selected", Grants: []networkGrant{{DeviceNodeID: "phone", AppNodeID: "nas"}},
	}
	for _, test := range []struct {
		device, app string
		local, allowed bool
	}{
		{"", "nas", true, true},
		{"phone", "nas", false, true},
		{"phone", "desktop", false, false},
		{"stranger", "nas", false, false},
		{"", "nas", false, false},
	} {
		if got := group.allows(test.device, test.app, test.local); got != test.allowed {
			t.Fatalf("access(%q, %q, %v) = %v", test.device, test.app, test.local, got)
		}
	}
	group.Access = "all"
	if !group.allows("stranger", "nas", false) || group.allows("", "nas", false) {
		t.Fatal("open access must still require an authenticated Tailscale device")
	}
}
