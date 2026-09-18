// No exports. Protect mandatory authenticated peer framing on host Tailscale ingress.
package main

import (
	"net"
	"testing"

	proxyproto "github.com/pires/go-proxyproto"
)

func TestHostIngressHeader(t *testing.T) {
	valid := &proxyproto.Header{Version: 2, Command: proxyproto.PROXY,
		SourceAddr: &net.TCPAddr{IP: net.ParseIP("100.80.0.8"), Port: 12345}}
	if err := validateHostIngress(valid); err != nil { t.Fatal(err) }
	for _, bad := range []*proxyproto.Header{
		{Version: 1, Command: proxyproto.PROXY, SourceAddr: valid.SourceAddr},
		{Version: 2, Command: proxyproto.LOCAL, SourceAddr: valid.SourceAddr},
		{Version: 2, Command: proxyproto.PROXY, SourceAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 12345}},
		{Version: 2, Command: proxyproto.PROXY, SourceAddr: &net.TCPAddr{IP: net.ParseIP("192.168.1.1"), Port: 12345}},
	} {
		if validateHostIngress(bad) == nil { t.Fatal("untrusted framing became a local or remote device identity") }
	}
}
