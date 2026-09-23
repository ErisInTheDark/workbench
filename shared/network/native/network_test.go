// No exports. Protect stable private URLs while local listener targets change.
package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func testHTTPResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestPrivateDaemonOriginFollowsOpenedListenerPort(t *testing.T) {
	if privateDaemonOrigin("peer.wb.inthedark.boo", 0) != nil {
		t.Fatal("published a daemon endpoint without a listener")
	}
	origin := privateDaemonOrigin("peer.wb.inthedark.boo", 32123)
	if origin == nil || *origin != "https://peer.wb.inthedark.boo:32123" {
		t.Fatalf("wrong private daemon endpoint: %v", origin)
	}
}

func TestRetiringPrivateNodeCannotOverwriteReplacementStatus(t *testing.T) {
	var output bytes.Buffer
	current, retired := &privateNetwork{}, &privateNetwork{}
	owner := networkProcess{private: current, output: &output}
	owner.runtime.PrivateAccess.Phase = "starting"
	owner.acceptPrivateStatus(retired, privateStatus{modeStatus: modeStatus{Phase: "failed"}})
	if owner.runtime.PrivateAccess.Phase != "starting" || output.Len() != 0 {
		t.Fatal("a retiring node published over its replacement")
	}
	owner.acceptPrivateStatus(current, privateStatus{modeStatus: modeStatus{Phase: "ready"}})
	if owner.runtime.PrivateAccess.Phase != "ready" || output.Len() == 0 {
		t.Fatal("the current node could not publish progress")
	}
	output.Reset()
	owner.private = nil
	owner.acceptPrivateStatus(current, privateStatus{modeStatus: modeStatus{Phase: "failed"}})
	if output.Len() != 0 {
		t.Fatal("a disposed node published status")
	}
}

func TestSelfAccessUsesHostIdentityAndCurrentApp(t *testing.T) {
	host, app := "host", "app"
	owner := &networkProcess{}
	if owner.ownsConnection(host, "host-app") { t.Fatal("unknown host was treated as this device") }
	owner.runtime.Host.NodeID = &host
	if !owner.ownsConnection(host, "host-app") { t.Fatal("host IP mode lost self-access before private setup") }
	owner.config.Configuration.Group = &networkGroup{Access: "selected"}
	owner.runtime.PrivateAccess.NodeID = &app
	if !owner.ownsConnection(host, app) { t.Fatal("private service lost self-access") }
	if owner.ownsConnection(host, "other-app") || owner.ownsConnection("other-host", app) {
		t.Fatal("self-access leaked to another device or app")
	}
	owner.runtime.PrivateAccess.NodeID = nil
	owner.config.Configuration.PrivateAccess = &privateConfiguration{Label: "desktop"}
	owner.config.Configuration.Members = []networkMember{{NodeID: app, Label: "desktop"}}
	if !owner.ownsConnection(host, app) { t.Fatal("temporarily offline private node lost its stored app identity") }
}

func TestProxyFollowsAppPortAndPreservesRequestSemantics(t *testing.T) {
	targets := &networkTargets{}
	if err := targets.set("http://127.0.0.1:4200", "http://127.0.0.1:4500"); err != nil {
		t.Fatal(err)
	}
	var destinations []string
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		destinations = append(destinations, request.URL.Host)
		if request.URL.Path != "/api/example" || request.URL.RawQuery != "a=one" || request.Header.Get("Origin") != "https://desktop.wb.inthedark.boo" {
			t.Fatal("proxy changed browser request semantics")
		}
		body, err := io.ReadAll(request.Body)
		if err != nil || string(body) != "payload" {
			t.Fatal("proxy did not preserve request body")
		}
		return testHTTPResponse(200, "ok"), nil
	})
	handler := targets.proxy(false, transport, func(err error) { t.Error(err) })
	for _, port := range []string{"4200", "4300"} {
		if err := targets.set("http://127.0.0.1:"+port, "http://127.0.0.1:4500"); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("POST", "https://desktop.wb.inthedark.boo/api/example?a=one", strings.NewReader("payload"))
		request.Header.Set("Origin", "https://desktop.wb.inthedark.boo")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 200 {
			t.Fatalf("proxy status %d", response.Code)
		}
	}
	if len(destinations) != 2 || destinations[0] != "127.0.0.1:4200" || destinations[1] != "127.0.0.1:4300" {
		t.Fatalf("proxy kept a stale app listener: %v", destinations)
	}
}

func TestProxyRejectsInvalidTargetsWithoutLosingPreviousTarget(t *testing.T) {
	targets := &networkTargets{}
	if err := targets.set("http://127.0.0.1:4200", "http://127.0.0.1:4500"); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"file:///private/key", "http://example.com:4200", "http://127.0.0.1:4200/path", "http://user:secret@127.0.0.1:4200"} {
		if err := targets.set(target, "http://127.0.0.1:4500"); err == nil {
			t.Fatal("proxy admitted an invalid local target")
		}
	}
	handler := targets.proxy(false, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "127.0.0.1:4200" {
			t.Fatal("invalid update corrupted the current target")
		}
		return testHTTPResponse(200, "ok"), nil
	}), func(err error) { t.Error(err) })
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "https://desktop.wb.inthedark.boo/", nil))
}

func TestUnavailableDaemonDoesNotDisableAppOrUseARetiredPort(t *testing.T) {
	targets := &networkTargets{}
	if err := targets.set("http://127.0.0.1:4200", ""); err != nil {
		t.Fatal(err)
	}
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "127.0.0.1:4200" {
			t.Fatal("missing daemon target reached a guessed listener")
		}
		return testHTTPResponse(200, "ok"), nil
	})
	app := httptest.NewRecorder()
	targets.proxy(false, transport, func(err error) { t.Error(err) }).ServeHTTP(app, httptest.NewRequest("GET", "https://desktop.wb.inthedark.boo/", nil))
	if app.Code != 200 {
		t.Fatal("unavailable daemon disabled the app")
	}
	daemon := httptest.NewRecorder()
	targets.proxy(true, transport, func(err error) { t.Error(err) }).ServeHTTP(daemon, httptest.NewRequest("GET", "https://desktop.wb.inthedark.boo/", nil))
	if daemon.Code != http.StatusServiceUnavailable {
		t.Fatal("missing daemon was not reported unavailable")
	}
}
