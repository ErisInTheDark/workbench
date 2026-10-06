// No exports. Protect directory integrity, root continuity and owner-authenticated updates.
package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLateEnrolmentCannotOverwriteAnAddressChange(t *testing.T) {
	node := &privateNetwork{directory: t.TempDir()}
	node.settings.Store(&privateConfiguration{Role: "unconfigured", Label: "renamed"})
	node.presentation.Store(&privatePresentation{hostname: "renamed.wb.inthedark.boo"})
	persisted := false
	group := &networkGroupController{node: node, persist: func(context.Context, *uint64, networkConfiguration) error {
		persisted = true
		return nil
	}}
	if err := group.acceptEnrolment(context.Background(), "owner", "previous.wb.inthedark.boo", nil, groupWelcome{}); err == nil {
		t.Fatal("late enrolment for an old address was accepted")
	}
	if persisted { t.Fatal("late enrolment changed durable membership") }
	if _, err := os.Stat(filepath.Join(node.directory, "leaf.pem")); !os.IsNotExist(err) { t.Fatal("late enrolment replaced the current certificate") }
}

func TestDNSPublicationCannotSucceedWithoutSigningTheUpdate(t *testing.T) {
	directory := directoryFixture()
	self := "desktop"
	node := &privateNetwork{directory: t.TempDir(), publish: func(privateStatus) {}, status: privateStatus{NodeID: &self}}
	group := &networkGroupController{
		node: node, authority: &networkAuthority{node: node},
		read: func() networkConfiguration { return networkConfiguration{Group: &directory.Group, Members: directory.Members} },
	}
	if err := group.publishDNS(context.Background()); err == nil {
		t.Fatal("remote DNS publication succeeded without a signed update or acknowledgement")
	}
}

func directoryFixture() networkDirectory {
	return networkDirectory{
		Group: networkGroup{ID: "network", Revision: 1, OwnerNodeID: "desktop", DNSNodeID: "nas", Access: "all", Grants: []networkGrant{}},
		Members: []networkMember{
			{NodeID: "desktop", Label: "desktop", Addresses: []string{"100.80.0.1"}, KeyFingerprint: strings.Repeat("a", 64)},
			{NodeID: "nas", Label: "nas", Addresses: []string{"100.80.0.2"}, KeyFingerprint: strings.Repeat("b", 64)},
		},
	}
}

func TestDirectorySignature(t *testing.T) {
	ca, err := createAuthority(time.Now())
	if err != nil { t.Fatal(err) }
	directory := directoryFixture()
	envelope, err := signDirectory(directory, ca)
	if err != nil { t.Fatal(err) }
	root := string(publicCertificatePEM(ca.certificate))
	if err := envelope.verify(root, "desktop"); err != nil { t.Fatal(err) }
	if envelope.verify(root, "nas") == nil { t.Fatal("a directory member impersonated its owner") }
	envelope.Directory.Group.DNSNodeID = "desktop"
	if envelope.verify(root, "desktop") == nil { t.Fatal("tampered directory retained authority") }
	envelope, err = signDirectory(directory, ca)
	if err != nil { t.Fatal(err) }
	other, err := createAuthority(time.Now())
	if err != nil { t.Fatal(err) }
	if envelope.verify(string(publicCertificatePEM(other.certificate)), "desktop") == nil { t.Fatal("directory replaced pinned network trust") }
}

func TestDirectoryConflicts(t *testing.T) {
	directory := directoryFixture()
	directory.Members[1].Label = "desktop"
	if directory.validate() == nil { t.Fatal("duplicate app name accepted") }
	directory = directoryFixture()
	directory.Group.DNSNodeID = "missing"
	if directory.validate() == nil { t.Fatal("unknown nameserver accepted") }
}

func TestBrowsingDeviceDirectoryExcludesWorkbenchAppNodes(t *testing.T) {
	for _, test := range []struct {
		id, name string
		online bool
		visible bool
	}{
		{id: "host", name: "Velvet", online: true, visible: true},
		{id: "offline", name: "BinkyMachine", visible: true},
		{id: "app", name: "wb-velvet", online: true, visible: false},
		{id: "other-app", name: "wb-unenrolled", visible: false},
		{name: "missing-id", online: true, visible: false},
	} {
		device, visible := browsingDevice(test.id, test.name, test.online)
		if visible != test.visible {
			t.Fatalf("browsingDevice(%q, %q) visible = %v", test.id, test.name, visible)
		}
		if visible && (device.NodeID != test.id || device.Name != test.name || device.Online != test.online) {
			t.Fatalf("browsingDevice(%q, %q) returned %#v", test.id, test.name, device)
		}
	}
}

func TestHostIdentityRepairChangesDirectoryOnce(t *testing.T) {
	directory := directoryFixture()
	incoming := directory.Members[0]
	incoming.HostNodeID = "desktop-host"
	repaired, changed, err := reconcileMemberIdentity(directory, incoming, map[string]bool{})
	if err != nil { t.Fatal(err) }
	if !changed || repaired.Group.Revision != directory.Group.Revision+1 ||
		repaired.Members[0].HostNodeID != "desktop-host" {
		t.Fatalf("host identity was not repaired: %#v", repaired)
	}
	unchanged, changed, err := reconcileMemberIdentity(repaired, incoming, map[string]bool{})
	if err != nil { t.Fatal(err) }
	if changed || unchanged.Group.Revision != repaired.Group.Revision {
		t.Fatal("an unchanged host identity created directory revision churn")
	}
	if directory.Members[0].HostNodeID != "" {
		t.Fatal("host identity repair mutated the previous directory snapshot")
	}
}

