// No exports. Own sidecar process lifetime, independent network modes and typed intent dispatch.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"

)

type pipeWriter struct {
	mu     sync.Mutex
	output io.Writer
}

func (writer *pipeWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.output.Write(data)
}

type networkProcess struct {
	access networkAccess
	ingress *hostIngress
	daemonIngress *hostIngress
	discovery *daemonDiscovery
	group *networkGroupController
	ctx       context.Context
	cancel    context.CancelFunc
	directory string
	output    io.Writer
	actions   sync.Mutex
	mu        sync.Mutex
	config    sidecarConfiguration
	runtime   networkRuntime
	targets   networkTargets
	private   *privateNetwork
	authority *networkAuthority
	host      *hostServe
	persistenceMu sync.Mutex
	persistence map[string]*memberPersistence
	networkPersistence map[string]*networkPersistence
	nextPersistence uint64
}

func main() {
	directory := flag.String("state-dir", "", "private Workbench network state directory")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *directory == "" || !filepath.IsAbs(*directory) {
		fmt.Fprintln(os.Stderr, "An absolute private state directory is required.")
		os.Exit(1)
	}
	writer := &pipeWriter{output: os.Stdout}
	owner := &networkProcess{
		ctx: ctx, cancel: cancel, directory: *directory, output: writer,
		runtime: networkRuntime{
			HostServe:     modeStatus{Phase: "off"},
			DaemonServe:   modeStatus{Phase: "off"},
			PrivateAccess: privateStatus{modeStatus: modeStatus{Phase: "off"}, Addresses: []string{}, Pending: []pairingRequest{}},
		},
	}
	owner.access.ownsConnection = owner.ownsConnection
	protocolError := serveProtocol(ctx, os.Stdin, writer, owner.dispatch)
	closeError := owner.close()
	if err := errors.Join(protocolError, closeError); err != nil {
		fmt.Fprintln(os.Stderr, "Workbench network process failed:", err)
		os.Exit(1)
	}
}

func (owner *networkProcess) emit() {
	owner.mu.Lock()
	encoded, err := json.Marshal(struct {
		Event    string         `json:"event"`
		Snapshot networkRuntime `json:"snapshot"`
	}{Event: "status", Snapshot: owner.runtime})
	owner.mu.Unlock()
	if err == nil {
		_, err = owner.output.Write(append(encoded, '\n'))
	}
	if err != nil {
		// Losing the parent pipe ends every network resource, rather than leaving
		// an unreachable background service running.
		owner.cancel()
	}
}

func (owner *networkProcess) members() []networkMember {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return slices.Clone(owner.config.Configuration.Members)
}

func (owner *networkProcess) directorySnapshot() *networkDirectory {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	configuration := owner.config.Configuration
	if configuration.Group == nil { return nil }
	return &networkDirectory{Group: *configuration.Group, Members: slices.Clone(configuration.Members)}
}

func (owner *networkProcess) configurationSnapshot() networkConfiguration {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.config.Configuration
}

func (owner *networkProcess) dispatch(ctx context.Context, request pipeRequest) (json.RawMessage, error) {
	// Issuance can be waiting for this response while holding actions.
	if request.Action == "persist-member-result" {
		return owner.acknowledgeMember(request.Payload)
	}
	if request.Action == "persist-network-result" {
		return owner.acknowledgeNetwork(request.Payload)
	}
	owner.actions.Lock()
	defer owner.actions.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result, err := owner.apply(ctx, request)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, errors.New("network action result could not be encoded")
	}
	return encoded, nil
}

