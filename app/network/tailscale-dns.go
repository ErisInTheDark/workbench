// No exports. Own OAuth credentials and exact-entry Tailscale split-DNS changes.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
)

type dnsCredentials struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

type tailscaleDNS struct {
	client      *http.Client
	baseURL     string
	credentials dnsCredentials
}

func (api *tailscaleDNS) update(ctx context.Context, host string, addresses []string, remove bool) error {
	return api.replace(ctx, host, addresses, addresses, remove)
}

func (api *tailscaleDNS) replace(ctx context.Context, host string, previous, addresses []string, remove bool) error {
	if !validMachineHostname(host) || len(addresses) == 0 || len(addresses) > 2 {
		return errors.New("invalid private DNS registration")
	}
	for _, value := range addresses {
		address, err := netip.ParseAddr(value)
		if err != nil || !(netip.MustParsePrefix("100.64.0.0/10").Contains(address) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(address)) {
			return errors.New("DNS resolver must be a Tailscale address")
		}
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {api.credentials.ClientID},
		"client_secret": {api.credentials.ClientSecret},
	}
	body, err := api.request(ctx, http.MethodPost, "/api/v2/oauth/token", "", "application/x-www-form-urlencoded", []byte(form.Encode()))
	if err != nil {
		return err
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &token); err != nil || token.AccessToken == "" {
		return errors.New("Tailscale returned an invalid access token response")
	}
	const path = "/api/v2/tailnet/-/dns/split-dns"
	body, err = api.request(ctx, http.MethodGet, path, token.AccessToken, "", nil)
	if err != nil {
		return err
	}
	var entries map[string][]string
	if err := json.Unmarshal(body, &entries); err != nil || entries == nil {
		return errors.New("Tailscale returned invalid split-DNS configuration")
	}
	current, exists := entries[host]
	// Resolver ordering is not ownership. Do not replace another installation's entry.
	expected := slices.Clone(addresses)
	slices.Sort(expected)
	sortedCurrent := slices.Clone(current)
	slices.Sort(sortedCurrent)
	sortedPrevious := slices.Clone(previous)
	slices.Sort(sortedPrevious)
	matchesDesired := slices.Equal(sortedCurrent, expected)
	if exists && !matchesDesired && !slices.Equal(sortedCurrent, sortedPrevious) {
		return errors.New("this hostname already has a different DNS resolver; resolve the conflict in Tailscale DNS settings")
	}
	if (!remove && exists && matchesDesired) || (remove && !exists) {
		return nil
	}
	if remove {
		addresses = nil
	}
	patch, err := json.Marshal(map[string][]string{host: addresses})
	if err != nil {
		return errors.New("could not encode DNS registration")
	}
	_, err = api.request(ctx, http.MethodPatch, path, token.AccessToken, "application/json", patch)
	return err
}

func (api *tailscaleDNS) request(ctx context.Context, method, path, token, contentType string, body []byte) (result []byte, resultErr error) {
	base := api.baseURL
	if base == "" {
		base = "https://api.tailscale.com"
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("could not construct Tailscale API request")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	client := api.client
	if client == nil {
		// Never follow a credential-bearing request to another origin.
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("Tailscale API could not be reached")
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			resultErr = errors.Join(resultErr, errors.New("could not close Tailscale API response"))
		}
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		operation := "DNS update"
		if strings.HasSuffix(path, "/token") {
			operation = "credential exchange"
		}
		return nil, fmt.Errorf("Tailscale %s failed (HTTP %d); check credential permissions and tailnet access", operation, response.StatusCode)
	}
	const responseLimit = 1 << 20
	result, err = io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil || len(result) > responseLimit {
		return nil, errors.New("Tailscale API response could not be read within its size limit")
	}
	return result, nil
}
