// No exports. Own mandatory PROXY v2 framing and authenticated host-tailnet HTTP ingress.
package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"

	proxyproto "github.com/pires/go-proxyproto"
	"tailscale.com/client/local"
)

func validateHostIngress(header *proxyproto.Header) error {
	if header == nil || header.Version != 2 || header.Command != proxyproto.PROXY {
		return errors.New("host ingress requires PROXY v2 peer identity")
	}
	source, ok := header.SourceAddr.(*net.TCPAddr)
	if !ok || source.Port == 0 { return errors.New("host ingress requires a TCP peer") }
	address, ok := netip.AddrFromSlice(source.IP)
	if !ok || !tailnetAddress(address.Unmap()) { return errors.New("host ingress peer is not a Tailscale address") }
	return nil
}

type hostIngress struct {
	listener net.Listener
	server *http.Server
	cancel context.CancelFunc
	done chan struct{}
}

func startHostIngress(parent context.Context, targets *networkTargets, access *networkAccess, appID func() string, warn func(error), daemon ...bool) (*hostIngress, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { return nil, errors.New("private host ingress listener could not open") }
	ctx, cancel := context.WithCancel(parent)
	owner := &hostIngress{listener: listener, cancel: cancel, done: make(chan struct{})}
	client := &local.Client{}
	proxy := targets.proxy(len(daemon) > 0 && daemon[0], nil, warn)
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		peer, err := client.WhoIs(request.Context(), request.RemoteAddr)
		if err != nil || peer.Node == nil || peer.Node.StableID == "" {
			http.Error(response, "Tailscale device identity could not be verified.", http.StatusForbidden)
			return
		}
		device := string(peer.Node.StableID)
		admitted, release, err := access.admit(request.Context(), device, appID(), closeNetworkConnection(request.Context()))
		if err != nil {
			http.Error(response, "This device does not have access to this app.", http.StatusForbidden)
			return
		}
		defer release()
		proxy.ServeHTTP(response, request.WithContext(context.WithValue(admitted, networkDeviceContext{}, device)))
	})
	owner.server = &http.Server{Handler: handler, BaseContext: func(net.Listener) context.Context { return ctx }, ConnContext: networkConnection}
	framed := &proxyproto.Listener{
		Listener: listener, ReadHeaderTimeout: -1,
		ConnPolicy: func(proxyproto.ConnPolicyOptions) (proxyproto.Policy, error) { return proxyproto.REQUIRE, nil },
		ValidateHeader: validateHostIngress,
	}
	go func() {
		defer close(owner.done)
		if err := owner.server.Serve(framed); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			warn(errors.New("host Tailscale ingress listener failed"))
			cancel()
		}
	}()
	return owner, nil
}

func (owner *hostIngress) close() error {
	owner.cancel()
	err := owner.server.Close()
	<-owner.done
	return err
}
