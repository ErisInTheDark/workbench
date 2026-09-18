// No exports. Own remote app admission and cancellation on committed policy changes.
package main

import (
	"context"
	"errors"
	"net"
	"sync"
)

func (group *networkGroup) allows(device, app string, loopback bool) bool {
	if loopback { return true }
	if device == "" || app == "" { return false }
	// Before a private group exists, host-IP mode retains authenticated tailnet access.
	if group == nil || group.Access == "all" { return true }
	for _, grant := range group.Grants {
		if grant.DeviceNodeID == device && grant.AppNodeID == app { return true }
	}
	return false
}

type admittedRequest struct {
	device string
	app string
	cancel context.CancelFunc
	closeConnection func() error
}

type networkConnectionContext struct{}

func networkConnection(ctx context.Context, connection net.Conn) context.Context {
	return context.WithValue(ctx, networkConnectionContext{}, connection)
}

func closeNetworkConnection(ctx context.Context) func() error {
	connection, _ := ctx.Value(networkConnectionContext{}).(net.Conn)
	if connection == nil { return nil }
	return connection.Close
}

type networkAccess struct {
	mu sync.Mutex
	group *networkGroup
	requests map[*admittedRequest]struct{}
}

func (access *networkAccess) admit(parent context.Context, device, app string, closeConnection ...func() error) (context.Context, func(), error) {
	access.mu.Lock()
	defer access.mu.Unlock()
	if !access.group.allows(device, app, false) {
		return nil, nil, errors.New("this device does not have access to this app")
	}
	ctx, cancel := context.WithCancel(parent)
	request := &admittedRequest{device: device, app: app, cancel: cancel}
	if len(closeConnection) > 0 { request.closeConnection = closeConnection[0] }
	if access.requests == nil { access.requests = make(map[*admittedRequest]struct{}) }
	access.requests[request] = struct{}{}
	return ctx, func() {
		cancel()
		access.mu.Lock()
		delete(access.requests, request)
		access.mu.Unlock()
	}, nil
}

func (access *networkAccess) apply(group *networkGroup) error {
	access.mu.Lock()
	defer access.mu.Unlock()
	access.group = group
	var failures []error
	for request := range access.requests {
		if !group.allows(request.device, request.app, false) {
			request.cancel()
			if request.closeConnection != nil {
				if err := request.closeConnection(); err != nil && !errors.Is(err, net.ErrClosed) {
					failures = append(failures, errors.New("revoked app connection could not be closed"))
				}
			}
		}
	}
	return errors.Join(failures...)
}
