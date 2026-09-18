// No exports. Verify split-DNS ownership and sanitised external failures without live network access.
package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
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

func TestSplitDNSOwnsOnlyExactEntry(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(map[bool]string{false: "register", true: "remove"}[remove], func(t *testing.T) {
			existing := map[string][]string{"other.example": {"100.70.0.1"}}
			addresses := []string{"100.80.0.2", "fd7a:115c:a1e0::2"}
			host := "desktop.wb.inthedark.boo"
			if remove {
				existing[host] = addresses
			}
			patched := false
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				switch request.URL.Path {
				case "/api/v2/oauth/token":
					if err := request.ParseForm(); err != nil {
						t.Fatal(err)
					}
					if request.Form.Get("client_id") != "client" || request.Form.Get("client_secret") != "secret" || request.Form.Get("grant_type") != "client_credentials" {
						t.Fatal("credential exchange omitted required fields")
					}
					return testHTTPResponse(200, `{"access_token":"token","token_type":"Bearer","expires_in":3600}`), nil
				case "/api/v2/tailnet/-/dns/split-dns":
					if request.Header.Get("Authorization") != "Bearer token" {
						t.Fatal("DNS request lacks access token")
					}
					if request.Method == http.MethodGet {
						body, _ := json.Marshal(existing)
						return testHTTPResponse(200, string(body)), nil
					}
					if request.Method != http.MethodPatch {
						t.Fatal("whole-map replacement would overwrite unrelated DNS")
					}
					var changes map[string][]string
					if err := json.NewDecoder(request.Body).Decode(&changes); err != nil {
						t.Fatal(err)
					}
					expected := addresses
					if remove {
						expected = nil
					}
					value, found := changes[host]
					if len(changes) != 1 || !found || !reflect.DeepEqual(value, expected) {
						t.Fatalf("incorrect scoped mutation: %v", changes)
					}
					patched = true
					return testHTTPResponse(200, `{}`), nil
				default:
					t.Fatalf("unexpected endpoint %s", request.URL.Path)
					return nil, nil
				}
			})}
			api := tailscaleDNS{client: client, baseURL: "https://api.test", credentials: dnsCredentials{"client", "secret"}}
			if err := api.update(context.Background(), host, addresses, remove); err != nil {
				t.Fatal(err)
			}
			if !patched {
				t.Fatal("registration was not applied")
			}
		})
	}
}

func TestSplitDNSRefusesConflictingOwnership(t *testing.T) {
	for _, remove := range []bool{false, true} {
		writes := 0
		api := tailscaleDNS{
			baseURL: "https://api.test",
			client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/token") {
					return testHTTPResponse(200, `{"access_token":"token"}`), nil
				}
				if request.Method != http.MethodGet {
					writes++
				}
				return testHTTPResponse(200, `{"desktop.wb.inthedark.boo":["100.80.0.99"]}`), nil
			})},
		}
		if err := api.update(context.Background(), "desktop.wb.inthedark.boo", []string{"100.80.0.2"}, remove); err == nil {
			t.Fatal("conflicting resolver was silently replaced or removed")
		}
		if writes != 0 {
			t.Fatal("conflict caused a mutation")
		}
	}
}

func TestSplitDNSDoesNotExposeRemoteFailureBody(t *testing.T) {
	api := tailscaleDNS{baseURL: "https://api.test", client: &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return testHTTPResponse(403, "SECRET credential request echoed by upstream"), nil
		}),
	}}
	err := api.update(context.Background(), "desktop.wb.inthedark.boo", []string{"100.80.0.2"}, false)
	if err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatal("failed request must return a sanitised error")
	}
}

func TestRecoveryReplacesOnlyItsPreviouslyOwnedResolver(t *testing.T) {
	for _, current := range []string{"100.80.0.1", "100.80.0.2", "100.80.0.99"} {
		writes := 0
		api := tailscaleDNS{baseURL: "https://api.test", client: &http.Client{
			Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/token") {
					return testHTTPResponse(200, `{"access_token":"token"}`), nil
				}
				if request.Method == http.MethodPatch {
					writes++
					var patch map[string][]string
					if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(patch, map[string][]string{"desktop.wb.inthedark.boo": {"100.80.0.2"}}) {
						t.Fatal("recovery changed more than its exact owned resolver")
					}
					return testHTTPResponse(200, `{}`), nil
				}
				return testHTTPResponse(200, `{"desktop.wb.inthedark.boo":["`+current+`"]}`), nil
			}),
		}}
		err := api.replace(context.Background(), "desktop.wb.inthedark.boo", []string{"100.80.0.1"}, []string{"100.80.0.2"}, false)
		if current == "100.80.0.99" {
			if err == nil || writes != 0 {
				t.Fatal("recovery overwrote an unrelated resolver")
			}
		} else if err != nil || (current == "100.80.0.1" && writes != 1) || (current == "100.80.0.2" && writes != 0) {
			t.Fatalf("owned resolver recovery or idempotent retry failed: %v, writes %d", err, writes)
		}
	}
}
