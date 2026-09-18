// No exports. Own validated app directory snapshots and their authority revisions.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const groupControlPort = "52740"

type networkCandidate struct {
	ID string `json:"id"`
	OwnerNodeID string `json:"ownerNodeId"`
	Label string `json:"label"`
}

type networkDevice struct {
	NodeID string `json:"nodeId"`
	Name string `json:"name"`
	Online bool `json:"online"`
}

type networkGroupController struct {
	node *privateNetwork
	authority *networkAuthority
	read func() networkConfiguration
	persist func(context.Context, *uint64, networkConfiguration) error
	hostNodeID func() string
	mu sync.Mutex
}

type groupAdvertisement struct {
	Directory *networkDirectory `json:"directory"`
}

type groupEnrolment struct {
	Label string `json:"label"`
	HostNodeID string `json:"hostNodeId,omitempty"`
	Request []byte `json:"request"`
}

type groupWelcome struct {
	Envelope directoryEnvelope `json:"envelope"`
	Certificate []byte `json:"certificate"`
}

func newGroupID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil { return "", err }
	id[6] = (id[6] & 15) | 64
	id[8] = (id[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16]), nil
}

func networkIDForRoot(root string) (string, error) {
	block, _ := pem.Decode([]byte(root))
	if block == nil { return "", errors.New("network root certificate is unavailable") }
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !certificate.IsCA { return "", errors.New("network root certificate is invalid") }
	hash := sha256.Sum256(certificate.Raw)
	hash[6] = (hash[6] & 15) | 80
	hash[8] = (hash[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", hash[0:4], hash[4:6], hash[6:8], hash[8:10], hash[10:16]), nil
}

func (group *networkGroupController) directory() *networkDirectory {
	configuration := group.read()
	if configuration.Group == nil { return nil }
	return &networkDirectory{Group: *configuration.Group, Members: configuration.Members}
}

func (group *networkGroupController) isOwner() bool {
	directory := group.directory()
	status := group.node.snapshot()
	return directory != nil && status.NodeID != nil && directory.Group.OwnerNodeID == *status.NodeID &&
		(directory.Group.Transfer == nil || directory.Group.Transfer.Phase != "relinquished")
}

func (group *networkGroupController) store(ctx context.Context, directory networkDirectory) error {
	if err := directory.validate(); err != nil { return err }
	current := group.read()
	var previous *uint64
	if current.Group != nil {
		if current.Group.ID != directory.Group.ID || current.Group.Revision >= directory.Group.Revision {
			return errors.New("directory update would replace or rewind the current network")
		}
		revision := current.Group.Revision
		previous = &revision
	}
	status := group.node.snapshot()
	if status.NodeID == nil || current.PrivateAccess == nil { return errors.New("app identity is not ready") }
	var self, owner *networkMember
	for _, member := range directory.Members {
		if member.NodeID == *status.NodeID { copy := member; self = &copy }
		if member.NodeID == directory.Group.OwnerNodeID { copy := member; owner = &copy }
	}
	if self == nil || owner == nil || status.KeyFingerprint == nil || self.KeyFingerprint != *status.KeyFingerprint {
		return errors.New("directory does not retain this app's enrolled identity and key")
	}
	settings := *current.PrivateAccess
	settings.Role, settings.Issuer = "member", &issuerAddress{Address: owner.Addresses[0], Hostname: owner.Label + ".wb.inthedark.boo"}
	if self.NodeID == owner.NodeID { settings.Role, settings.Issuer = "authority", nil }
	settings.Enabled = current.Mode == "tailnet-service"
	current.PrivateAccess, current.Group, current.Members = &settings, &directory.Group, directory.Members
	if err := group.persist(ctx, previous, current); err != nil { return err }
	committed := group.read()
	if committed.PrivateAccess == nil { return errors.New("committed app identity is unavailable") }
	group.node.configure(*committed.PrivateAccess)
	if group.node.access != nil {
		if err := group.node.access.apply(committed.Group); err != nil { return err }
	}
	return nil
}

func (group *networkGroupController) envelope() (directoryEnvelope, error) {
	if !group.isOwner() { return directoryEnvelope{}, errors.New("network owner is unavailable on this app") }
	ca, err := loadAuthority(group.node.directory)
	if err != nil { return directoryEnvelope{}, errors.New("network signing key is unavailable") }
	return signDirectory(*group.directory(), ca)
}

func (group *networkGroupController) request(ctx context.Context, member networkMember, path string, input, output interface{}) (result error) {
	if len(member.Addresses) == 0 { return errors.New("app address is unavailable") }
	address := net.JoinHostPort(member.Addresses[0], groupControlPort)
	peer, err := group.node.local.WhoIs(ctx, address)
	if err != nil || peer.Node == nil || string(peer.Node.StableID) != member.NodeID {
		return errors.New("app control address does not match its Tailscale identity")
	}
	body, err := json.Marshal(input)
	if err != nil { return errors.New("network control request could not be encoded") }
	transport := &http.Transport{DialContext: group.node.server.Dial}
	defer transport.CloseIdleConnections()
	method := http.MethodPost
	if input == nil { method = http.MethodGet }
	request, err := http.NewRequestWithContext(ctx, method, "http://"+address+path, bytes.NewReader(body))
	if err != nil { return err }
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil { return errors.New("network app control connection failed") }
	defer func() { result = errors.Join(result, response.Body.Close()) }()
	if response.StatusCode != http.StatusOK { return errors.New("network app declined the control request") }
	data, err := io.ReadAll(io.LimitReader(response.Body, 2_000_001))
	if err != nil || len(data) > 2_000_000 { return errors.New("network control response is invalid") }
	if output == nil { return nil }
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil { return errors.New("invalid network control response") }
	if err := decoder.Decode(new(interface{})); err != io.EOF { return errors.New("trailing network control response data") }
	return nil
}

func (group *networkGroupController) publish(ctx context.Context) error {
	return group.publishExcept(ctx, "")
}

func (group *networkGroupController) publishExcept(ctx context.Context, exclude string) error {
	var unacknowledged []string
	if directory := group.directory(); directory != nil {
		for _, member := range directory.Members {
			if member.NodeID != directory.Group.OwnerNodeID && member.NodeID != exclude {
				unacknowledged = append(unacknowledged, member.NodeID)
			}
		}
	}
	group.node.change(func(status *privateStatus) { status.PendingUpdates = unacknowledged })
	envelope, err := group.envelope()
	if err != nil { return err }
	status, err := group.node.local.Status(ctx)
	if err != nil { return errors.New("Tailscale app availability could not be checked") }
	online := make(map[string]bool)
	for _, peer := range status.Peer { online[string(peer.ID)] = peer.Online }
	var failures []error
	var pending []string
	for _, member := range envelope.Directory.Members {
		if member.NodeID == envelope.Directory.Group.OwnerNodeID || member.NodeID == exclude { continue }
		if !online[member.NodeID] {
			pending = append(pending, member.NodeID)
			failures = append(failures, fmt.Errorf("app %s is offline and has not acknowledged the network update", member.Label))
			continue
		}
		if err := group.request(ctx, member, "/directory", envelope, nil); err != nil {
			pending = append(pending, member.NodeID)
			failures = append(failures, fmt.Errorf("app %s has not acknowledged the network update", member.Label))
		}
	}
	group.node.change(func(status *privateStatus) { status.PendingUpdates = pending })
	return errors.Join(failures...)
}

func (group *networkGroupController) publishDNS(ctx context.Context) error {
	err := group.publish(ctx)
	if err == nil { return nil }
	group.authority.fail(err.Error())
	directory := group.directory()
	if directory != nil && directory.Group.DNSNodeID == directory.Group.OwnerNodeID { return nil }
	if directory == nil || slices.Contains(group.node.snapshot().PendingUpdates, directory.Group.DNSNodeID) { return err }
	return nil
}

func (group *networkGroupController) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	peer, err := group.node.local.WhoIs(request.Context(), request.RemoteAddr)
	if err != nil || peer.Node == nil || peer.Node.StableID == "" {
		http.Error(response, "Tailscale identity required.", http.StatusForbidden)
		return
	}
	peerID := string(peer.Node.StableID)
	if request.Method == http.MethodGet && request.URL.Path == "/directory" {
		group.respond(response, request, groupAdvertisement{Directory: group.directory()})
		return
	}
	if request.Method != http.MethodPost {
		http.Error(response, "Unsupported network control request.", http.StatusMethodNotAllowed)
		return
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, 2_000_001))
	if err != nil || len(data) > 2_000_000 {
		http.Error(response, "Invalid network control request.", http.StatusBadRequest)
		return
	}
	if request.URL.Path != "/directory" {
		group.mu.Lock()
		defer group.mu.Unlock()
	}
	switch request.URL.Path {
	case "/unpublish":
		if !group.isOwner() { http.Error(response, "Contact the current owner.", http.StatusConflict); return }
		var input certificateRequest
		if decodePipeValue(data, &input) != nil { http.Error(response, "Invalid address removal.", http.StatusBadRequest); return }
		if err := group.unpublish(request.Context(), peerID, input.Request); err != nil {
			group.authority.fail(err.Error())
			http.Error(response, "Address removal could not complete.", http.StatusConflict)
			return
		}
		group.respond(response, request, struct{}{})
	case "/sync":
		if !group.isOwner() { http.Error(response, "Contact the current owner.", http.StatusConflict); return }
		member := false
		for _, candidate := range group.directory().Members {
			if candidate.NodeID == peerID { member = true; break }
		}
		if !member { http.Error(response, "Enrolled app required.", http.StatusForbidden); return }
		if err := group.publish(request.Context()); err != nil { group.authority.fail(err.Error()) }
		pending := group.node.snapshot().PendingUpdates
		group.respond(response, request, struct { Pending []string `json:"pending"` }{Pending: pending})
	case "/transfer/prepare", "/transfer/activate":
		var input transferRequest
		if decodePipeValue(data, &input) != nil { http.Error(response, "Invalid ownership transfer.", http.StatusBadRequest); return }
		result, err := group.acceptTransfer(request.Context(), peerID, strings.TrimPrefix(request.URL.Path, "/transfer/"), input)
		if err != nil {
			group.authority.fail(err.Error())
			http.Error(response, "Ownership transfer has not completed.", http.StatusConflict)
			return
		}
		if request.URL.Path == "/transfer/activate" {
			// The initiating owner commits the reply itself, not a competing push.
			if err := group.publishExcept(request.Context(), peerID); err != nil { group.authority.fail(err.Error()) }
		}
		group.respond(response, request, result)
	case "/directory":
		var envelope directoryEnvelope
		root := group.node.snapshot().RootCertificate
		if root == nil || decodePipeValue(data, &envelope) != nil || envelope.verify(*root, peerID) != nil {
			http.Error(response, "Directory authority could not be verified.", http.StatusForbidden)
			return
		}
		current := group.directory()
		if current != nil && current.Group.ID == envelope.Directory.Group.ID && current.Group.Revision == envelope.Directory.Group.Revision {
			if group.node.access != nil {
				if err := group.node.access.apply(&current.Group); err != nil {
					group.authority.fail(err.Error())
					http.Error(response, "Committed access restrictions are still being applied.", http.StatusConflict)
					return
				}
			}
			group.respond(response, request, struct{}{})
			return
		}
		if err := group.store(request.Context(), envelope.Directory); err != nil {
			group.authority.fail(err.Error())
			http.Error(response, "Directory update could not be persisted.", http.StatusConflict)
			return
		}
		group.respond(response, request, struct{}{})
	case "/enrol":
		if !group.isOwner() { http.Error(response, "Contact the network owner.", http.StatusConflict); return }
		var input groupEnrolment
		if decodePipeValue(data, &input) != nil { http.Error(response, "Invalid enrolment.", http.StatusBadRequest); return }
		addresses := []string{}
		for _, prefix := range peer.Node.Addresses {
			if prefix.IsSingleIP() && tailnetAddress(prefix.Addr()) { addresses = append(addresses, prefix.Addr().String()) }
		}
		welcome, err := group.enrol(request.Context(), peerID, addresses, input)
		if err != nil {
			group.authority.fail(err.Error())
			http.Error(response, "App enrolment could not complete.", http.StatusConflict)
			return
		}
		group.respond(response, request, welcome)
	default:
		http.NotFound(response, request)
	}
}