func (owner *networkProcess) apply(ctx context.Context, request pipeRequest) (actionResult, error) {
	if request.Action == "daemon-discovery-refresh" {
		owner.refreshDiscovery()
		return actionResult{Kind: "ok"}, nil
	}
	if request.Action == "configure" {
		var configuration sidecarConfiguration
		if err := decodePipeValue(request.Payload, &configuration); err != nil {
			return actionResult{}, err
		}
		return actionResult{Kind: "ok"}, owner.configure(ctx, configuration)
	}
	if request.Action == "trust-host" {
		owner.mu.Lock()
		root := owner.runtime.PrivateAccess.RootCertificate
		owner.mu.Unlock()
		if root == nil {
			return actionResult{}, errors.New("finish private certificate setup before trusting this host")
		}
		return actionResult{Kind: "ok"}, trustCurrentUserRoot([]byte(*root))
	}
	if owner.private == nil {
		return actionResult{}, errors.New("prepare private access and complete Tailscale enrolment first")
	}
	if err := owner.private.waitReady(ctx); err != nil {
		return actionResult{}, err
	}
	switch request.Action {
	case "discover":
		return actionResult{Kind: "ok"}, owner.group.discover(ctx)
	case "select-network":
		var input struct { ID string `json:"id"` }
		if err := decodePipeValue(request.Payload, &input); err != nil { return actionResult{}, err }
		return actionResult{Kind: "ok"}, owner.group.discover(ctx, input.ID)
	case "dns-app":
		var input struct { NodeID string `json:"nodeId"` }
		if err := decodePipeValue(request.Payload, &input); err != nil { return actionResult{}, err }
		return actionResult{Kind: "ok"}, owner.group.change(ctx, input.NodeID, "", nil)
	case "transfer-owner":
		var input struct { NodeID string `json:"nodeId"` }
		if err := decodePipeValue(request.Payload, &input); err != nil { return actionResult{}, err }
		return actionResult{Kind: "ok"}, owner.group.transferOwner(ctx, input.NodeID)
	case "access":
		var input struct {
			Revision uint64 `json:"revision"`
			Access string `json:"access"`
			Grants []networkGrant `json:"grants"`
		}
		if err := decodePipeValue(request.Payload, &input); err != nil { return actionResult{}, err }
		if directory := owner.group.directory(); directory == nil || directory.Group.Revision != input.Revision {
			return actionResult{}, errors.New("network settings changed; refresh the access draft")
		}
		return actionResult{Kind: "ok"}, owner.group.change(ctx, "", input.Access, input.Grants, input.Revision)
	case "create-setup":
		var credentials legacyDNSCredentials
		if err := decodePipeValue(request.Payload, &credentials); err != nil {
			return actionResult{}, err
		}
		return owner.authority.create(ctx)
	case "pair-code":
		return owner.authority.pairingCode()
	case "join", "reconnect":
		var payload struct {
			Code string `json:"code"`
		}
		if err := decodePipeValue(request.Payload, &payload); err != nil {
			return actionResult{}, err
		}
		return owner.authority.join(ctx, payload.Code)
	case "approve-member":
		if owner.private.settings.Load().Role != "authority" {
			return actionResult{}, errors.New("only the setup installation can approve pairing")
		}
		var payload struct {
			RequestID string         `json:"requestId"`
			Member    *networkMember `json:"member"`
		}
		if err := decodePipeValue(request.Payload, &payload); err != nil {
			return actionResult{}, err
		}
		err := owner.authority.admission.decide(payload.RequestID, payload.Member)
		owner.authority.publishPending()
		return actionResult{Kind: "ok"}, err
	case "remove-registration":
		return actionResult{Kind: "ok"}, owner.authority.removeRegistration(ctx)
	case "retry":
		if owner.group != nil {
			if err := owner.group.reconnect(ctx); err != nil { return actionResult{}, err }
		}
		return actionResult{Kind: "ok"}, owner.authority.renew(ctx)
	case "rename-prepare", "rename-activate", "rename-retire":
		var rename networkRename
		if err := decodePipeValue(request.Payload, &rename); err != nil { return actionResult{}, err }
		current := owner.config.Configuration.Rename
		if current == nil || current.ID != rename.ID || current.From != rename.From || current.To != rename.To {
			return actionResult{}, errors.New("URL rename does not match the persisted intent")
		}
		return actionResult{Kind: "ok"}, owner.authority.rename(ctx, request.Action, rename)
	default:
		return actionResult{}, errors.New("unsupported network command")
	}
}

