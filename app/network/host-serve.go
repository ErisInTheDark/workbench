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

const daemonTailnetPort uint16 = 52739

type hostPublication struct {
	appError error
	daemonError error
}

type hostServe struct {
	client  *local.Client
	watcher *local.IPNBusWatcher
	cancel  context.CancelFunc
	session string
	done    chan struct{}
	mu      sync.Mutex
}

func startHostServe(ctx context.Context, setup context.Context, port uint16, target, daemonTarget string, onFailure func(error)) (*hostServe, hostPublication, error) {
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
	publication, err := owner.update(ctx, port, target, daemonTarget)
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
			if notification.State != nil && *notification.State != ipn.Running {
				onFailure(errors.New("host Tailscale is no longer connected; connect it and retry networking"))
				return
			}
		}
	}()
	return owner, publication, nil
}

func (owner *hostServe) update(ctx context.Context, port uint16, target, daemonTarget string) (hostPublication, error) {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	configuration, err := owner.client.GetServeConfig(ctx)
	if err != nil {
		return hostPublication{}, errors.New("could not read host Tailscale serve configuration")
	}
	if configuration == nil {
		configuration = &ipn.ServeConfig{}
	}
	// Replace only this session's desired mappings, keeping the config ETag and
	// every other owner intact. Individual conflicts do not cancel its sibling.
	if configuration.Foreground == nil {
		configuration.Foreground = make(map[string]*ipn.ServeConfig)
	}
	configuration.Foreground[owner.session] = &ipn.ServeConfig{}
	publication := hostPublication{}
	if port == daemonTailnetPort {
		publication.appError = errors.New("the app port is reserved for daemon discovery")
	} else {
		publication.appError = configureHostServe(configuration, owner.session, port, target)
	}
	if daemonTarget == "" {
		publication.daemonError = errors.New("local daemon is unavailable")
	} else {
		publication.daemonError = configureHostServe(configuration, owner.session, daemonTailnetPort, daemonTarget)
	}
	if err := owner.client.SetServeConfig(ctx, configuration); err != nil {
		if local.IsPreconditionsFailedError(err) {
			return publication, errors.New("Tailscale serve changed concurrently; retry without replacing the other configuration")
		}
		return publication, errors.New("host Tailscale rejected forwarding; check local API permissions and serve availability")
	}
	return publication, nil
}

func (owner *hostServe) close() error {
	owner.cancel()
	err := owner.watcher.Close()
	<-owner.done
	return err
}
