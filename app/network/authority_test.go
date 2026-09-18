// No exports. Protect member identity, hostname and key binding before certificate issuance.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"testing"
)

func TestCertificateAuthorisationBindsMemberIdentityAndKey(t *testing.T) {
	_, request, err := createLeafRequest("desktop.wb.inthedark.boo")
	if err != nil {
		t.Fatal(err)
	}
	csr, err := x509.ParseCertificateRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	member := networkMember{NodeID: "node-a", Label: "desktop", KeyFingerprint: hex.EncodeToString(fingerprint[:])}
	if _, err := authoriseCertificate(member, "node-a", request); err != nil {
		t.Fatal(err)
	}
	if _, err := authoriseCertificate(member, "node-b", request); err == nil {
		t.Fatal("another tailnet node inherited member authority")
	}
	_, otherKey, err := createLeafRequest("desktop.wb.inthedark.boo")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authoriseCertificate(member, "node-a", otherKey); err == nil {
		t.Fatal("member silently replaced its approved key")
	}
	member.Label = "laptop"
	if _, err := authoriseCertificate(member, "node-a", request); err == nil {
		t.Fatal("member issued a certificate for another machine")
	}
}

func TestPairingCodeIsSingleUseAndApprovalBindsPendingIdentity(t *testing.T) {
	_, request, err := createLeafRequest("desktop.wb.inthedark.boo")
	if err != nil {
		t.Fatal(err)
	}
	csr, _ := x509.ParseCertificateRequest(request)
	fingerprint := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	member := networkMember{NodeID: "node-a", Label: "desktop", KeyFingerprint: hex.EncodeToString(fingerprint[:])}
	admission := &pairingAdmission{code: "single-use-code", pending: make(map[string]*pairingRequest)}
	pending := make(chan struct{}, 2)
	result := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		result <- admission.begin(ctx, "single-use-code", "request-a", member, request, func() { pending <- struct{}{} })
	}()
	select {
	case <-pending:
	case err := <-result:
		t.Fatalf("pairing never reached approval: %v", err)
	}
	if err := admission.begin(ctx, "single-use-code", "request-b", member, request, func() {}); err == nil {
		t.Fatal("single-use code admitted a second request")
	}
	impostor := member
	impostor.NodeID = "node-b"
	if err := admission.decide("request-a", &impostor); err == nil {
		t.Fatal("approval did not bind the pending identity")
	}
	if err := admission.decide("request-a", &member); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := admission.decide("request-a", &member); err == nil {
		t.Fatal("completed approval could be reused")
	}
}
