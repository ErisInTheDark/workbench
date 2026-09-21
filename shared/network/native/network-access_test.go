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

func TestSelfAccessSurvivesRestrictions(t *testing.T) {
	access := &networkAccess{ownsConnection: func(device, app string) bool {
		return device == "desktop-host" && app == "desktop-app"
	}}
	closed := false
	ctx, release, err := access.admit(context.Background(), "desktop-host", "desktop-app", func() error { closed = true; return nil })
	if err != nil { t.Fatal(err) }
	defer release()
	if err := access.apply(&networkGroup{Access: "selected"}); err != nil { t.Fatal(err) }
	if ctx.Err() != nil || closed { t.Fatal("selected-device policy revoked this device's own app connection") }
	for _, identity := range []struct { device, app string; allowed bool }{
		{"desktop-host", "desktop-app", true},
		{"desktop-host", "other-app", false},
		{"other-host", "desktop-app", false},
		{"", "desktop-app", false},
	} {
		_, done, err := access.admit(context.Background(), identity.device, identity.app)
		if done != nil { done() }
		if (err == nil) != identity.allowed { t.Fatalf("incorrect access for %q to %q", identity.device, identity.app) }
	}
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