func (group *networkGroupController) respond(response http.ResponseWriter, request *http.Request, value interface{}) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(response).Encode(value); err != nil && request.Context().Err() == nil {
		group.authority.fail("Network control acknowledgement could not be delivered.")
	}
}

func (group *networkGroupController) enrol(ctx context.Context, peerID string, addresses []string, input groupEnrolment) (groupWelcome, error) {
	member, err := memberFromRequest(peerID, input.Label, addresses, input.Request)
	if err != nil { return groupWelcome{}, err }
	member.HostNodeID = input.HostNodeID
	directory := *group.directory()
	if directory.Group.Transfer != nil && directory.Group.Transfer.Phase != "activated" {
		return groupWelcome{}, errors.New("finish ownership handover before enrolling an app")
	}
	for _, existing := range directory.Members {
		if existing.NodeID == member.NodeID && existing.Rename != nil {
			return groupWelcome{}, errors.New("finish the app's pending rename before refreshing enrolment")
		}
		if existing.NodeID == member.NodeID && existing.KeyFingerprint != member.KeyFingerprint {
			return groupWelcome{}, errors.New("enrolment cannot replace an app's registered key")
		}
	}
	members, err := replaceMember(directory.Members, member)
	if err != nil { return groupWelcome{}, err }
	ca, err := loadAuthority(group.node.directory)
	if err != nil { return groupWelcome{}, errors.New("network signing key is unavailable") }
	certificate, err := ca.issue(input.Request, input.Label+".wb.inthedark.boo", time.Now())
	if err != nil { return groupWelcome{}, err }
	directory.Group.Revision++
	directory.Members = members
	if err := group.store(ctx, directory); err != nil { return groupWelcome{}, err }
	envelope, err := signDirectory(directory, ca)
	if err != nil { return groupWelcome{}, err }
	return groupWelcome{Envelope: envelope, Certificate: certificate}, nil
}

