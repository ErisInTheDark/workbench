// No exports. Own private-node networking and live app/daemon proxy targets.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type proxyTargets struct {
	app    *url.URL
	daemon *url.URL
}

type networkTargets struct {
	current atomic.Pointer[proxyTargets]
	ingressToken atomic.Pointer[string]
	daemonIngressToken atomic.Pointer[string]
	privateAppAllowed atomic.Pointer[bool]
}

type networkDeviceContext struct{}

func (targets *networkTargets) set(appOrigin, daemonOrigin string) error {
	var app *url.URL
	var err error
	if appOrigin != "" {
		app, err = localProxyURL(appOrigin)
		if err != nil { return err }
	}
	var daemon *url.URL
	if daemonOrigin != "" {
		daemon, err = localProxyURL(daemonOrigin)
		if err != nil {
			return err
		}
	}
	targets.current.Store(&proxyTargets{app: app, daemon: daemon})
	return nil
}

func (targets *networkTargets) proxy(daemon bool, transport http.RoundTripper, warn func(error)) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		current := targets.current.Load()
		var target *url.URL
		if current != nil {
			target = current.app
			if daemon { target = current.daemon }
		}
		if target == nil {
			http.Error(response, "Local Workbench service is unavailable.", http.StatusServiceUnavailable)
			return
		}
		// Capture one immutable target for this request. An endpoint change must
		// not swap or clear its destination between admission and rewriting.
		proxy := &httputil.ReverseProxy{
		Transport: transport,
		ErrorLog:  log.New(io.Discard, "", 0),
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			for key := range request.Out.Header {
				if strings.HasPrefix(strings.ToLower(key), "x-workbench-network-") && !strings.EqualFold(key, "X-Workbench-Network-Request") {
					request.Out.Header.Del(key)
				}
			}
			scheme := "http://"
			if request.In.TLS != nil { scheme = "https://" }
			request.Out.Header.Set("X-Workbench-Network-Origin", scheme+request.In.Host)
			if device, ok := request.In.Context().Value(networkDeviceContext{}).(string); ok {
				token := targets.ingressToken.Load()
				if daemon && targets.daemonIngressToken.Load() != nil { token = targets.daemonIngressToken.Load() }
				if token != nil {
					request.Out.Header.Set("X-Workbench-Network-Token", *token)
					request.Out.Header.Set("X-Workbench-Network-Device", device)
				}
			}
		},
		ErrorHandler: func(response http.ResponseWriter, request *http.Request, err error) {
			if request.Context().Err() == nil {
				warn(errors.New("local Workbench proxy target is unavailable"))
			}
			http.Error(response, "Local Workbench service is unavailable.", http.StatusBadGateway)
		},
		}
		proxy.ServeHTTP(response, request)
	})
}

func localProxyURL(value string) (*url.URL, error) {
	target, err := url.Parse(value)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.User != nil || target.RawQuery != "" || target.Fragment != "" || (target.Path != "" && target.Path != "/") {
		return nil, errors.New("network proxy requires a local HTTP origin")
	}
	address, err := netip.ParseAddr(target.Hostname())
	port, portError := strconv.ParseUint(target.Port(), 10, 16)
	if err != nil || !address.IsLoopback() || portError != nil || port == 0 {
		return nil, errors.New("network proxy requires the bound loopback listener address")
	}
	return target, nil
}

type privateNetwork struct {
	group *networkGroupController
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	ready     chan struct{}
	result    error
	server    *tsnet.Server
	local     *local.Client
	directory string
	port      uint16
	targets   *networkTargets
	control   http.Handler
	directorySnapshot func() *networkDirectory
	access *networkAccess
	publish   func(privateStatus)
	renew     func(context.Context) error
	refresh   chan struct{}
	settings  atomic.Pointer[privateConfiguration]
	presentation atomic.Pointer[privatePresentation]
	certificates sync.Mutex
	mu        sync.Mutex
	status    privateStatus
}

