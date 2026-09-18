// No exports. Protect member identity, hostname and key binding before certificate issuance.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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

func TestAuthorityBackupRestoresTrustMembershipAndOwnedDNSWithoutOldNodeIdentity(t *testing.T) {
	directory := t.TempDir()
	ca, err := createAuthority(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	material, err := ca.marshal()
	if err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(filepath.Join(directory, "authority.pem"), material); err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(filepath.Join(directory, "dns-credential.json"), []byte(`{"clientId":"id","clientSecret":"secret"}`)); err != nil {
		t.Fatal(err)
	}
	old := networkMember{NodeID: "old-root", Label: "desktop", KeyFingerprint: strings.Repeat("a", 64), Addresses: []string{"100.80.0.1"}}
	peer := networkMember{NodeID: "peer", Label: "laptop", KeyFingerprint: strings.Repeat("b", 64), Addresses: []string{"100.80.0.3"}}
	peer.Rename = &networkRename{ID: "ffecbbf7-697b-42cf-ae46-dbcfe74a126d", From: "laptop", To: "portable"}
	backup, err := backupAuthority(directory, networkConfiguration{
		PrivateAccess: &privateConfiguration{Role: "authority", Label: "desktop"},
		Members:       []networkMember{old, peer},
	}, "long backup password")
	if err != nil {
		t.Fatal(err)
	}
	rootID := "replacement-root"
	node := &privateNetwork{
		directory: t.TempDir(), refresh: make(chan struct{}, 1),
		publish: func(privateStatus) {}, status: privateStatus{NodeID: &rootID, Addresses: []string{"100.80.0.2"}},
	}
	node.settings.Store(&privateConfiguration{Role: "unconfigured", Label: "desktop", NodeLabel: "original"})
	node.presentation.Store(&privatePresentation{hostname: "desktop.wb.inthedark.boo", names: []string{"desktop.wb.inthedark.boo"}})
	writes := 0
	authority := networkAuthority{
		node: node, members: func() []networkMember { return nil },
		dnsClient: func(credentials dnsCredentials) *tailscaleDNS {
			if credentials.ClientID != "id" || credentials.ClientSecret != "secret" {
				t.Fatal("recovery lost DNS credentials")
			}
			return &tailscaleDNS{baseURL: "https://api.test", credentials: credentials, client: &http.Client{
				Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					if strings.HasSuffix(request.URL.Path, "/token") {
						return testHTTPResponse(200, `{"access_token":"token"}`), nil
					}
					if request.Method == http.MethodPatch {
						writes++
						var patch map[string][]string
						if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
							t.Fatal(err)
						}
						if !reflect.DeepEqual(patch, map[string][]string{node.hostname(): {"100.80.0.2"}}) {
							t.Fatal("recovery rewrote unrelated DNS")
						}
						return testHTTPResponse(200, `{}`), nil
					}
					return testHTTPResponse(200, `{"desktop.wb.inthedark.boo":["100.80.0.1"]}`), nil
				}),
			}}
		},
	}
	if _, err := authority.restore(context.Background(), backup.Data, "incorrect password"); err == nil || writes != 0 {
		t.Fatal("invalid backup changed registration")
	}
	conflicting := peer
	conflicting.Rename = &networkRename{ID: peer.Rename.ID, From: "laptop", To: "desktop"}
	invalid, err := backupAuthority(directory, networkConfiguration{
		PrivateAccess: &privateConfiguration{Role: "authority", Label: "desktop"},
		Members: []networkMember{old, conflicting},
	}, "long backup password")
	if err != nil { t.Fatal(err) }
	if _, err := authority.restore(context.Background(), invalid.Data, "long backup password"); err == nil || writes != 0 {
		t.Fatal("recovery accepted conflicting reserved names or changed DNS before rejection")
	}
	result, err := authority.restore(context.Background(), backup.Data, "long backup password")
	if err != nil {
		t.Fatal(err)
	}
	if result.PrivateAccess.Role != "authority" || result.PrivateAccess.Enabled || writes != 1 {
		t.Fatal("recovery did not restore a disabled authority and its exact DNS entry")
	}
	if err := node.certificate().Leaf.VerifyHostname("original.wb.inthedark.boo"); err != nil {
		t.Fatal("authority certificate lost its stable control name", err)
	}
	members := *result.Members
	if len(members) != 2 || !reflect.DeepEqual(members[0], peer) || members[1].NodeID != rootID || members[1].KeyFingerprint == old.KeyFingerprint {
		t.Fatal("recovery lost members or reused the old installation identity/key")
	}
	recovered, err := loadAuthority(node.directory)
	if err != nil || !reflect.DeepEqual(recovered.certificate.Raw, ca.certificate.Raw) {
		t.Fatal("recovery replaced certificate trust")
	}
	other, err := createAuthority(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	otherMaterial, err := other.marshal()
	if err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(filepath.Join(node.directory, "authority.pem"), otherMaterial); err != nil {
		t.Fatal(err)
	}
	if _, err := authority.restore(context.Background(), backup.Data, "long backup password"); err == nil || writes != 1 {
		t.Fatal("recovery silently replaced an existing authority or mutated DNS before refusing")
	}
}
