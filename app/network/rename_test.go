// No exports. Protect rename authority, trust continuity, activation ordering and retry-safe retirement.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"

	"github.com/miekg/dns"
)

type renameFixture struct {
	authority *networkAuthority
	members []networkMember
	dns map[string][]string
	failPersistence bool
	failDNS bool
}

func newRenameFixture(t *testing.T) *renameFixture {
	t.Helper()
	nodeID := "authority-node"
	node := &privateNetwork{
		directory: t.TempDir(), refresh: make(chan struct{}, 1), publish: func(privateStatus) {},
		status: privateStatus{NodeID: &nodeID, Addresses: []string{"100.80.0.1"}},
	}
	node.settings.Store(&privateConfiguration{Role: "unconfigured", Label: "desktop", NodeLabel: "original"})
	node.presentation.Store(&privatePresentation{hostname: "desktop.wb.inthedark.boo", names: []string{"desktop.wb.inthedark.boo"}})
	fixture := &renameFixture{dns: make(map[string][]string)}
	fixture.authority = &networkAuthority{
		node: node, members: func() []networkMember { return fixture.members },
		persist: func(_ context.Context, previous *networkMember, member networkMember) error {
			if fixture.failPersistence { return errors.New("injected persistence failure") }
			for index, current := range fixture.members {
				if current.NodeID == member.NodeID {
					if !sameMember(&current, previous) { return errors.New("stale member write") }
					fixture.members[index] = member
					return nil
				}
			}
			return errors.New("unexpected new member")
		},
		dnsClient: func(credentials dnsCredentials) *tailscaleDNS {
			return &tailscaleDNS{credentials: credentials, baseURL: "https://api.test", client: &http.Client{
				Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					if strings.HasSuffix(request.URL.Path, "/token") { return testHTTPResponse(200, `{"access_token":"token"}`), nil }
					if request.Method == http.MethodPatch {
						if fixture.failDNS { return testHTTPResponse(503, `{}`), nil }
						var patch map[string][]string
						if err := json.NewDecoder(request.Body).Decode(&patch); err != nil { return nil, err }
						for name, addresses := range patch {
							if addresses == nil { delete(fixture.dns, name) } else { fixture.dns[name] = addresses }
						}
						return testHTTPResponse(200, `{}`), nil
					}
					body, err := json.Marshal(fixture.dns)
					return testHTTPResponse(200, string(body)), err
				}),
			}}
		},
	}
	result, err := fixture.authority.create(context.Background(), dnsCredentials{ClientID: "id", ClientSecret: "secret"})
	if err != nil { t.Fatal(err) }
	fixture.members = *result.Members
	result.PrivateAccess.Enabled = true
	node.settings.Store(result.PrivateAccess)
	return fixture
}

func TestRenameRetainsOldAccessUntilActivationAndKeepsAuthorityRenewalTrust(t *testing.T) {
	fixture := newRenameFixture(t)
	authority, node := fixture.authority, fixture.authority.node
	rename := networkRename{ID: "ffecbbf7-697b-42cf-ae46-dbcfe74a126d", From: "desktop", To: "desk"}
	root := *node.snapshot().RootFingerprint
	key := fixture.members[0].KeyFingerprint
	if err := authority.rename(context.Background(), "rename-prepare", rename); err != nil { t.Fatal(err) }
	if node.hostname() != "desktop.wb.inthedark.boo" || fixture.members[0].Rename == nil ||
		fixture.dns["desktop.wb.inthedark.boo"] == nil || fixture.dns["desk.wb.inthedark.boo"] == nil {
		t.Fatal("preparation did not reserve the new name while retaining old access")
	}
	for index := 0; index < 2; index++ {
		if err := authority.rename(context.Background(), "rename-activate", rename); err != nil { t.Fatal(err) }
	}
	if node.hostname() != "desk.wb.inthedark.boo" { t.Fatal("activation retained the old public URL") }
	for _, name := range []string{"desktop.wb.inthedark.boo", "desk.wb.inthedark.boo", "original.wb.inthedark.boo"} {
		if err := node.certificate().Leaf.VerifyHostname(name); err != nil { t.Fatal(err) }
	}
	for index := 0; index < 2; index++ {
		if err := authority.rename(context.Background(), "rename-retire", rename); err != nil { t.Fatal(err) }
	}
	if fixture.members[0].Label != "desk" || fixture.members[0].Rename != nil ||
		fixture.dns["desktop.wb.inthedark.boo"] != nil || fixture.dns["desk.wb.inthedark.boo"] == nil {
		t.Fatal("retirement did not commit membership and remove only the old registration")
	}
	query := new(dns.Msg).SetQuestion("desktop.wb.inthedark.boo.", dns.TypeA)
	presentation := node.presentation.Load()
	answer := dnsAnswer(presentation.hostname, []netip.Addr{netip.MustParseAddr("100.80.0.1")}, query, presentation.names...)
	if answer.Rcode != dns.RcodeRefused { t.Fatal("retired public name still resolves privately") }
	settings := *node.settings.Load()
	settings.Label = "desk"
	node.configure(settings)
	if err := authority.renew(context.Background()); err != nil { t.Fatal(err) }
	if *node.snapshot().RootFingerprint != root || fixture.members[0].KeyFingerprint != key {
		t.Fatal("URL rename replaced trust or installation key")
	}
	if err := node.certificate().Leaf.VerifyHostname("original.wb.inthedark.boo"); err != nil { t.Fatal(err) }
	code, err := authority.pairingCode()
	if err != nil { t.Fatal(err) }
	parsed, err := parsePairingCode(code.Code)
	if err != nil || parsed.Issuer.Hostname != "original.wb.inthedark.boo" {
		t.Fatal("pairing no longer uses the stable authority control identity")
	}
}

