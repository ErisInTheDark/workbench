// No exports. Own session-scoped host Tailscale forwarding without changing unrelated mappings.
package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
)

func configureHostServe(configuration *ipn.ServeConfig, session string, port uint16, target string) error {
	if session == "" || port == 0 {
		return errors.New("host forwarding needs an active session and a nonzero port")
	}
	host, targetPort, err := net.SplitHostPort(target)
	address, addressError := netip.ParseAddr(host)
	parsedPort, portError := strconv.ParseUint(targetPort, 10, 16)
	if err != nil || addressError != nil || !address.IsLoopback() || portError != nil || parsedPort == 0 {
		return errors.New("host forwarding target must be the local app listener")
	}
	if configuration.TCP[port] != nil {
		return errors.New("that Tailscale port already belongs to another serve mapping")
	}
	for owner, foreground := range configuration.Foreground {
		if owner != session && foreground != nil && foreground.TCP[port] != nil {
			return errors.New("that Tailscale port already belongs to another foreground session")
		}
	}
	if configuration.Foreground == nil {
		configuration.Foreground = make(map[string]*ipn.ServeConfig)
	}
	if configuration.Foreground[session] == nil {
		configuration.Foreground[session] = &ipn.ServeConfig{}
	}
	if configuration.Foreground[session].TCP == nil {
		configuration.Foreground[session].TCP = make(map[uint16]*ipn.TCPPortHandler)
	}
	configuration.Foreground[session].TCP[port] = &ipn.TCPPortHandler{TCPForward: target}
	return nil
}

type hostPublication struct {
	appError error
	daemonError error
	visError error
}

// Each target the host forwards a fixed tailnet port to; empty targets are not published.
type hostTargets struct {
	app, daemon, vis string
}

type hostServe struct {
	client  *local.Client
	watcher *local.IPNBusWatcher
	cancel  context.CancelFunc
	session string
	done    chan struct{}
	mu      sync.Mutex
}

func startHostServe(ctx context.Context, setup context.Context, port, retainedPort uint16, targets hostTargets, onFailure func(error), peersChanged ...func()) (*hostServe, hostPublication, error) {
	ctx, cancel := context.WithCancel(ctx)
	stopSetupCancellation := context.AfterFunc(setup, cancel)
	defer stopSetupCancellation()
	client := &local.Client{}
	watcher, err := client.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		cancel()
		return nil, hostPublication{}, errors.New("host Tailscale is unavailable; install and connect Tailscale before enabling a static port")
	}
	initial, err := watcher.Next()
	if err != nil || initial.SessionID == "" {
		cancel()
		return nil, hostPublication{}, errors.Join(errors.New("host Tailscale did not provide a foreground session"), watcher.Close())
	}
	owner := &hostServe{client: client, watcher: watcher, cancel: cancel, session: initial.SessionID, done: make(chan struct{})}
	publication, err := owner.update(ctx, port, retainedPort, targets)
	if err != nil {
		cancel()
		return nil, publication, errors.Join(err, watcher.Close())
	}
	go func() {
		defer close(owner.done)
		defer cancel()
		for {
			notification, err := watcher.Next()
			if err != nil {
				if ctx.Err() == nil {
					onFailure(errors.New("host Tailscale foreground session ended; retry the static port in settings"))
				}
				return
			}
			if notification.ErrMessage != nil {
				onFailure(errors.New("host Tailscale reported a foreground session failure; check its status"))
				return
			}
			if notification.NetMap != nil && len(peersChanged) > 0 { peersChanged[0]() }
			if notification.State != nil && *notification.State != ipn.Running {
				onFailure(errors.New("host Tailscale is no longer connected; connect it and retry networking"))
				return
			}
		}
	}()
	return owner, publication, nil
}

func (owner *hostServe) update(ctx context.Context, port, retainedPort uint16, targets hostTargets) (hostPublication, error) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	configuration, err := owner.client.GetServeConfig(ctx)
	if err != nil {
		return hostPublication{}, errors.New("could not read host Tailscale serve configuration")
	}
	if configuration == nil {
		configuration = &ipn.ServeConfig{}
	}
	publication := configureHostMappings(configuration, owner.session, port, retainedPort, targets)
	if err := owner.client.SetServeConfig(ctx, configuration); err != nil {
		if local.IsPreconditionsFailedError(err) {
			return publication, errors.New("Tailscale serve changed concurrently; retry without replacing the other configuration")
		}
		return publication, errors.New("host Tailscale rejected forwarding; check local API permissions and serve availability")
	}
	return publication, nil
}

func reservedHostPort(port uint16) bool {
	return port == daemonTailnetPort || port == visTailnetPort
}

// Publishes one fixed port beside the app's, replacing any earlier mapping of it; returns why it could not.
func configureFixedHostPort(configuration *ipn.ServeConfig, session string, port uint16, target, unavailable string) error {
	if current := configuration.Foreground[session]; current != nil {
		delete(current.TCP, port)
	}
	if target == "" {
		return errors.New(unavailable)
	}
	if err := configureHostServe(configuration, session, port, target); err != nil {
		return err
	}
	configuration.Foreground[session].TCP[port].ProxyProtocol = 2
	return nil
}

func configureHostMappings(configuration *ipn.ServeConfig, session string, port, retainedPort uint16, targets hostTargets) hostPublication {
	if configuration.Foreground == nil {
		configuration.Foreground = make(map[string]*ipn.ServeConfig)
	}
	previous := configuration.Foreground[session]
	configuration.Foreground[session] = &ipn.ServeConfig{}
	publication := hostPublication{}
	if reservedHostPort(port) || reservedHostPort(retainedPort) {
		publication.appError = errors.New("the app port is reserved for daemon discovery or vis pages")
	} else if targets.app != "" {
		publication.appError = configureHostServe(configuration, session, port, targets.app)
		if publication.appError == nil && retainedPort != 0 && retainedPort != port {
			publication.appError = configureHostServe(configuration, session, retainedPort, targets.app)
		}
		if publication.appError == nil {
			for _, handler := range configuration.Foreground[session].TCP { handler.ProxyProtocol = 2 }
		}
	}
	// A conflicting replacement must not remove either working app entry.
	if publication.appError != nil {
		configuration.Foreground[session] = previous
	}
	publication.daemonError = configureFixedHostPort(configuration, session, daemonTailnetPort, targets.daemon, "local daemon is unavailable")
	// Vis pages follow the app: without a published app there is nothing to serve them for.
	visTarget := targets.vis
	if targets.app == "" || publication.appError != nil { visTarget = "" }
	publication.visError = configureFixedHostPort(configuration, session, visTailnetPort, visTarget, "the app's vis listener is unavailable")
	return publication
}

func (owner *hostServe) close() error {
	owner.cancel()
	err := owner.watcher.Close()
	<-owner.done
	return err
}