type privatePresentation struct {
	hostname string
	names []string
	certificate *tls.Certificate
}

func (node *privateNetwork) hostname() string { return node.presentation.Load().hostname }
func privateDaemonOrigin(hostname string, port uint16) *string {
	if port == 0 { return nil }
	origin := "https://" + net.JoinHostPort(hostname, strconv.Itoa(int(port)))
	return &origin
}
func (node *privateNetwork) certificate() *tls.Certificate { return node.presentation.Load().certificate }
func (node *privateNetwork) controlHostname() string {
	host, _ := machineHostname(stableNodeLabel(*node.settings.Load()))
	return host
}

func newPrivateNetwork(parent context.Context, directory string, settings privateConfiguration, daemonPort uint16, targets *networkTargets, publish func(privateStatus)) (*privateNetwork, error) {
	host, err := machineHostname(settings.Label)
	if err != nil {
		return nil, err
	}
	if daemonPort == 443 || daemonPort == 53 {
		return nil, errors.New("daemon port must differ from private HTTPS 443 and DNS 53")
	}
	if err := ensurePrivateDirectory(directory); err != nil {
		return nil, errors.New("could not protect private network state directory")
	}
	nodeDirectory := filepath.Join(directory, "tsnet")
	if err := ensurePrivateDirectory(nodeDirectory); err != nil {
		return nil, errors.New("could not protect Tailscale identity directory")
	}
	ctx, cancel := context.WithCancel(parent)
	node := &privateNetwork{
		ctx: ctx, cancel: cancel, done: make(chan struct{}), ready: make(chan struct{}), directory: directory,
		port: daemonPort, targets: targets, publish: publish, refresh: make(chan struct{}, 1),
		server: &tsnet.Server{Dir: nodeDirectory, Hostname: "wb-" + stableNodeLabel(settings)},
		status: privateStatus{
			modeStatus: modeStatus{Phase: "starting"}, Hostname: &host,
			Addresses: []string{}, Pending: []pairingRequest{},
		},
	}
	// Structured LocalClient state owns login/failure reporting. Diagnostic prose
	// can contain authorisation URLs, so it never crosses the process log boundary.
	node.server.UserLogf = log.New(io.Discard, "", 0).Printf
	node.server.Logf = log.New(io.Discard, "", 0).Printf
	node.settings.Store(&settings)
	names := []string{host}
	if settings.rename != nil && settings.rename.Phase == "retire" {
		old, _ := machineHostname(settings.rename.From)
		names = append(names, old)
	}
	node.presentation.Store(&privatePresentation{hostname: host, names: names})
	return node, nil
}

func stableNodeLabel(settings privateConfiguration) string {
	if settings.NodeLabel != "" { return settings.NodeLabel }
	return settings.Label
}

func (node *privateNetwork) start() {
	go func() {
		defer close(node.done)
		node.result = node.run()
		if node.result != nil {
			node.change(func(status *privateStatus) {
				message := node.result.Error()
				status.Phase, status.Message = "failed", &message
			})
		}
	}()
}

func (node *privateNetwork) close() error {
	node.cancel()
	<-node.done
	return node.result
}

func (node *privateNetwork) waitReady(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-node.done:
		return errors.New("private node stopped before setup could continue")
	case <-node.ready:
		if node.ctx.Err() != nil {
			return errors.New("private node is no longer connected")
		}
		return nil
	}
}

func (node *privateNetwork) configure(settings privateConfiguration) {
	node.settings.Store(&settings)
	select {
	case node.refresh <- struct{}{}:
	default:
		// A queued refresh already represents the latest immutable settings.
	}
}

func (node *privateNetwork) snapshot() privateStatus {
	node.mu.Lock()
	defer node.mu.Unlock()
	status := node.status
	status.Addresses = slices.Clone(status.Addresses)
	status.Pending = slices.Clone(status.Pending)
	return status
}

func (node *privateNetwork) change(update func(*privateStatus)) {
	node.mu.Lock()
	update(&node.status)
	node.mu.Unlock()
	node.publish(node.snapshot())
}

