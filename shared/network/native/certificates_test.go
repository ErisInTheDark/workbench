// No exports. Protect certificate ownership, trust and expiry.
package main

import (
	"crypto/x509"
	"testing"
	"time"
)

func TestCertificateTrustAndOwnership(t *testing.T) {
	now := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	authority, err := createAuthority(now)
	if err != nil {
		t.Fatal(err)
	}
	host := "desktop.wb.inthedark.boo"
	_, request, err := createLeafRequest(host)
	if err != nil {
		t.Fatal(err)
	}
	der, err := authority.issue(request, host, now)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(authority.certificate)
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, DNSName: host, CurrentTime: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, DNSName: "laptop.wb.inthedark.boo", CurrentTime: now}); err == nil {
		t.Fatal("certificate authenticated another machine")
	}
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: x509.NewCertPool(), DNSName: host, CurrentTime: now}); err == nil {
		t.Fatal("certificate trusted an unrelated root")
	}
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, DNSName: host, CurrentTime: certificate.NotAfter.Add(time.Second)}); err == nil {
		t.Fatal("expired certificate remained valid")
	}
	for _, invalid := range []string{"example.com", "wb.inthedark.boo", "*.wb.inthedark.boo", "child.desktop.wb.inthedark.boo"} {
		if _, err := authority.issue(request, invalid, now); err == nil {
			t.Fatalf("signed forbidden hostname %q", invalid)
		}
	}
	if renewalDue(certificate, now) || !renewalDue(certificate, certificate.NotAfter.Add(-24*time.Hour)) {
		t.Fatal("renewal did not follow certificate validity")
	}
}