func (group *networkGroupController) discover(ctx context.Context, selection ...string) (result error) {
	group.node.change(func(status *privateStatus) { status.Discovery, status.Networks = "searching", nil })
	defer func() {
		if result != nil { group.node.change(func(status *privateStatus) { status.Discovery = "failed" }) }
	}()
	status, err := group.node.local.Status(ctx)
	if err != nil { return errors.New("Tailscale app discovery is unavailable") }
	devices := make([]networkDevice, 0, len(status.Peer))
	for _, peer := range status.Peer {
		if peer.ID != "" { devices = append(devices, networkDevice{NodeID: string(peer.ID), Name: peer.HostName, Online: peer.Online}) }
	}
	if len(devices) > 4096 { return errors.New("Tailscale device directory exceeds its supported limit") }
	group.node.change(func(status *privateStatus) { status.Devices = devices })
	current := group.directory()
	if current != nil && group.isOwner() {
		group.mu.Lock()
		defer group.mu.Unlock()
		if !group.isOwner() { return errors.New("network ownership changed during discovery; reconnect to its current owner") }
		group.node.change(func(status *privateStatus) { status.Discovery = "joined" })
		return group.publish(ctx)
	}
	owners := make(map[string]networkMember)
	revisions := make(map[string]uint64)
	var unavailable []string
	for _, peer := range status.Peer {
		if !strings.HasPrefix(peer.HostName, "wb-") || peer.ID == "" || len(peer.TailscaleIPs) == 0 { continue }
		if !peer.Online { unavailable = append(unavailable, peer.HostName); continue }
		candidate := networkMember{NodeID: string(peer.ID)}
		for _, address := range peer.TailscaleIPs { candidate.Addresses = append(candidate.Addresses, address.String()) }
		var advertised groupAdvertisement
		if err := group.request(ctx, candidate, "/directory", nil, &advertised); err != nil {
			unavailable = append(unavailable, peer.HostName)
			continue
		}
		if advertised.Directory == nil { continue }
		directory := advertised.Directory
		if directory.validate() != nil { return errors.New("discovered app supplied an invalid network directory") }
		if current != nil && directory.Group.ID != current.Group.ID { continue }
		if revisions[directory.Group.ID] >= directory.Group.Revision { continue }
		for _, member := range directory.Members {
			if member.NodeID == directory.Group.OwnerNodeID {
				owners[directory.Group.ID] = member
				revisions[directory.Group.ID] = directory.Group.Revision
			}
		}
	}
	if len(selection) > 0 && selection[0] != "" {
		selected, ok := owners[selection[0]]
		if !ok { return errors.New("selected Workbench network is no longer available") }
		owners = map[string]networkMember{selection[0]: selected}
	}
	if len(owners) > 1 {
		candidates := make([]networkCandidate, 0, len(owners))
		for id, member := range owners { candidates = append(candidates, networkCandidate{ID: id, OwnerNodeID: member.NodeID, Label: member.Label}) }
		group.node.change(func(status *privateStatus) { status.Discovery, status.Networks = "conflict", candidates })
		return nil
	}
	if len(owners) == 0 {
		if current != nil || group.node.snapshot().RootCertificate != nil { return errors.New("this app's Workbench network is unavailable; reconnect its owner rather than creating a different network") }
		group.node.change(func(status *privateStatus) {
			message := "No existing Workbench network found. Create the first network on this app."
			if len(unavailable) > 0 {
				message = "Some Workbench apps could not be reached. Reconnect an existing owner to join its network. Create here only if you want a separate network with its own certificate trust."
			}
			status.Message, status.Discovery = &message, "none"
		})
		return nil
	}
	var owner networkMember
	for _, candidate := range owners { owner = candidate }
	hostname := group.node.hostname()
	key, csr, err := persistentLeafRequest(group.node.directory, hostname)
	if err != nil { return err }
	hostNodeID := ""
	if group.hostNodeID != nil { hostNodeID = group.hostNodeID() }
	var welcome groupWelcome
	if err := group.request(ctx, owner, "/enrol", groupEnrolment{
		Label: group.node.settings.Load().Label, HostNodeID: hostNodeID, Request: csr,
	}, &welcome); err != nil { return err }
	if err := group.acceptEnrolment(ctx, owner.NodeID, hostname, key, welcome); err != nil { return err }
	var publication struct { Pending []string `json:"pending"` }
	if err := group.request(ctx, owner, "/sync", struct{}{}, &publication); err != nil { return err }
	group.node.change(func(status *privateStatus) { status.PendingUpdates = publication.Pending })
	if slices.Contains(publication.Pending, welcome.Envelope.Directory.Group.DNSNodeID) {
		return errors.New("the selected DNS app has not received this address; reconnect it and retry")
	}
	group.node.change(func(status *privateStatus) { status.Discovery, status.Networks, status.Message = "joined", nil, nil })
	return nil
}