func (owner *networkProcess) configure(ctx context.Context, configuration sidecarConfiguration) error {
	if configuration.IngressToken != "" && len(configuration.IngressToken) != 64 {
		return errors.New("invalid app ingress credential")
	}
	if configuration.DaemonIngressToken != "" && len(configuration.DaemonIngressToken) != 64 {
		return errors.New("invalid daemon ingress credential")
	}
	if configuration.Configuration.Group != nil {
		directory := networkDirectory{Group: *configuration.Configuration.Group, Members: configuration.Configuration.Members}
		if err := directory.validate(); err != nil { return err }
	}
	if configuration.Configuration.HostServe.Port == 0 {
		return errors.New("static Tailscale port must be nonzero")
	}
	settings := configuration.Configuration.PrivateAccess
	switch configuration.Configuration.Mode {
	case "":
		// Older app processes send the original flags until their restart.
	case "localhost", "tailnet-ip", "tailnet-service":
		configuration.Configuration.HostServe.Enabled = configuration.Configuration.Mode != "localhost"
		if settings != nil {
			settings.Enabled = configuration.Configuration.Mode == "tailnet-service" && settings.Role != "unconfigured"
		}
	default:
		return errors.New("invalid networking mode")
	}
	daemonPort := uint16(0)
	if configuration.DaemonPort != nil {
		daemonPort = *configuration.DaemonPort
	}
	if settings != nil {
		settings.rename = configuration.Configuration.Rename
		if _, err := machineHostname(settings.Label); err != nil {
			return err
		}
		if _, err := machineHostname(stableNodeLabel(*settings)); err != nil {
			return err
		}
		if settings.Role != "unconfigured" && settings.Role != "authority" && settings.Role != "member" {
			return errors.New("invalid private setup role")
		}
		if (settings.Role == "unconfigured" && settings.Enabled) || (settings.Role == "member" && settings.Issuer == nil) {
			return errors.New("private setup is incomplete")
		}
		if owner.private != nil {
			if stableNodeLabel(*owner.private.settings.Load()) != stableNodeLabel(*settings) {
				return errors.New("internal Tailscale node name cannot change")
			}
			host, _ := machineHostname(settings.Label)
			if owner.private.hostname() != host {
				return errors.New("activate the URL rename before changing its address")
			}
		}
	}
	if err := owner.targets.set(configuration.AppOrigin, configuration.DaemonOrigin); err != nil {
		return err
	}
	owner.mu.Lock()
	owner.config = configuration
	owner.mu.Unlock()
	owner.targets.ingressToken.Store(&configuration.IngressToken)
	owner.targets.daemonIngressToken.Store(&configuration.DaemonIngressToken)
	owner.targets.privateAppAllowed.Store(configuration.PrivateAppAllowed)
	if err := owner.access.apply(configuration.Configuration.Group); err != nil { return err }
	if (configuration.Configuration.HostServe.Enabled || configuration.PublishDaemon) && owner.discovery == nil { owner.refreshDiscovery() }
	owner.configureHost(ctx, configuration)
	active := settings != nil && (settings.Enabled || configuration.Preparing)
	if owner.private != nil && (!active || owner.private.ctx.Err() != nil || owner.private.port != daemonPort) {
		err := owner.private.close()
		owner.mu.Lock()
		owner.private, owner.authority = nil, nil
		owner.mu.Unlock()
		if err != nil {
			owner.mu.Lock()
			message := "Previous private network resources reported a shutdown failure."
			owner.runtime.PrivateAccess.Phase, owner.runtime.PrivateAccess.Message, owner.runtime.PrivateAccess.URL = "failed", &message, nil
			owner.mu.Unlock()
			owner.emit()
			return errors.New(message)
		}
	}
	if active && owner.private == nil {
		var node *privateNetwork
		var err error
		node, err = newPrivateNetwork(owner.ctx, owner.directory, *settings, daemonPort, &owner.targets, func(status privateStatus) {
			owner.acceptPrivateStatus(node, status)
		})
		if err != nil {
			owner.mu.Lock()
			message := err.Error()
			owner.runtime.PrivateAccess.Phase, owner.runtime.PrivateAccess.Message = "failed", &message
			owner.mu.Unlock()
		} else {
			owner.mu.Lock()
			owner.private = node
			owner.mu.Unlock()
			owner.authority = &networkAuthority{node: node, members: owner.members, persist: owner.persistMember}
			owner.group = &networkGroupController{
				node: node, authority: owner.authority, read: owner.configurationSnapshot,
				persist: owner.persistNetwork, hostNodeID: func() string {
					owner.mu.Lock()
					defer owner.mu.Unlock()
					if owner.runtime.Host.NodeID != nil { return *owner.runtime.Host.NodeID }
					return ""
				},
			}
			node.group = owner.group
			owner.authority.publishDirectory = owner.group.publishDNS
			node.control, node.renew = owner.authority, owner.authority.renew
			node.directorySnapshot = owner.directorySnapshot
			node.access = &owner.access
			owner.mu.Lock()
			owner.runtime.PrivateAccess = node.snapshot()
			owner.mu.Unlock()
			node.start()
		}
	} else if active {
		owner.private.configure(*settings)
		if settings.Role == "authority" && configuration.Configuration.Group == nil && owner.private.snapshot().NodeID != nil {
			if err := owner.group.initialise(ctx); err != nil { return err }
		}
	} else {
		status, err := offlinePrivateStatus(owner.directory, settings)
		if err != nil {
			message := err.Error()
			status.Message = &message
		}
		owner.mu.Lock()
		owner.runtime.PrivateAccess = status
		owner.mu.Unlock()
	}
	owner.emit()
	return nil
}