func TestRenameReopensPersistedCertificateAtEveryPhase(t *testing.T) {
	fixture := newRenameFixture(t)
	authority := fixture.authority
	rename := networkRename{ID: "ffecbbf7-697b-42cf-ae46-dbcfe74a126d", From: "desktop", To: "desk"}
	root := *authority.node.snapshot().RootFingerprint
	key := fixture.members[0].KeyFingerprint
	for _, phase := range []string{"prepare", "activate", "retire"} {
		previous := authority.node
		settings := *previous.settings.Load()
		journal := rename
		journal.Phase = phase
		settings.rename = &journal
		if phase == "retire" {
			settings.Label = rename.To
		}
		node, err := newPrivateNetwork(context.Background(), previous.directory, settings, 52739, &networkTargets{}, func(privateStatus) {})
		if err != nil { t.Fatal(err) }
		t.Cleanup(node.cancel)
		certificate, err := tls.LoadX509KeyPair(filepath.Join(node.directory, "leaf.pem"), filepath.Join(node.directory, "leaf-key.pem"))
		if err != nil { t.Fatal(err) }
		if err := node.installCertificate(&certificate); err != nil { t.Fatal(err) }
		node.status.NodeID = previous.snapshot().NodeID
		node.status.Addresses = previous.snapshot().Addresses
		authority.node = node
		if err := authority.rename(context.Background(), "rename-"+phase, rename); err != nil { t.Fatal(err) }
		if *node.snapshot().RootFingerprint != root || fixture.members[0].KeyFingerprint != key {
			t.Fatal("reopening a rename replaced installation trust or key")
		}
	}
	if authority.node.hostname() != "desk.wb.inthedark.boo" || fixture.members[0].Rename != nil || len(fixture.dns) != 1 {
		t.Fatal("reopened rename did not finish its address and membership transition")
	}
}

func TestRenameRejectsDifferentNodeKeyAndReservedNamesBeforeDNSChanges(t *testing.T) {
	fixture := newRenameFixture(t)
	rename := networkRename{ID: "ffecbbf7-697b-42cf-ae46-dbcfe74a126d", From: "desktop", To: "desk"}
	node := fixture.authority.node
	_, request, err := persistentLeafRequest(node.directory, "desk.wb.inthedark.boo")
	if err != nil { t.Fatal(err) }
	for _, peer := range []string{"unapproved-node", "authority-node"} {
		proof := request
		if peer == "authority-node" {
			_, proof, err = createLeafRequest("desk.wb.inthedark.boo")
			if err != nil { t.Fatal(err) }
		}
		if _, err := fixture.authority.renameMember(context.Background(), "prepare", peer, node.snapshot().Addresses, proof, rename); err == nil {
			t.Fatal("rename admitted a different enrolled node or key")
		}
	}
	fixture.members = append(fixture.members, networkMember{NodeID: "other", Label: "laptop",
		Rename: &networkRename{ID: "407b28d1-ff69-4378-bea3-114b1b4b5f64", From: "laptop", To: "desk"}})
	if _, err := fixture.authority.renameMember(context.Background(), "prepare", "authority-node", node.snapshot().Addresses, request, rename); err == nil {
		t.Fatal("rename stole another member's reserved label")
	}
	if fixture.members[0].Rename != nil || len(fixture.dns) != 1 { t.Fatal("rejected rename mutated membership or DNS") }
}

func TestRenameRetriesPersistenceAndDNSFailuresWithoutStrandingOldAddress(t *testing.T) {
	fixture := newRenameFixture(t)
	rename := networkRename{ID: "ffecbbf7-697b-42cf-ae46-dbcfe74a126d", From: "desktop", To: "desk"}
	authority := fixture.authority
	fixture.failPersistence = true
	if err := authority.rename(context.Background(), "rename-prepare", rename); err == nil { t.Fatal("persistence failure was hidden") }
	if fixture.members[0].Rename != nil || len(fixture.dns) != 1 { t.Fatal("failed persistence changed registration") }
	fixture.failPersistence, fixture.failDNS = false, true
	if err := authority.rename(context.Background(), "rename-prepare", rename); err == nil { t.Fatal("DNS failure was hidden") }
	if fixture.members[0].Rename == nil || authority.node.hostname() != "desktop.wb.inthedark.boo" {
		t.Fatal("failed DNS lost the resumable reservation or old presentation")
	}
	fixture.failDNS = false
	if err := authority.rename(context.Background(), "rename-prepare", rename); err != nil { t.Fatal(err) }
	if err := authority.rename(context.Background(), "rename-activate", rename); err != nil { t.Fatal(err) }
	fixture.failPersistence = true
	if err := authority.rename(context.Background(), "rename-retire", rename); err == nil { t.Fatal("retirement falsely reported persistence success") }
	if authority.node.hostname() != "desk.wb.inthedark.boo" || fixture.members[0].Rename == nil {
		t.Fatal("failed retirement lost the activated address or pending reservation")
	}
	fixture.failPersistence = false
	if err := authority.rename(context.Background(), "rename-retire", rename); err != nil { t.Fatal(err) }
	if fixture.members[0].Label != "desk" || fixture.members[0].Rename != nil || len(fixture.dns) != 1 {
		t.Fatal("retirement retry did not settle the persisted address")
	}
}