func (group *networkGroupController) acceptEnrolment(ctx context.Context, ownerID, hostname string, key *ecdsa.PrivateKey, welcome groupWelcome) error {
	// Match rename's lock order. Never hold either lock across a peer request:
	// that peer may be handing ownership back to this app at the same time.
	group.node.certificates.Lock()
	defer group.node.certificates.Unlock()
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.node.hostname() != hostname || group.node.settings.Load().rename != nil {
		return errors.New("app address changed during enrolment; finish its rename and reconnect")
	}
	root := ""
	if pinned := group.node.snapshot().RootCertificate; pinned != nil { root = *pinned }
	if err := welcome.Envelope.verify(root, ownerID); err != nil { return err }
	if current := group.directory(); current != nil && welcome.Envelope.Directory.Group.ID != current.Group.ID {
		return errors.New("discovery would replace this app's network")
	}
	if err := group.store(ctx, welcome.Envelope.Directory); err != nil { return err }
	leaf, err := saveLeaf(group.node.directory, key, welcome.Certificate, []byte(welcome.Envelope.Root), hostname)
	if err != nil { return err }
	return group.node.installCertificate(leaf)
}

func (group *networkGroupController) reconnect(ctx context.Context) error {
	current := group.directory()
	self := group.node.snapshot().NodeID
	if current != nil && self != nil && current.Group.Transfer != nil {
		transfer := current.Group.Transfer
		if transfer.FromNodeID == *self && transfer.Phase != "activated" {
			return group.transferOwner(ctx, transfer.ToNodeID)
		}
		if transfer.FromNodeID == *self && transfer.Phase == "activated" {
			if err := removePrivateFile(filepath.Join(group.node.directory, "authority.pem")); err != nil { return err }
		}
	}
	return group.discover(ctx)
}
func (group *networkGroupController) initialise(ctx context.Context) error {
	group.mu.Lock()
	defer group.mu.Unlock()
	if group.directory() != nil { return nil }
	settings := group.node.settings.Load()
	if settings.Role != "authority" { return errors.New("create or join a network first") }
	status := group.node.snapshot()
	if status.NodeID == nil { return errors.New("Tailscale identity is unavailable") }
	configuration := group.read()
	members := slices.Clone(configuration.Members)
	for index := range members {
		if members[index].NodeID == *status.NodeID && group.hostNodeID != nil { members[index].HostNodeID = group.hostNodeID() }
	}
	if status.RootCertificate == nil { return errors.New("network trust is unavailable") }
	id, err := networkIDForRoot(*status.RootCertificate)
	if err != nil { return err }
	if err := group.store(ctx, networkDirectory{
		Group: networkGroup{ID: id, Revision: 1, OwnerNodeID: *status.NodeID, DNSNodeID: *status.NodeID, Access: "all", Grants: []networkGrant{}},
		Members: members,
	}); err != nil { return err }
	return removePrivateFile(filepath.Join(group.node.directory, "dns-credential.json"))
}

