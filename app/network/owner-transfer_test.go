// No exports. Protect single-owner handover ordering and independent DNS selection.
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPreparedOwnerCannotActivateBeforeDurableCommitAndCanResume(t *testing.T) {
	ca, err := createAuthority(time.Now())
	if err != nil { t.Fatal(err) }
	nodeID := "nas"
	node := &privateNetwork{
		directory: t.TempDir(), refresh: make(chan struct{}, 1), publish: func(privateStatus) {},
		status: privateStatus{NodeID: &nodeID, Addresses: []string{"100.80.0.2"}},
	}
	settings := privateConfiguration{Role: "member", Label: "nas", Enabled: true, Issuer: &issuerAddress{Address: "100.80.0.1", Hostname: "desktop.wb.inthedark.boo"}}
	node.settings.Store(&settings)
	node.presentation.Store(&privatePresentation{hostname: "nas.wb.inthedark.boo", names: []string{"nas.wb.inthedark.boo"}})
	key, csr, err := persistentLeafRequest(node.directory, node.hostname())
	if err != nil { t.Fatal(err) }
	member, err := memberFromRequest(nodeID, "nas", node.status.Addresses, csr)
	if err != nil { t.Fatal(err) }
	node.status.KeyFingerprint = &member.KeyFingerprint
	certificate, err := ca.issue(csr, node.hostname(), time.Now())
	if err != nil { t.Fatal(err) }
	leaf, err := saveLeaf(node.directory, key, certificate, publicCertificatePEM(ca.certificate), node.hostname())
	if err != nil { t.Fatal(err) }
	if err := node.installCertificate(leaf); err != nil { t.Fatal(err) }
	directory := directoryFixture()
	directory.Members[1] = member
	configuration := networkConfiguration{Mode: "tailnet-service", PrivateAccess: &settings, Group: &directory.Group, Members: directory.Members}
	failActivation := true
	group := &networkGroupController{node: node, read: func() networkConfiguration { return configuration },
		persist: func(_ context.Context, previous *uint64, next networkConfiguration) error {
			if previous == nil || *previous != configuration.Group.Revision { return errors.New("stale revision") }
			if failActivation && next.Group.Transfer.Phase == "activated" { return errors.New("injected activation persistence failure") }
			configuration = next
			return nil
		}}
	node.group = group
	id := "8158f10d-1d75-44a2-9f84-8a82660dbebe"
	prepared, err := nextOwnershipDirectory(directory, id, "nas", "prepare")
	if err != nil { t.Fatal(err) }
	envelope, err := signDirectory(prepared, ca)
	if err != nil { t.Fatal(err) }
	material, err := ca.marshal()
	if err != nil { t.Fatal(err) }
	if _, err := group.acceptTransfer(context.Background(), "desktop", "prepare", transferRequest{Envelope: envelope, Authority: material}); err != nil { t.Fatal(err) }
	if _, err := os.Stat(filepath.Join(node.directory, "authority.pem")); !errors.Is(err, os.ErrNotExist) { t.Fatal("preparation installed an active owner key") }
	if group.isOwner() { t.Fatal("prepared app gained owner authority") }
	relinquished, err := nextOwnershipDirectory(prepared, id, "nas", "relinquished")
	if err != nil { t.Fatal(err) }
	envelope, err = signDirectory(relinquished, ca)
	if err != nil { t.Fatal(err) }
	input := transferRequest{Envelope: envelope}
	if _, err := group.acceptTransfer(context.Background(), "desktop", "activate", input); err == nil { t.Fatal("activation persistence failure was hidden") }
	if group.isOwner() { t.Fatal("failed durable activation acquired owner authority") }
	failActivation = false
	activated, err := group.acceptTransfer(context.Background(), "desktop", "activate", input)
	if err != nil { t.Fatal(err) }
	if !group.isOwner() || activated.Directory.Group.DNSNodeID != directory.Group.DNSNodeID { t.Fatal("activation lost authority or moved DNS") }
	staged := filepath.Join(node.directory, "owner-transfer-"+id+".pem")
	if err := writePrivateFile(staged, material); err != nil { t.Fatal(err) }
	if _, err := group.acceptTransfer(context.Background(), "desktop", "activate", input); err != nil { t.Fatal("lost acknowledgement could not be retried", err) }
	if _, err := os.Stat(staged); !errors.Is(err, os.ErrNotExist) { t.Fatal("resumed activation retained the redundant staged signing key") }
	if !sameAuthority(activated.Root, string(publicCertificatePEM(ca.certificate))) { t.Fatal("handover replaced browser trust") }
}

func TestOwnershipTransferOrdering(t *testing.T) {
	directory := directoryFixture()
	if _, err := nextOwnershipDirectory(directory, "operation", "nas", "activated"); err == nil {
		t.Fatal("target became owner before durable relinquishment")
	}
	prepared, err := nextOwnershipDirectory(directory, "operation", "nas", "prepare")
	if err != nil { t.Fatal(err) }
	if prepared.Group.OwnerNodeID != "desktop" || prepared.Group.DNSNodeID != directory.Group.DNSNodeID { t.Fatal("preparation moved authority or DNS") }
	if _, err := nextOwnershipDirectory(prepared, "other", "nas", "relinquished"); err == nil { t.Fatal("another operation replaced a pending handover") }
	relinquished, err := nextOwnershipDirectory(prepared, "operation", "nas", "relinquished")
	if err != nil { t.Fatal(err) }
	activated, err := nextOwnershipDirectory(relinquished, "operation", "nas", "activated")
	if err != nil { t.Fatal(err) }
	if activated.Group.OwnerNodeID != "nas" || activated.Group.DNSNodeID != directory.Group.DNSNodeID { t.Fatal("handover did not preserve independent DNS selection") }
	if _, err := nextOwnershipDirectory(activated, "operation", "nas", "prepare"); err == nil { t.Fatal("completed handover restarted against its current owner") }
}