func TestMemberIdentityReconciliationMigratesEveryReference(t *testing.T) {
	directory := directoryFixture()
	unpublished := false
	directory.Members[0].HostNodeID = "desktop-host-old"
	directory.Members[0].Published = &unpublished
	directory.Group.OwnerNodeID = "desktop"
	directory.Group.DNSNodeID = "desktop"
	directory.Group.Transfer = &ownershipTransfer{
		ID: "handover", FromNodeID: "desktop", ToNodeID: "nas", Phase: "prepare",
	}
	directory.Group.Grants = []networkGrant{
		{DeviceNodeID: "desktop-host-old", AppNodeID: "nas"},
		{DeviceNodeID: "desktop-host-new", AppNodeID: "nas"},
		{DeviceNodeID: "other-host", AppNodeID: "desktop"},
	}
	incoming := networkMember{
		NodeID: "desktop-new", HostNodeID: "desktop-host-new", Label: "desktop",
		Addresses: []string{"100.80.0.3"}, KeyFingerprint: directory.Members[0].KeyFingerprint,
	}

	reconciled, changed, err := reconcileMemberIdentity(directory, incoming, map[string]bool{"desktop": false})
	if err != nil { t.Fatal(err) }
	if !changed || reconciled.Group.Revision != directory.Group.Revision+1 {
		t.Fatalf("identity rotation did not create one directory revision: %#v", reconciled)
	}
	if reconciled.Group.OwnerNodeID != "desktop-new" || reconciled.Group.DNSNodeID != "desktop-new" ||
		reconciled.Group.Transfer == nil || reconciled.Group.Transfer.FromNodeID != "desktop-new" {
		t.Fatalf("directory references retained the old app identity: %#v", reconciled.Group)
	}
	if len(reconciled.Group.Grants) != 2 ||
		reconciled.Group.Grants[0] != (networkGrant{DeviceNodeID: "desktop-host-new", AppNodeID: "nas"}) ||
		reconciled.Group.Grants[1] != (networkGrant{DeviceNodeID: "other-host", AppNodeID: "desktop-new"}) {
		t.Fatalf("grants were not migrated and deduplicated: %#v", reconciled.Group.Grants)
	}
	if reconciled.Members[0].NodeID != "desktop-new" || reconciled.Members[0].HostNodeID != "desktop-host-new" ||
		reconciled.Members[0].Published == nil || *reconciled.Members[0].Published {
		t.Fatalf("member state was not preserved across rotation: %#v", reconciled.Members[0])
	}
	if directory.Members[0].NodeID != "desktop" || directory.Group.OwnerNodeID != "desktop" ||
		directory.Group.Grants[0].DeviceNodeID != "desktop-host-old" {
		t.Fatal("identity reconciliation mutated the previous directory snapshot")
	}

	again, changed, err := reconcileMemberIdentity(reconciled, incoming, map[string]bool{})
	if err != nil { t.Fatal(err) }
	if changed || again.Group.Revision != reconciled.Group.Revision {
		t.Fatal("an unchanged identity created directory revision churn")
	}
}

func TestMemberIdentityReconciliationRejectsUnsafeRebinds(t *testing.T) {
	for _, test := range []struct {
		name string
		mutate func(*networkDirectory, *networkMember, map[string]bool)
	}{
		{name: "old node online", mutate: func(_ *networkDirectory, _ *networkMember, online map[string]bool) {
			online["desktop"] = true
		}},
		{name: "different key", mutate: func(_ *networkDirectory, incoming *networkMember, _ map[string]bool) {
			incoming.KeyFingerprint = strings.Repeat("c", 64)
		}},
		{name: "pending rename", mutate: func(directory *networkDirectory, _ *networkMember, _ map[string]bool) {
			directory.Members[0].Rename = &networkRename{From: "desktop", To: "desk"}
		}},
		{name: "new node collision", mutate: func(directory *networkDirectory, incoming *networkMember, _ map[string]bool) {
			incoming.NodeID = directory.Members[1].NodeID
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := directoryFixture()
			incoming := networkMember{
				NodeID: "desktop-new", HostNodeID: "desktop-host-new", Label: "desktop",
				Addresses: []string{"100.80.0.3"}, KeyFingerprint: directory.Members[0].KeyFingerprint,
			}
			online := map[string]bool{}
			test.mutate(&directory, &incoming, online)
			if _, _, err := reconcileMemberIdentity(directory, incoming, online); err == nil {
				t.Fatal("unsafe identity rebind was accepted")
			}
		})
	}
}

func TestMemberIdentityRefreshPreservesPublicationAndMigratesHostGrant(t *testing.T) {
	directory := directoryFixture()
	unpublished := false
	directory.Members[0].HostNodeID = "host-old"
	directory.Members[0].Published = &unpublished
	directory.Group.Grants = []networkGrant{{DeviceNodeID: "host-old", AppNodeID: "nas"}}
	incoming := directory.Members[0]
	incoming.HostNodeID = "host-new"
	incoming.Published = nil

	refreshed, changed, err := reconcileMemberIdentity(directory, incoming, map[string]bool{})
	if err != nil { t.Fatal(err) }
	if !changed || refreshed.Members[0].Published == nil || *refreshed.Members[0].Published ||
		refreshed.Group.Grants[0].DeviceNodeID != "host-new" {
		t.Fatalf("ordinary refresh lost durable member state: %#v", refreshed)
	}
}