func (node *privateNetwork) installCertificate(certificate *tls.Certificate) error {
	current := node.presentation.Load()
	return node.present(current.hostname, current.names, certificate)
}

func (node *privateNetwork) present(hostname string, names []string, certificate *tls.Certificate) error {
	var details privateStatus
	if certificate != nil {
		copy := *certificate
		certificate = &copy
		var err error
		details, err = privateCertificateDetails(certificate, hostname)
		if err != nil { return err }
	}
	node.presentation.Store(&privatePresentation{hostname: hostname, names: slices.Clone(names), certificate: certificate})
	node.change(func(status *privateStatus) {
		status.Hostname = &hostname
		status.RootCertificate = details.RootCertificate
		status.RootFingerprint = details.RootFingerprint
		status.CertificateExpiresAt = details.CertificateExpiresAt
	})
	select {
	case node.refresh <- struct{}{}:
	default:
	}
	return nil
}

func privateCertificateDetails(certificate *tls.Certificate, hostname string) (privateStatus, error) {
	if len(certificate.Certificate) < 2 {
		return privateStatus{}, errors.New("private certificate is missing its authority")
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return privateStatus{}, errors.New("private certificate is invalid")
	}
	root, err := x509.ParseCertificate(certificate.Certificate[1])
	if err != nil || !root.IsCA {
		return privateStatus{}, errors.New("private certificate authority is invalid")
	}
	if leaf.CheckSignatureFrom(root) != nil || leaf.VerifyHostname(hostname) != nil {
		return privateStatus{}, errors.New("saved private certificate does not authenticate this installation")
	}
	certificate.Leaf = leaf
	rootPEM := string(publicCertificatePEM(root))
	rootHash := sha256.Sum256(root.Raw)
	fingerprint := hex.EncodeToString(rootHash[:])
	expires := leaf.NotAfter.UTC().Format(time.RFC3339)
	return privateStatus{RootCertificate: &rootPEM, RootFingerprint: &fingerprint, CertificateExpiresAt: &expires}, nil
}

func offlinePrivateStatus(directory string, settings *privateConfiguration) (privateStatus, error) {
	status := privateStatus{modeStatus: modeStatus{Phase: "off"}, Addresses: []string{}, Pending: []pairingRequest{}}
	if settings == nil {
		return status, nil
	}
	host, err := machineHostname(settings.Label)
	if err != nil {
		return status, err
	}
	status.Hostname = &host
	path := filepath.Join(directory, "leaf.pem")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return status, nil
	} else if err != nil {
		return status, errors.New("saved private certificate could not be read")
	}
	certificate, err := tls.LoadX509KeyPair(path, filepath.Join(directory, "leaf-key.pem"))
	if err != nil {
		return status, errors.New("saved private certificate could not be loaded")
	}
	details, err := privateCertificateDetails(&certificate, host)
	if err != nil {
		return status, err
	}
	status.RootCertificate, status.RootFingerprint, status.CertificateExpiresAt = details.RootCertificate, details.RootFingerprint, details.CertificateExpiresAt
	return status, nil
}

