// No exports. Own single-use pairing admission and identity/key-bound certificate authorisation.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type networkMember struct {
	NodeID         string   `json:"nodeId"`
	Label          string   `json:"label"`
	KeyFingerprint string   `json:"keyFingerprint"`
	Addresses      []string `json:"addresses"`
	Rename         *networkRename `json:"rename,omitempty"`
}

type pairingRequest struct {
	ID      string        `json:"id"`
	Member  networkMember `json:"member"`
	request []byte
	result  chan error
}

type pairingAdmission struct {
	mu      sync.Mutex
	code    string
	pending map[string]*pairingRequest
}

func (admission *pairingAdmission) begin(ctx context.Context, code, id string, member networkMember, request []byte, changed func()) error {
	if _, err := authoriseCertificate(member, member.NodeID, request); err != nil {
		return err
	}
	admission.mu.Lock()
	if admission.code == "" || subtle.ConstantTimeCompare([]byte(code), []byte(admission.code)) != 1 {
		admission.mu.Unlock()
		return errors.New("pairing code is invalid or already used")
	}
	if admission.pending == nil {
		admission.pending = make(map[string]*pairingRequest)
	}
	if id == "" || admission.pending[id] != nil || len(admission.pending) >= 4 {
		admission.mu.Unlock()
		return errors.New("pairing request cannot be admitted while other approvals are pending")
	}
	admission.code = ""
	pending := &pairingRequest{ID: id, Member: member, request: slices.Clone(request), result: make(chan error, 1)}
	admission.pending[id] = pending
	admission.mu.Unlock()
	changed()
	defer func() {
		admission.mu.Lock()
		if admission.pending[id] == pending {
			delete(admission.pending, id)
		}
		admission.mu.Unlock()
		changed()
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-pending.result:
		return err
	}
}

func (admission *pairingAdmission) decide(id string, approved *networkMember) error {
	admission.mu.Lock()
	defer admission.mu.Unlock()
	pending := admission.pending[id]
	if pending == nil {
		return errors.New("pairing request is no longer pending")
	}
	if approved == nil {
		pending.result <- errors.New("pairing was declined on the setup installation")
		delete(admission.pending, id)
		return nil
	}
	if approved.NodeID != pending.Member.NodeID || approved.Label != pending.Member.Label || approved.KeyFingerprint != pending.Member.KeyFingerprint || !slices.Equal(approved.Addresses, pending.Member.Addresses) {
		return errors.New("approval differs from the pending machine identity")
	}
	// The app persists this exact member before sending approval to the sidecar.
	pending.result <- nil
	delete(admission.pending, id)
	return nil
}

func (admission *pairingAdmission) newCode() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	admission.mu.Lock()
	defer admission.mu.Unlock()
	admission.code = hex.EncodeToString(value)
	return admission.code, nil
}

func (admission *pairingAdmission) snapshot() []pairingRequest {
	admission.mu.Lock()
	defer admission.mu.Unlock()
	result := make([]pairingRequest, 0, len(admission.pending))
	for _, request := range admission.pending {
		member := request.Member
		member.Addresses = slices.Clone(member.Addresses)
		result = append(result, pairingRequest{ID: request.ID, Member: member})
	}
	return result
}

func authoriseCertificate(member networkMember, nodeID string, request []byte) (*x509.CertificateRequest, error) {
	if nodeID == "" || member.NodeID != nodeID {
		return nil, errors.New("certificate request is not from the approved Tailscale node")
	}
	host, err := machineHostname(member.Label)
	if err != nil {
		return nil, err
	}
	csr, err := x509.ParseCertificateRequest(request)
	if err != nil || csr.CheckSignature() != nil {
		return nil, errors.New("certificate request signature is invalid")
	}
	fingerprint := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	if hex.EncodeToString(fingerprint[:]) != member.KeyFingerprint {
		return nil, errors.New("certificate request key differs from the approved key; pair this installation again")
	}
	if len(csr.DNSNames) != 1 || csr.DNSNames[0] != host || len(csr.IPAddresses) != 0 || len(csr.EmailAddresses) != 0 || len(csr.URIs) != 0 {
		return nil, errors.New("certificate request names differ from the approved machine")
	}
	return csr, nil
}