func (owner *networkProcess) acceptPrivateStatus(node *privateNetwork, status privateStatus) {
	owner.mu.Lock()
	if owner.private != node {
		owner.mu.Unlock()
		return
	}
	owner.runtime.PrivateAccess = status
	owner.mu.Unlock()
	owner.emit()
}

func (owner *networkProcess) configureHost(ctx context.Context, configuration sidecarConfiguration) {
	settings := configuration.Configuration.HostServe
	if owner.host != nil {
		select {
		case <-owner.host.done:
			if err := owner.host.close(); err != nil {
				owner.hostFailure(err)
			}
			owner.host = nil
		default:
		}
	}
	if !settings.Enabled && !configuration.PublishDaemon {
		var err error
		if owner.host != nil {
			err = owner.host.close()
			owner.host = nil
		}
		if owner.ingress != nil {
			err = errors.Join(err, owner.ingress.close())
			owner.ingress = nil
		}
		if owner.daemonIngress != nil {
			err = errors.Join(err, owner.daemonIngress.close())
			owner.daemonIngress = nil
		}
		owner.mu.Lock()
		owner.runtime.HostServe = modeStatus{Phase: "off"}
		owner.runtime.DaemonServe = modeStatus{Phase: "off"}
		owner.mu.Unlock()
		if err != nil {
			owner.hostFailure(err)
		}
		return
	}
	var err error
	if owner.ingress == nil {
		owner.ingress, err = startHostIngress(owner.ctx, &owner.targets, &owner.access, owner.appNodeID, owner.hostFailure)
		if err != nil { owner.hostFailure(err); return }
	}
	target := ""
	if settings.Enabled && configuration.AppOrigin != "" { target = owner.ingress.listener.Addr().String() }
	daemonTarget := ""
	if configuration.DaemonOrigin != "" {
		if owner.daemonIngress == nil {
			owner.daemonIngress, err = startHostIngress(owner.ctx, &owner.targets, &owner.access, owner.appNodeID, owner.hostFailure, true)
			if err != nil { owner.hostFailure(err); return }
		}
		daemonTarget = owner.daemonIngress.listener.Addr().String()
	}
	owner.mu.Lock()
	owner.runtime.HostServe = modeStatus{Phase: "starting"}
	owner.runtime.DaemonServe = modeStatus{Phase: "starting"}
	owner.mu.Unlock()
	var publication hostPublication
	if owner.host == nil {
		owner.host, publication, err = startHostServe(owner.ctx, ctx, settings.Port, configuration.RetainedHostPort, target, daemonTarget, owner.hostFailure, func() {
			if owner.discovery != nil { owner.discovery.refresh(owner.ctx) }
		})
	} else {
		publication, err = owner.host.update(ctx, settings.Port, configuration.RetainedHostPort, target, daemonTarget)
	}
	if err != nil {
		owner.hostFailure(err)
		return
	}
	status, err := owner.host.client.Status(ctx)
	if err != nil || status == nil || status.BackendState != "Running" || len(status.TailscaleIPs) == 0 {
		owner.hostFailure(errors.New("host Tailscale is not connected; connect it and retry the static port"))
		return
	}
	ip := status.TailscaleIPs[0].String()
	for _, address := range status.TailscaleIPs {
		if address.Is4() { ip = address.String(); break }
	}
	hostname := ""
	if status.Self != nil {
		hostname = strings.Split(status.Self.DNSName, ".")[0]
		if hostname == "" { hostname = status.Self.HostName }
	}
	address := "http://" + net.JoinHostPort(ip, strconv.Itoa(int(settings.Port)))
	daemonAddress := "http://" + net.JoinHostPort(ip, strconv.Itoa(int(daemonTailnetPort)))
	owner.mu.Lock()
	if owner.runtime.HostServe.Phase != "failed" {
		owner.runtime.HostServe = modeStatus{Phase: "ready", URL: &address}
		if target == "" { owner.runtime.HostServe = modeStatus{Phase: "off"} }
		owner.runtime.DaemonServe = modeStatus{Phase: "ready", URL: &daemonAddress}
		if publication.appError != nil {
			message := publication.appError.Error()
			owner.runtime.HostServe = modeStatus{Phase: "failed", Message: &message}
		}
		if publication.daemonError != nil {
			message := publication.daemonError.Error()
			owner.runtime.DaemonServe = modeStatus{Phase: "failed", Message: &message}
		}
		owner.runtime.Host = hostIdentity{Hostname: &hostname, Address: &ip}
		if status.Self != nil {
			nodeID := string(status.Self.ID)
			owner.runtime.Host.NodeID = &nodeID
		}
	}
	owner.mu.Unlock()
}