func (node *privateNetwork) run() (result error) {
	var workers sync.WaitGroup
	var cleanup []func() error
	directoryRefresh := make(chan struct{}, 1)
	defer func() {
		node.cancel()
		for index := len(cleanup) - 1; index >= 0; index-- {
			if err := cleanup[index](); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, http.ErrServerClosed) {
				result = errors.Join(result, errors.New("private network resource cleanup failed"))
			}
		}
		workers.Wait()
	}()
	err := node.server.Start()
	cleanup = append(cleanup, node.server.Close)
	if err != nil {
		return errors.New("private Tailscale node could not start")
	}
	node.local, err = node.server.LocalClient()
	if err != nil {
		return errors.New("private Tailscale local API is unavailable")
	}
	watcher, err := node.local.WatchIPNBus(node.ctx, ipn.NotifyInitialState)
	if err != nil {
		return errors.New("private Tailscale login status is unavailable")
	}
	cleanup = append(cleanup, watcher.Close)
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			notification, err := watcher.Next()
			if err != nil {
				if node.ctx.Err() == nil {
					node.change(func(status *privateStatus) {
						message := "Tailscale status connection failed; retry private access."
						status.Message, status.Phase = &message, "failed"
					})
					node.cancel()
				}
				return
			}
			if notification.BrowseToURL != nil && *notification.BrowseToURL != "" {
				login := *notification.BrowseToURL
				parsed, err := url.Parse(login)
				if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "login.tailscale.com" {
					node.change(func(status *privateStatus) {
						message := "Tailscale supplied an unsupported login address."
						status.Message, status.Phase = &message, "failed"
					})
					node.cancel()
					return
				}
				node.change(func(status *privateStatus) { status.Phase, status.LoginURL = "login", &login })
			}
			if notification.ErrMessage != nil {
				node.change(func(status *privateStatus) {
					message := "Tailscale reported a node failure; check its status and retry."
					status.Message = &message
				})
			}
			if notification.NetMap != nil {
				select {
				case directoryRefresh <- struct{}{}:
				default:
					// One queued refresh reads the latest peer directory.
				}
			}
		}
	}()
	status, err := node.server.Up(node.ctx)
	if err != nil {
		if node.ctx.Err() != nil {
			return nil
		}
		return errors.New("private Tailscale node could not connect")
	}
	if status.Self == nil || len(status.TailscaleIPs) == 0 {
		return errors.New("private Tailscale node did not receive an identity and address")
	}
	nodeID := string(status.Self.ID)
	_, request, err := persistentLeafRequest(node.directory, node.hostname())
	if err != nil {
		return errors.New("private installation key could not be prepared")
	}
	csr, err := x509.ParseCertificateRequest(request)
	if err != nil {
		return errors.New("private installation key identity could not be read")
	}
	keyHash := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	keyFingerprint := hex.EncodeToString(keyHash[:])
	addresses := make([]string, 0, len(status.TailscaleIPs))
	for _, address := range status.TailscaleIPs {
		addresses = append(addresses, address.String())
	}
	certificatePath := filepath.Join(node.directory, "leaf.pem")
	if _, err := os.Stat(certificatePath); err == nil {
		certificate, err := tls.LoadX509KeyPair(certificatePath, filepath.Join(node.directory, "leaf-key.pem"))
		if err != nil {
			return errors.New("saved private certificate could not be loaded")
		}
		if err := node.installCertificate(&certificate); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("saved private certificate could not be read")
	}
	node.change(func(current *privateStatus) {
		current.NodeID, current.Addresses, current.LoginURL, current.Phase = &nodeID, addresses, nil, "setup"
		current.KeyFingerprint = &keyFingerprint
	})
	fail := func(message string) {
		if node.ctx.Err() != nil {
			return
		}
		node.change(func(current *privateStatus) {
			current.Phase, current.Message, current.DaemonURL = "failed", &message, nil
		})
		node.cancel()
	}
	if node.group != nil {
		listener, err := node.server.Listen("tcp", ":"+groupControlPort)
		if err != nil { return errors.New("private network control listener could not open") }
		cleanup = append(cleanup, listener.Close)
		server := &http.Server{Handler: node.group, BaseContext: func(net.Listener) context.Context { return node.ctx }}
		cleanup = append(cleanup, server.Close)
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
				fail("Private network control listener failed.")
			}
		}()
	}
	tlsConfiguration := &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		presentation := node.presentation.Load()
		certificate := presentation.certificate
		name := strings.TrimSuffix(strings.ToLower(hello.ServerName), ".")
		allowed := slices.Contains(presentation.names, name) || name == node.controlHostname()
		if certificate == nil || certificate.Leaf == nil || !allowed || certificate.Leaf.VerifyHostname(name) != nil || !time.Now().Before(certificate.Leaf.NotAfter) {
			return nil, errors.New("private certificate is unavailable, expired or requested for another name")
		}
		return certificate, nil
	}}
	ports := []uint16{443}
	if node.port != 0 {
		ports = append(ports, node.port)
	}
	for _, port := range ports {
		listener, err := node.server.Listen("tcp", ":"+strconv.Itoa(int(port)))
		if err != nil {
			return errors.New("private HTTPS listener could not open")
		}
		cleanup = append(cleanup, listener.Close)
		proxy := node.targets.proxy(port == node.port, nil, func(err error) {
			message := err.Error()
			node.change(func(current *privateStatus) { current.Message = &message })
		})
		handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			presentation := node.presentation.Load()
			isControl := port == 443 && strings.HasPrefix(request.URL.Path, "/_workbench-network/") && request.URL.Path != "/_workbench-network/verify"
			if !isControl && (request.TLS == nil || !slices.Contains(presentation.names, strings.TrimSuffix(strings.ToLower(request.TLS.ServerName), "."))) {
				http.NotFound(response, request)
				return
			}
			if port == 443 && request.URL.Path == "/_workbench-network/verify" && request.Method == http.MethodGet {
				response.Header().Set("Access-Control-Allow-Origin", "*")
				response.Header().Set("Cache-Control", "no-store")
				response.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(response).Encode(struct {
					Hostname string `json:"hostname"`
					NodeID   string `json:"nodeId"`
				}{Hostname: presentation.hostname, NodeID: nodeID}); err != nil && request.Context().Err() == nil {
					node.change(func(current *privateStatus) {
						message := "Private HTTPS verification response could not be delivered."
						current.Message = &message
					})
				}
				return
			}
			if port == 443 && strings.HasPrefix(request.URL.Path, "/_workbench-network/") {
				if node.control == nil {
					http.NotFound(response, request)
				} else {
					node.control.ServeHTTP(response, request)
				}
				return
			}
			if !node.settings.Load().Enabled {
				http.Error(response, "Private Workbench access has not been enabled.", http.StatusServiceUnavailable)
				return
			}
			if node.access != nil {
				peer, err := node.local.WhoIs(request.Context(), request.RemoteAddr)
				if err != nil || peer.Node == nil || peer.Node.StableID == "" {
					http.Error(response, "Tailscale device identity could not be verified.", http.StatusForbidden)
					return
				}
				device := string(peer.Node.StableID)
				ctx, release, err := node.access.admit(request.Context(), device, nodeID, closeNetworkConnection(request.Context()))
				if err != nil {
					http.Error(response, "This device does not have access to this app.", http.StatusForbidden)
					return
				}
				defer release()
				request = request.WithContext(context.WithValue(ctx, networkDeviceContext{}, device))
			}
			if allowed := node.targets.privateAppAllowed.Load(); port == 443 && allowed != nil && !*allowed {
				http.Error(response, "This app's explicit daemon URL is not compatible with private HTTPS.", http.StatusServiceUnavailable)
				return
			}
			proxy.ServeHTTP(response, request)
		})
		server := &http.Server{Handler: handler, BaseContext: func(net.Listener) context.Context { return node.ctx }, ConnContext: networkConnection}
		cleanup = append(cleanup, server.Close)
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := server.Serve(tls.NewListener(listener, tlsConfiguration)); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
				fail("Private HTTPS listener failed.")
			}
		}()
	}
	tcp, err := node.server.Listen("tcp", ":53")
	if err != nil {
		return errors.New("private TCP DNS listener could not open")
	}
	cleanup = append(cleanup, tcp.Close)
	dnsServers := []*dns.Server{{Listener: tcp}}
	for _, address := range status.TailscaleIPs {
		packet, err := node.server.ListenPacket("udp", net.JoinHostPort(address.String(), "53"))
		if err != nil {
			return errors.New("private UDP DNS listener could not open")
		}
		cleanup = append(cleanup, packet.Close)
		dnsServers = append(dnsServers, &dns.Server{PacketConn: packet})
	}
	for _, server := range dnsServers {
		server.Handler = dns.HandlerFunc(func(writer dns.ResponseWriter, request *dns.Msg) {
			presentation := node.presentation.Load()
			answer := dnsAnswer(presentation.hostname, status.TailscaleIPs, request, presentation.names...)
			if node.directorySnapshot != nil {
				if directory := node.directorySnapshot(); directory != nil {
					if directory.Group.DNSNodeID != nodeID {
						answer = new(dns.Msg).SetRcode(request, dns.RcodeRefused)
					} else {
						resolver := directoryDNS{members: func() []networkMember { return directory.Members }, exchange: publicDNSExchange}
						_, tcp := writer.RemoteAddr().(*net.TCPAddr)
						var err error
						answer, err = resolver.answer(node.ctx, request, tcp)
						if err != nil && node.ctx.Err() == nil {
							message := err.Error()
							node.change(func(current *privateStatus) { current.Message = &message })
						}
						if !tcp {
							size := uint16(512)
							if opt := request.IsEdns0(); opt != nil { size = max(size, opt.UDPSize()) }
							answer.Truncate(int(min(size, 1232)))
						}
					}
				}
			}
			if err := writer.WriteMsg(answer); err != nil && node.ctx.Err() == nil {
				message := "Private DNS response could not be sent."
				node.change(func(current *privateStatus) { current.Message = &message })
			}
		})
		started := make(chan struct{})
		failed := make(chan error, 1)
		server.NotifyStartedFunc = func() { close(started) }
		workers.Add(1)
		go func() {
			defer workers.Done()
			err := server.ActivateAndServe()
			failed <- err
			if err != nil {
				fail("Private DNS listener failed.")
			}
		}()
		select {
		case <-started:
			cleanup = append(cleanup, server.Shutdown)
		case <-failed:
			return errors.New("private DNS listener could not start")
		case <-node.ctx.Done():
			return nil
		}
	}
	close(node.ready)
	if node.group != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				var err error
				if node.settings.Load().Role == "authority" { err = node.group.initialise(node.ctx) }
				if err == nil { err = node.group.reconnect(node.ctx) }
				if err != nil && node.ctx.Err() == nil {
					message := err.Error()
					node.change(func(status *privateStatus) { status.Message = &message })
				}
				select {
				case <-node.ctx.Done():
					return
				case <-directoryRefresh:
				}
			}
		}()
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-node.ctx.Done():
			return nil
		case <-node.refresh:
		case <-timer.C:
		}
		certificate := node.certificate()
		if certificate != nil && renewalDue(certificate.Leaf, time.Now()) && node.renew != nil {
			node.change(func(current *privateStatus) {
				message := "Renewing the private certificate with the setup installation."
				current.Message = &message
				if !time.Now().Before(certificate.Leaf.NotAfter) {
					current.Phase = "failed"
				}
			})
			if err := node.renew(node.ctx); err != nil && node.ctx.Err() == nil {
				message := "Certificate renewal failed; keep the setup installation online and retry."
				node.change(func(current *privateStatus) { current.Message = &message })
			}
			certificate = node.certificate()
		}
		node.change(func(current *privateStatus) {
			if certificate != nil && time.Now().Before(certificate.Leaf.NotAfter) && node.settings.Load().Enabled {
				address := "https://" + node.hostname()
				current.Phase, current.URL = "ready", &address
				current.DaemonURL = privateDaemonOrigin(node.hostname(), node.port)
			} else {
				current.Phase, current.URL = "setup", nil
				current.DaemonURL = nil
				if certificate != nil && !time.Now().Before(certificate.Leaf.NotAfter) {
					message := "Private certificate has expired; reconnect to the setup installation."
					current.Phase, current.Message = "failed", &message
				}
			}
		})
		// One owner schedules expiry checks and renewal attempts. This is a refresh
		// cadence, not a deadline that turns useful late work into failure.
		timer.Reset(24 * time.Hour)
	}
}