type privatePairingCode struct {
	Version int           `json:"version"`
	Issuer  issuerAddress `json:"issuer"`
	Root    string        `json:"root"`
	Token   string        `json:"token"`
}

type certificateRequest struct {
	Label   string `json:"label"`
	Request []byte `json:"request"`
	Code    string `json:"code,omitempty"`
	Rename *networkRename `json:"rename,omitempty"`
}

type certificateResponse struct {
	Certificate []byte `json:"certificate"`
}

type authorityRecovery struct {
	Version     int             `json:"version"`
	Authority   []byte          `json:"authority"`
	Credentials dnsCredentials  `json:"credentials"`
	Members     []networkMember `json:"members"`
	Owner       networkMember   `json:"owner"`
}

type networkAuthority struct {
	node      *privateNetwork
	members   func() []networkMember
	admission pairingAdmission
	dnsClient func(dnsCredentials) *tailscaleDNS
	persist func(context.Context, *networkMember, networkMember) error
	membership sync.Mutex
}

func (authority *networkAuthority) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if authority.node.settings.Load().Role != "authority" {
		http.Error(response, "This installation is not the setup authority.", http.StatusForbidden)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		http.Error(response, "POST required.", http.StatusMethodNotAllowed)
		return
	}
	peer, err := authority.node.local.WhoIs(request.Context(), request.RemoteAddr)
	if err != nil || peer.Node == nil || peer.Node.StableID == "" {
		http.Error(response, "Tailscale peer identity is required.", http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 32_769))
	if err != nil || len(body) > 32_768 {
		http.Error(response, "Invalid certificate request.", http.StatusBadRequest)
		return
	}
	var input certificateRequest
	if err := decodePipeValue(body, &input); err != nil {
		http.Error(response, "Invalid certificate request.", http.StatusBadRequest)
		return
	}
	addresses := []string{}
	for _, prefix := range peer.Node.Addresses {
		address := prefix.Addr()
		if prefix.IsSingleIP() && tailnetAddress(address) {
			addresses = append(addresses, address.String())
		}
	}
	if request.URL.Path == "/_workbench-network/rename-prepare" || request.URL.Path == "/_workbench-network/rename-retire" {
		if input.Rename == nil || input.Label != input.Rename.To {
			http.Error(response, "Invalid URL rename request.", http.StatusBadRequest)
			return
		}
		phase := "prepare"
		if request.URL.Path == "/_workbench-network/rename-retire" { phase = "retire" }
		result, err := authority.renameMember(request.Context(), phase, string(peer.Node.StableID), addresses, input.Request, *input.Rename)
		if err != nil {
			if request.Context().Err() == nil { authority.fail(err.Error()) }
			http.Error(response, "The URL rename could not complete; check the setup installation.", http.StatusConflict)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(result); err != nil && request.Context().Err() == nil {
			authority.fail("URL rename acknowledgement could not be delivered.")
		}
		return
	}
	member, err := memberFromRequest(string(peer.Node.StableID), input.Label, addresses, input.Request)
	if err != nil {
		http.Error(response, "Invalid machine identity or certificate key.", http.StatusBadRequest)
		return
	}
	if request.URL.Path == "/_workbench-network/pair" {
		for _, existing := range authority.members() {
			if existing.NodeID != member.NodeID && (existing.Label == member.Label ||
				(existing.Rename != nil && (existing.Rename.To == member.Label || existing.Rename.From == member.Label))) {
				http.Error(response, "Machine label already belongs to another installation.", http.StatusConflict)
				return
			}
		}
		idBytes := make([]byte, 16)
		if _, err := rand.Read(idBytes); err != nil {
			authority.fail("Pairing request identity could not be created.")
			http.Error(response, "Pairing could not start.", http.StatusInternalServerError)
			return
		}
		err = authority.admission.begin(request.Context(), input.Code, hex.EncodeToString(idBytes), member, input.Request, authority.publishPending)
		if err != nil {
			http.Error(response, "Pairing was cancelled, declined or used an invalid code.", http.StatusForbidden)
			return
		}
	} else if request.URL.Path != "/_workbench-network/renew" && request.URL.Path != "/_workbench-network/remove" {
		http.NotFound(response, request)
		return
	}
	authority.membership.Lock()
	defer authority.membership.Unlock()
	approved := false
	for _, existing := range authority.members() {
		if existing.Rename != nil && request.URL.Path != "/_workbench-network/renew" { continue }
		if _, err := authoriseCertificate(existing, member.NodeID, input.Request); err == nil {
			approved = true
			break
		}
	}
	if !approved {
		http.Error(response, "This machine and key are not authorised, or a URL rename is pending.", http.StatusForbidden)
		return
	}
	api, err := authority.dnsAPI()
	if err != nil {
		authority.fail(err.Error())
		http.Error(response, "Setup DNS credentials are unavailable.", http.StatusServiceUnavailable)
		return
	}
	host, err := machineHostname(member.Label)
	if err != nil {
		http.Error(response, "Invalid machine hostname.", http.StatusBadRequest)
		return
	}
	remove := request.URL.Path == "/_workbench-network/remove"
	if err := api.update(request.Context(), host, member.Addresses, remove); err != nil {
		authority.fail(err.Error())
		http.Error(response, "The setup installation could not update this DNS registration.", http.StatusServiceUnavailable)
		return
	}
	if remove {
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(certificateResponse{}); err != nil && request.Context().Err() == nil {
			authority.fail("Removal acknowledgement could not be delivered.")
		}
		return
	}
	ca, err := loadAuthority(authority.node.directory)
	if err != nil {
		authority.fail("Setup certificate authority could not be read.")
		http.Error(response, "The certificate authority is unavailable.", http.StatusServiceUnavailable)
		return
	}
	certificate, err := ca.issue(input.Request, host, time.Now())
	if err != nil {
		authority.fail(err.Error())
		http.Error(response, "The setup installation could not issue this certificate.", http.StatusServiceUnavailable)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(certificateResponse{Certificate: certificate}); err != nil && request.Context().Err() == nil {
		authority.fail("Issued certificate could not be delivered.")
	}
}

func (authority *networkAuthority) publishPending() {
	pending := authority.admission.snapshot()
	authority.node.change(func(status *privateStatus) { status.Pending = pending })
}

func (authority *networkAuthority) fail(message string) {
	if len(message) > 512 {
		message = message[:512]
	}
	authority.node.change(func(status *privateStatus) { status.Message = &message })
}

func (authority *networkAuthority) dnsAPI() (*tailscaleDNS, error) {
	api, err := loadDNSAPI(authority.node.directory)
	if err == nil && authority.dnsClient != nil {
		return authority.dnsClient(api.credentials), nil
	}
	return api, err
}

func loadDNSAPI(directory string) (*tailscaleDNS, error) {
	body, err := os.ReadFile(filepath.Join(directory, "dns-credential.json"))
	if err != nil {
		return nil, errors.New("setup DNS credential could not be read")
	}
	var credentials dnsCredentials
	if err := decodePipeValue(body, &credentials); err != nil || credentials.ClientID == "" || credentials.ClientSecret == "" {
		return nil, errors.New("setup DNS credential is invalid")
	}
	return &tailscaleDNS{credentials: credentials}, nil
}

func (authority *networkAuthority) create(ctx context.Context, credentials dnsCredentials) (actionResult, error) {
	authority.node.certificates.Lock()
	defer authority.node.certificates.Unlock()
	if authority.node.settings.Load().Role == "member" {
		return actionResult{}, errors.New("this installation already belongs to a setup; restore its authority backup to recover that setup")
	}
	ca, err := loadAuthority(authority.node.directory)
	if errors.Is(err, os.ErrNotExist) {
		ca, err = createAuthority(time.Now())
		if err == nil {
			var encoded []byte
			encoded, err = ca.marshal()
			if err == nil {
				err = writePrivateFile(filepath.Join(authority.node.directory, "authority.pem"), encoded)
			}
		}
	}
	if err != nil {
		return actionResult{}, errors.New("private certificate authority could not be prepared")
	}
	if credentials.ClientID == "" || credentials.ClientSecret == "" {
		return actionResult{}, errors.New("enter a DNS-scoped Tailscale client ID and secret")
	}
	encoded, err := json.Marshal(credentials)
	if err != nil {
		return actionResult{}, errors.New("DNS credential could not be encoded")
	}
	if err := writePrivateFile(filepath.Join(authority.node.directory, "dns-credential.json"), encoded); err != nil {
		return actionResult{}, errors.New("DNS credential could not be stored privately")
	}
	member, err := authority.issueOwn(ctx, ca)
	if err != nil {
		return actionResult{}, err
	}
	members, err := replaceMember(authority.members(), member)
	if err != nil {
		return actionResult{}, err
	}
	settings := *authority.node.settings.Load()
	settings.Role, settings.Issuer = "authority", nil
	return actionResult{Kind: "setup", PrivateAccess: &settings, Members: &members}, nil
}

func (authority *networkAuthority) issueOwn(ctx context.Context, ca *certificateAuthority, recovered ...networkMember) (networkMember, error) {
	status := authority.node.snapshot()
	if status.NodeID == nil {
		return networkMember{}, errors.New("complete Tailscale enrolment first")
	}
	key, request, err := persistentLeafRequest(authority.node.directory, authority.node.hostname())
	if err != nil {
		return networkMember{}, err
	}
	member, err := memberFromRequest(*status.NodeID, authority.node.settings.Load().Label, status.Addresses, request)
	if err != nil {
		return networkMember{}, err
	}
	certificate, err := ca.issue(request, authority.node.hostname(), time.Now(), authority.node.controlHostname())
	if err != nil {
		return networkMember{}, err
	}
	api, err := authority.dnsAPI()
	if err != nil {
		return networkMember{}, err
	}
	previous := status.Addresses
	for _, member := range recovered {
		if member.Label == authority.node.settings.Load().Label {
			previous = member.Addresses
		}
	}
	if err := api.replace(ctx, authority.node.hostname(), previous, status.Addresses, false); err != nil {
		return networkMember{}, err
	}
	leaf, err := saveLeaf(authority.node.directory, key, certificate, publicCertificatePEM(ca.certificate), authority.node.hostname())
	if err != nil {
		return networkMember{}, err
	}
	return member, authority.node.installCertificate(leaf)
}

func (authority *networkAuthority) pairingCode() (actionResult, error) {
	status := authority.node.snapshot()
	if authority.node.settings.Load().Role != "authority" || status.RootCertificate == nil || len(status.Addresses) == 0 {
		return actionResult{}, errors.New("finish creating the setup before inviting another installation")
	}
	token, err := authority.admission.newCode()
	if err != nil {
		return actionResult{}, err
	}
	code := privatePairingCode{
		Version: 1, Issuer: issuerAddress{Address: status.Addresses[0], Hostname: authority.node.controlHostname()},
		Root: *status.RootCertificate, Token: token,
	}
	encoded, err := json.Marshal(code)
	if err != nil {
		return actionResult{}, err
	}
	return actionResult{Kind: "pairing-code", Code: base64.RawURLEncoding.EncodeToString(encoded)}, nil
}

func parsePairingCode(value string) (privatePairingCode, error) {
	var code privatePairingCode
	if len(value) > 32_768 {
		return code, errors.New("pairing code exceeds its size limit")
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || decodePipeValue(data, &code) != nil || code.Version != 1 || len(code.Token) != 64 || !validMachineHostname(code.Issuer.Hostname) {
		return code, errors.New("invalid Workbench pairing code")
	}
	address, err := netip.ParseAddr(code.Issuer.Address)
	roots := x509.NewCertPool()
	if err != nil || !tailnetAddress(address) || !roots.AppendCertsFromPEM([]byte(code.Root)) {
		return code, errors.New("pairing code has an invalid Tailscale address or certificate authority")
	}
	return code, nil
}

func (authority *networkAuthority) join(ctx context.Context, value string) (actionResult, error) {
	authority.node.certificates.Lock()
	defer authority.node.certificates.Unlock()
	code, err := parsePairingCode(value)
	if err != nil {
		return actionResult{}, err
	}
	if authority.node.settings.Load().Role == "authority" {
		return actionResult{}, errors.New("a setup authority cannot join another setup")
	}
	if existing := authority.node.snapshot().RootCertificate; existing != nil && !sameAuthority(*existing, code.Root) {
		return actionResult{}, errors.New("pairing would replace this installation's trusted authority; use the original setup or its recovery backup")
	}
	existingCA, existingError := loadAuthority(authority.node.directory)
	if existingError == nil && !sameAuthority(string(publicCertificatePEM(existingCA.certificate)), code.Root) {
		return actionResult{}, errors.New("pairing would replace this installation's saved authority")
	}
	if existingError != nil && !errors.Is(existingError, os.ErrNotExist) {
		return actionResult{}, errors.New("saved authority could not be checked before pairing")
	}
	key, request, err := persistentLeafRequest(authority.node.directory, authority.node.hostname())
	if err != nil {
		return actionResult{}, err
	}
	input := certificateRequest{Label: authority.node.settings.Load().Label, Request: request, Code: code.Token}
	response, err := authority.requestIssuer(ctx, code.Issuer, code.Root, "/_workbench-network/pair", input)
	if err != nil {
		return actionResult{}, err
	}
	leaf, err := saveLeaf(authority.node.directory, key, response.Certificate, []byte(code.Root), authority.node.hostname())
	if err != nil {
		return actionResult{}, err
	}
	if err := authority.node.installCertificate(leaf); err != nil {
		return actionResult{}, err
	}
	settings := *authority.node.settings.Load()
	settings.Role, settings.Issuer = "member", &code.Issuer
	members := []networkMember{}
	return actionResult{Kind: "setup", PrivateAccess: &settings, Members: &members}, nil
}

func (authority *networkAuthority) renew(ctx context.Context) error {
	authority.node.certificates.Lock()
	defer authority.node.certificates.Unlock()
	settings := authority.node.settings.Load()
	if settings.rename != nil { return nil }
	if settings.Role == "authority" {
		ca, err := loadAuthority(authority.node.directory)
		if err != nil {
			return errors.New("setup certificate authority could not be read")
		}
		_, err = authority.issueOwn(ctx, ca)
		return err
	}
	status := authority.node.snapshot()
	if settings.Role != "member" || settings.Issuer == nil || status.RootCertificate == nil {
		return errors.New("private setup is incomplete")
	}
	key, request, err := persistentLeafRequest(authority.node.directory, authority.node.hostname())
	if err != nil {
		return err
	}
	response, err := authority.requestIssuer(ctx, *settings.Issuer, *status.RootCertificate, "/_workbench-network/renew", certificateRequest{Label: settings.Label, Request: request})
	if err != nil {
		return err
	}
	leaf, err := saveLeaf(authority.node.directory, key, response.Certificate, []byte(*status.RootCertificate), authority.node.hostname())
	if err != nil {
		return err
	}
	return authority.node.installCertificate(leaf)
}

func (authority *networkAuthority) requestIssuer(ctx context.Context, issuer issuerAddress, root, path string, input certificateRequest) (result certificateResponse, resultErr error) {
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(root)) {
		return result, errors.New("setup trust material is invalid")
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: issuer.Hostname},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return authority.node.server.Dial(ctx, network, net.JoinHostPort(issuer.Address, "443"))
		},
	}
	defer transport.CloseIdleConnections()
	body, err := json.Marshal(input)
	if err != nil {
		return result, errors.New("certificate request could not be encoded")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+issuer.Hostname+path, bytes.NewReader(body))
	if err != nil {
		return result, errors.New("certificate request could not be constructed")
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return result, errors.New("setup installation could not be reached with its trusted certificate")
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			resultErr = errors.Join(resultErr, errors.New("setup response could not be closed"))
		}
	}()
	if response.StatusCode != http.StatusOK {
		return result, errors.New("setup installation declined the request or could not complete it; check its settings")
	}
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 32_769))
	if err != nil || len(encoded) > 32_768 || decodePipeValue(encoded, &result) != nil {
		return result, errors.New("setup installation returned an invalid certificate response")
	}
	return result, nil
}

