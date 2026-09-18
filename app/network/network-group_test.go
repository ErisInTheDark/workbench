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