func (group *networkGroupController) change(ctx context.Context, dnsNodeID, access string, grants []networkGrant, expected ...uint64) error {
	group.mu.Lock()
	defer group.mu.Unlock()
	if !group.isOwner() { return errors.New("only the current network owner can change access or DNS hosting") }
	directory := *group.directory()
	if len(expected) > 0 && expected[0] != directory.Group.Revision {
		return errors.New("network settings changed; refresh the access draft")
	}
	directory.Group.Revision++
	if dnsNodeID != "" { directory.Group.DNSNodeID = dnsNodeID }
	if access != "" { directory.Group.Access, directory.Group.Grants = access, slices.Clone(grants) }
	if err := group.store(ctx, directory); err != nil { return err }
	return group.publish(ctx)
}

func (group *networkGroupController) unpublish(ctx context.Context, peerID string, csr []byte) error {
	directory := *group.directory()
	if directory.Group.DNSNodeID == peerID { return errors.New("choose another nameserver app before disabling this one") }
	members := slices.Clone(directory.Members)
	found := false
	for index, member := range members {
		if member.NodeID != peerID { continue }
		if _, err := authoriseCertificate(member, peerID, csr); err != nil { return err }
		if member.Rename != nil { return errors.New("complete the pending address change first") }
		published := false
		members[index].Published = &published
		found = true
	}
	if !found { return errors.New("app registration was not found") }
	directory.Members = members
	directory.Group.Revision++
	if err := group.store(ctx, directory); err != nil { return err }
	return group.publishDNS(ctx)
}