func memberFromRequest(nodeID, label string, addresses []string, request []byte) (networkMember, error) {
	if nodeID == "" || len(addresses) == 0 || len(addresses) > 2 {
		return networkMember{}, errors.New("machine identity or addresses are unavailable")
	}
	for _, value := range addresses {
		address, err := netip.ParseAddr(value)
		if err != nil || !tailnetAddress(address) {
			return networkMember{}, errors.New("machine DNS resolver is not a Tailscale address")
		}
	}
	csr, err := x509.ParseCertificateRequest(request)
	if err != nil {
		return networkMember{}, errors.New("invalid machine certificate request")
	}
	fingerprint := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	member := networkMember{NodeID: nodeID, Label: label, Addresses: slices.Clone(addresses), KeyFingerprint: hex.EncodeToString(fingerprint[:])}
	if _, err := authoriseCertificate(member, nodeID, request); err != nil {
		return networkMember{}, err
	}
	return member, nil
}

func replaceMember(members []networkMember, member networkMember) ([]networkMember, error) {
	result := slices.Clone(members)
	for _, existing := range result {
		if existing.Label == member.Label && existing.NodeID != member.NodeID {
			return nil, errors.New("machine label is already approved for another Tailscale node")
		}
	}
	for index, existing := range result {
		if existing.NodeID == member.NodeID {
			result[index] = member
			return result, nil
		}
	}
	if len(result) >= 256 {
		return nil, errors.New("private setup member limit reached")
	}
	return append(result, member), nil
}

