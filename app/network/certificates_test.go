// No exports. Protect certificate ownership, trust, expiry and recovery confidentiality.
package main

import (
	"bytes"
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

func TestBackupAuthenticatesPasswordAndContent(t *testing.T) {
	plain := []byte("private signing material and DNS credentials")
	encrypted, err := encryptBackup(plain, "a long recovery password")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, plain) {
		t.Fatal("backup exposes plaintext")
	}
	restored, err := decryptBackup(encrypted, "a long recovery password")
	if err != nil || !bytes.Equal(restored, plain) {
		t.Fatalf("backup failed round trip: %v", err)
	}
	if _, err := decryptBackup(encrypted, "the wrong recovery password"); err == nil {
		t.Fatal("accepted wrong password")
	}
	encrypted[len(encrypted)-1] ^= 1
	if _, err := decryptBackup(encrypted, "a long recovery password"); err == nil {
		t.Fatal("accepted modified backup")
	}
}