func (group *networkGroupController) removeRegistration(ctx context.Context) error {
	group.mu.Lock()
	defer group.mu.Unlock()
	directory := group.directory()
	self := group.node.snapshot().NodeID
	if directory == nil || self == nil { return errors.New("app registration is unavailable") }
	_, csr, err := persistentLeafRequest(group.node.directory, group.node.hostname())
	if err != nil { return err }
	if group.isOwner() { return group.unpublish(ctx, *self, csr) }
	for _, member := range directory.Members {
		if member.NodeID == directory.Group.OwnerNodeID {
			return group.request(ctx, member, "/unpublish", certificateRequest{Label: group.node.settings.Load().Label, Request: csr}, nil)
		}
	}
	return errors.New("network owner is unavailable")
}

type directoryEnvelope struct {
	Directory networkDirectory `json:"directory"`
	Root string `json:"root"`
	Signature []byte `json:"signature"`
}

func signDirectory(directory networkDirectory, ca *certificateAuthority) (directoryEnvelope, error) {
	if err := directory.validate(); err != nil { return directoryEnvelope{}, err }
	body, err := json.Marshal(directory)
	if err != nil { return directoryEnvelope{}, errors.New("directory could not be encoded") }
	hash := sha256.Sum256(append([]byte("workbench-network-directory-v1\x00"), body...))
	signature, err := ecdsa.SignASN1(rand.Reader, ca.key, hash[:])
	if err != nil { return directoryEnvelope{}, errors.New("directory could not be signed") }
	return directoryEnvelope{Directory: directory, Root: string(publicCertificatePEM(ca.certificate)), Signature: signature}, nil
}