func tailnetAddress(address netip.Addr) bool {
	return netip.MustParsePrefix("100.64.0.0/10").Contains(address) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(address)
}

func backupAuthority(directory string, configuration networkConfiguration, password string) (actionResult, error) {
	if configuration.Rename != nil { return actionResult{}, errors.New("finish this installation's URL rename before backing up its authority") }
	if configuration.PrivateAccess == nil || configuration.PrivateAccess.Role != "authority" {
		return actionResult{}, errors.New("only the setup installation can export its recovery backup")
	}
	ca, err := loadAuthority(directory)
	if err != nil {
		return actionResult{}, errors.New("setup authority could not be read for backup")
	}
	api, err := loadDNSAPI(directory)
	if err != nil {
		return actionResult{}, err
	}
	var member *networkMember
	for _, candidate := range configuration.Members {
		if candidate.Label == configuration.PrivateAccess.Label {
			value := candidate
			member = &value
			break
		}
	}
	if member == nil {
		return actionResult{}, errors.New("setup installation is missing its own authorised identity")
	}
	authority, err := ca.marshal()
	if err != nil {
		return actionResult{}, err
	}
	body, err := json.Marshal(authorityRecovery{
		Version: 1, Authority: authority, Credentials: api.credentials,
		Members: configuration.Members, Owner: *member,
	})
	if err != nil {
		return actionResult{}, errors.New("setup backup could not be encoded")
	}
	encrypted, err := encryptBackup(body, password)
	if err != nil {
		return actionResult{}, err
	}
	return actionResult{Kind: "backup", Data: base64.StdEncoding.EncodeToString(encrypted)}, nil
}

