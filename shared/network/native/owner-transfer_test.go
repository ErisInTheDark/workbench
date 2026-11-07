// No exports. Protect single-owner handover ordering, independent DNS selection, and every app following the new owner under unchanged trust.
package main

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
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

func TestHandoverMovesEveryAppToTheNewOwnerWithoutNewTrust(t *testing.T) {
	ctx := context.Background()
	ca, err := createAuthority(time.Now())
	if err != nil { t.Fatal(err) }
	root := string(publicCertificatePEM(ca.certificate))
	desktop := newHandoverApp(t, "desktop", "100.80.0.1", root)
	nas := newHandoverApp(t, "nas", "100.80.0.2", root)
	laptop := newHandoverApp(t, "laptop", "100.80.0.3", root)
	directory := networkDirectory{
		Group: networkGroup{ID: "network", Revision: 1, OwnerNodeID: "desktop", DNSNodeID: "laptop", Access: "all", Grants: []networkGrant{}},
		Members: []networkMember{desktop.member, nas.member, laptop.member},
	}
	for _, app := range []*handoverApp{desktop, nas, laptop} { app.join(directory, desktop.member) }
	material, err := ca.marshal()
	if err != nil { t.Fatal(err) }
	if err := writePrivateFile(filepath.Join(desktop.node.directory, "authority.pem"), material); err != nil { t.Fatal(err) }
	before, err := signDirectory(directory, ca)
	if err != nil { t.Fatal(err) }

	id := "5d0c3a8e-6f0b-4f7e-9a51-2b7c1f0e9d44"
	prepared, err := nextOwnershipDirectory(directory, id, "nas", "prepare")
	if err != nil { t.Fatal(err) }
	if err := desktop.group.store(ctx, prepared); err != nil { t.Fatal(err) }
	envelope, err := signDirectory(prepared, ca)
	if err != nil { t.Fatal(err) }
	if _, err := nas.group.acceptTransfer(ctx, "desktop", "prepare", transferRequest{Envelope: envelope, Authority: material}); err != nil { t.Fatal(err) }
	relinquished, err := nextOwnershipDirectory(prepared, id, "nas", "relinquished")
	if err != nil { t.Fatal(err) }
	if err := desktop.group.store(ctx, relinquished); err != nil { t.Fatal(err) }
	envelope, err = signDirectory(relinquished, ca)
	if err != nil { t.Fatal(err) }
	activated, err := nas.group.acceptTransfer(ctx, "desktop", "activate", transferRequest{Envelope: envelope})
	if err != nil { t.Fatal(err) }
	if err := desktop.group.store(ctx, activated.Directory); err != nil { t.Fatal(err) }
	if err := removePrivateFile(filepath.Join(desktop.node.directory, "authority.pem")); err != nil { t.Fatal(err) }

	if activated.verify(root, "desktop") == nil { t.Fatal("the former owner could publish the new owner's directory") }
	if err := activated.verify(root, "nas"); err != nil { t.Fatal("bystander rejected the new owner's publication", err) }
	if err := laptop.group.store(ctx, activated.Directory); err != nil { t.Fatal(err) }
	if err := before.verify(root, "desktop"); err != nil { t.Fatal(err) }
	if laptop.group.store(ctx, before.Directory) == nil { t.Fatal("a late pre-handover push rewound the bystander to the former owner") }

	for _, app := range []*handoverApp{desktop, nas, laptop} {
		settings := app.configuration.PrivateAccess
		if app == nas {
			if settings.Role != "authority" || settings.Issuer != nil || !app.group.isOwner() { t.Fatal("new owner did not take authority") }
		} else if settings.Role != "member" || settings.Issuer == nil || settings.Issuer.Address != nas.member.Addresses[0] ||
			settings.Issuer.Hostname != "nas.wb.inthedark.boo" || app.group.isOwner() {
			t.Fatalf("%s still renews from or acts as the former owner", app.member.Label)
		}
		if app.configuration.Group.DNSNodeID != "laptop" || app.configuration.Group.OwnerNodeID != "nas" { t.Fatalf("%s holds the wrong owner or DNS app", app.member.Label) }
	}
	if _, err := os.Stat(filepath.Join(desktop.node.directory, "authority.pem")); !errors.Is(err, os.ErrNotExist) { t.Fatal("former owner kept the signing key") }

	signer, err := loadAuthority(nas.node.directory)
	if err != nil { t.Fatal(err) }
	leaf, err := signer.issue(laptop.csr, "laptop.wb.inthedark.boo", time.Now())
	if err != nil { t.Fatal(err) }
	certificate, err := x509.ParseCertificate(leaf)
	if err != nil { t.Fatal(err) }
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(root)) { t.Fatal("original root could not be pinned") }
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, DNSName: "laptop.wb.inthedark.boo"}); err != nil {
		t.Fatal("renewal from the new owner needs new device trust", err)
	}
}

type handoverApp struct {
	node          *privateNetwork
	group         *networkGroupController
	member        networkMember
	csr           []byte
	configuration networkConfiguration
}

func newHandoverApp(t *testing.T, label, address, root string) *handoverApp {
	t.Helper()
	node := &privateNetwork{directory: t.TempDir(), refresh: make(chan struct{}, 1), publish: func(privateStatus) {}}
	_, csr, err := persistentLeafRequest(node.directory, label+".wb.inthedark.boo")
	if err != nil { t.Fatal(err) }
	member, err := memberFromRequest(label, label, []string{address}, csr)
	if err != nil { t.Fatal(fmt.Errorf("%s identity: %w", label, err)) }
	node.status = privateStatus{NodeID: &member.NodeID, Addresses: member.Addresses, KeyFingerprint: &member.KeyFingerprint, RootCertificate: &root}
	app := &handoverApp{node: node, member: member, csr: csr}
	app.group = &networkGroupController{node: node, read: func() networkConfiguration { return app.configuration },
		persist: func(_ context.Context, previous *uint64, next networkConfiguration) error {
			if previous == nil || *previous != app.configuration.Group.Revision { return errors.New("stale revision") }
			app.configuration = next
			return nil
		}}
	node.group = app.group
	return app
}

func (app *handoverApp) join(directory networkDirectory, owner networkMember) {
	settings := privateConfiguration{Role: "member", Label: app.member.Label, Enabled: true,
		Issuer: &issuerAddress{Address: owner.Addresses[0], Hostname: owner.Label + ".wb.inthedark.boo"}}
	if owner.NodeID == app.member.NodeID { settings.Role, settings.Issuer = "authority", nil }
	app.node.settings.Store(&settings)
	app.configuration = networkConfiguration{Mode: "tailnet-service", PrivateAccess: &settings, Group: &directory.Group, Members: directory.Members}
}