func (envelope directoryEnvelope) verify(pinnedRoot, peerID string) error {
	if err := envelope.Directory.validate(); err != nil { return err }
	if peerID == "" || peerID != envelope.Directory.Group.OwnerNodeID {
		return errors.New("directory must come from its authenticated owner")
	}
	if pinnedRoot != "" && !sameAuthority(pinnedRoot, envelope.Root) {
		return errors.New("directory would replace the trusted network root")
	}
	block, _ := pem.Decode([]byte(envelope.Root))
	if block == nil { return errors.New("directory root is invalid") }
	root, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !root.IsCA { return errors.New("directory root is invalid") }
	key, ok := root.PublicKey.(*ecdsa.PublicKey)
	if !ok { return errors.New("directory root key is unsupported") }
	body, err := json.Marshal(envelope.Directory)
	if err != nil { return errors.New("directory could not be verified") }
	hash := sha256.Sum256(append([]byte("workbench-network-directory-v1\x00"), body...))
	if !ecdsa.VerifyASN1(key, hash[:], envelope.Signature) {
		return errors.New("directory signature is invalid")
	}
	return nil
}

type networkGrant struct {
	DeviceNodeID string `json:"deviceNodeId"`
	AppNodeID string `json:"appNodeId"`
}

type ownershipTransfer struct {
	ID string `json:"id"`
	FromNodeID string `json:"fromNodeId"`
	ToNodeID string `json:"toNodeId"`
	Phase string `json:"phase"`
}

type networkGroup struct {
	ID string `json:"id"`
	Revision uint64 `json:"revision"`
	OwnerNodeID string `json:"ownerNodeId"`
	DNSNodeID string `json:"dnsNodeId"`
	Access string `json:"access"`
	Grants []networkGrant `json:"grants"`
	Transfer *ownershipTransfer `json:"transfer,omitempty"`
}

type networkDirectory struct {
	Group networkGroup `json:"group"`
	Members []networkMember `json:"members"`
}

func (directory networkDirectory) validate() error {
	group := directory.Group
	if group.ID == "" || group.Revision == 0 || group.Revision > 9007199254740991 ||
		(group.Access != "all" && group.Access != "selected") ||
		len(directory.Members) == 0 || len(directory.Members) > 256 || len(group.Grants) > 4096 {
		return errors.New("invalid network directory")
	}
	ids, labels, addresses := map[string]bool{}, map[string]string{}, map[string]string{}
	for _, member := range directory.Members {
		if member.NodeID == "" || ids[member.NodeID] || len(member.KeyFingerprint) != 64 ||
			len(member.Addresses) == 0 || len(member.Addresses) > 2 {
			return errors.New("invalid app identity in network directory")
		}
		ids[member.NodeID] = true
		names := []string{member.Label}
		if member.Rename != nil {
			names = append(names, member.Rename.From, member.Rename.To)
		}
		for _, label := range names {
			if _, err := machineHostname(label); err != nil { return err }
			if previous := labels[label]; previous != "" && previous != member.NodeID {
				return errors.New("app address belongs to another directory member")
			}
			labels[label] = member.NodeID
		}
		for _, value := range member.Addresses {
			address, err := netip.ParseAddr(value)
			if err != nil || !tailnetAddress(address) {
				return errors.New("directory address is not a Tailscale address")
			}
			if previous := addresses[value]; previous != "" && previous != member.NodeID {
				return errors.New("directory address belongs to another app")
			}
			addresses[value] = member.NodeID
		}
	}
	if !ids[group.OwnerNodeID] || !ids[group.DNSNodeID] {
		return errors.New("network owner and DNS app must belong to the directory")
	}
	grants := map[networkGrant]bool{}
	for _, grant := range group.Grants {
		if grant.DeviceNodeID == "" || !ids[grant.AppNodeID] || grants[grant] {
			return errors.New("invalid or repeated device grant")
		}
		grants[grant] = true
	}
	if transfer := group.Transfer; transfer != nil {
		if transfer.ID == "" || !ids[transfer.FromNodeID] || !ids[transfer.ToNodeID] ||
			transfer.FromNodeID == transfer.ToNodeID {
			return errors.New("invalid ownership transfer target")
		}
		expectedOwner := transfer.FromNodeID
		switch transfer.Phase {
		case "prepare", "relinquished":
		case "activated": expectedOwner = transfer.ToNodeID
		default: return errors.New("invalid ownership transfer phase")
		}
		if group.OwnerNodeID != expectedOwner {
			return errors.New("ownership does not match its transfer phase")
		}
	}
	return nil
}