func (authority *networkAuthority) restore(ctx context.Context, encoded, password string) (actionResult, error) {
	authority.node.certificates.Lock()
	defer authority.node.certificates.Unlock()
	if len(encoded) > 6_000_000 {
		return actionResult{}, errors.New("setup backup exceeds its size limit")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return actionResult{}, errors.New("invalid encrypted setup backup")
	}
	plain, err := decryptBackup(data, password)
	if err != nil {
		return actionResult{}, err
	}
	var recovery authorityRecovery
	if err := decodePipeValue(plain, &recovery); err != nil || recovery.Version != 1 || len(recovery.Members) > 256 || recovery.Credentials.ClientID == "" || recovery.Credentials.ClientSecret == "" {
		return actionResult{}, errors.New("setup backup metadata is invalid")
	}
	ca, err := parseAuthority(recovery.Authority)
	if err != nil {
		return actionResult{}, err
	}
	existing, err := loadAuthority(authority.node.directory)
	if err == nil && !bytes.Equal(existing.certificate.Raw, ca.certificate.Raw) {
		return actionResult{}, errors.New("recovery would replace an existing certificate authority")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return actionResult{}, errors.New("existing authority could not be checked before recovery")
	}
	if root := authority.node.snapshot().RootCertificate; root != nil && !sameAuthority(*root, string(publicCertificatePEM(ca.certificate))) {
		return actionResult{}, errors.New("recovery does not match this installation's trusted authority")
	}
	labels, nodes := make(map[string]bool), make(map[string]bool)
	ownerFound := false
	for _, member := range recovery.Members {
		_, labelError := machineHostname(member.Label)
		fingerprint, fingerprintError := hex.DecodeString(member.KeyFingerprint)
		if labelError != nil || fingerprintError != nil || len(fingerprint) != 32 || member.NodeID == "" || labels[member.Label] || nodes[member.NodeID] || len(member.Addresses) == 0 || len(member.Addresses) > 2 {
			return actionResult{}, errors.New("backup contains invalid or conflicting approved members")
		}
		for _, value := range member.Addresses {
			address, err := netip.ParseAddr(value)
			if err != nil || !tailnetAddress(address) {
				return actionResult{}, errors.New("backup contains an invalid resolver address")
			}
		}
		labels[member.Label], nodes[member.NodeID] = true, true
		if member.Rename != nil {
			if validateRename(*member.Rename) != nil || member.Rename.From != member.Label || labels[member.Rename.To] {
				return actionResult{}, errors.New("backup contains an invalid or conflicting pending rename")
			}
			labels[member.Rename.To] = true
		}
		if member.NodeID == recovery.Owner.NodeID && member.Label == recovery.Owner.Label && member.KeyFingerprint == recovery.Owner.KeyFingerprint && slices.Equal(member.Addresses, recovery.Owner.Addresses) {
			ownerFound = true
		}
	}
	if !ownerFound {
		return actionResult{}, errors.New("backup does not identify its setup installation")
	}
	if err := writePrivateFile(filepath.Join(authority.node.directory, "authority.pem"), recovery.Authority); err != nil {
		return actionResult{}, errors.New("recovered authority could not be stored privately")
	}
	credentials, err := json.Marshal(recovery.Credentials)
	if err != nil {
		return actionResult{}, err
	}
	if err := writePrivateFile(filepath.Join(authority.node.directory, "dns-credential.json"), credentials); err != nil {
		return actionResult{}, errors.New("recovered DNS credential could not be stored privately")
	}
	member, err := authority.issueOwn(ctx, ca, recovery.Owner)
	if err != nil {
		return actionResult{}, err
	}
	if recovery.Owner.Label != member.Label {
		api, err := authority.dnsAPI()
		if err != nil {
			return actionResult{}, err
		}
		oldHostname, err := machineHostname(recovery.Owner.Label)
		if err != nil {
			return actionResult{}, err
		}
		if err := api.update(ctx, oldHostname, recovery.Owner.Addresses, true); err != nil {
			return actionResult{}, err
		}
	}
	members := make([]networkMember, 0, len(recovery.Members)+1)
	for _, previous := range recovery.Members {
		if previous.NodeID != recovery.Owner.NodeID {
			members = append(members, previous)
		}
	}
	members, err = replaceMember(members, member)
	if err != nil {
		return actionResult{}, err
	}
	settings := *authority.node.settings.Load()
	settings.Role, settings.Issuer, settings.Enabled = "authority", nil, false
	return actionResult{Kind: "setup", PrivateAccess: &settings, Members: &members}, nil
}

func (authority *networkAuthority) removeRegistration(ctx context.Context) error {
	authority.node.certificates.Lock()
	defer authority.node.certificates.Unlock()
	settings := authority.node.settings.Load()
	status := authority.node.snapshot()
	if settings.Role == "authority" {
		api, err := authority.dnsAPI()
		if err != nil {
			return err
		}
		return api.update(ctx, authority.node.hostname(), status.Addresses, true)
	}
	if settings.Role != "member" || settings.Issuer == nil || status.RootCertificate == nil {
		return errors.New("private setup is incomplete")
	}
	_, request, err := persistentLeafRequest(authority.node.directory, authority.node.hostname())
	if err != nil {
		return err
	}
	_, err = authority.requestIssuer(ctx, *settings.Issuer, *status.RootCertificate, "/_workbench-network/remove", certificateRequest{
		Label: settings.Label, Request: request,
	})
	return err
}