func (owner *networkProcess) hostFailure(err error) {
	message := err.Error()
	if len(message) > 512 {
		message = message[:512]
	}
	owner.mu.Lock()
	owner.runtime.HostServe = modeStatus{Phase: "failed", Message: &message}
	owner.runtime.DaemonServe = modeStatus{Phase: "failed", Message: &message}
	owner.mu.Unlock()
	owner.emit()
}

func (owner *networkProcess) close() error {
	owner.cancel()
	owner.actions.Lock()
	defer owner.actions.Unlock()
	var failures []error
	if owner.discovery != nil { owner.discovery.close() }
	if owner.ingress != nil {
		failures = append(failures, owner.ingress.close())
		owner.ingress = nil
	}
	if owner.daemonIngress != nil {
		failures = append(failures, owner.daemonIngress.close())
		owner.daemonIngress = nil
	}
	if owner.host != nil {
		failures = append(failures, owner.host.close())
		owner.host = nil
	}
	if owner.private != nil {
		failures = append(failures, owner.private.close())
		owner.mu.Lock()
		owner.private = nil
		owner.mu.Unlock()
	}
	return errors.Join(failures...)
}

func (owner *networkProcess) appNodeID() string {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return owner.appNodeIDLocked()
}

func (owner *networkProcess) ownsConnection(device, app string) bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	return device != "" && app != "" && owner.runtime.Host.NodeID != nil &&
		device == *owner.runtime.Host.NodeID && app == owner.appNodeIDLocked()
}

func (owner *networkProcess) appNodeIDLocked() string {
	configuration := owner.config.Configuration
	if configuration.Group == nil { return "host-app" }
	if owner.runtime.PrivateAccess.NodeID != nil { return *owner.runtime.PrivateAccess.NodeID }
	if configuration.PrivateAccess != nil {
		for _, member := range configuration.Members {
			if member.Label == configuration.PrivateAccess.Label ||
				(member.Rename != nil && (member.Rename.From == configuration.PrivateAccess.Label || member.Rename.To == configuration.PrivateAccess.Label)) {
				return member.NodeID
			}
		}
	}
	return ""
}
