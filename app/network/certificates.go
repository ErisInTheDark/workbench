// No exports. Own private certificate issuance, validity decisions and encrypted recovery material.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

var machineLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$`)

func machineHostname(label string) (string, error) {
	if !machineLabelPattern.MatchString(label) {
		return "", errors.New("machine name must be a lowercase DNS label of at most 60 characters")
	}
	return label + ".wb.inthedark.boo", nil
}

func validMachineHostname(host string) bool {
	label, found := strings.CutSuffix(host, ".wb.inthedark.boo")
	return found && machineLabelPattern.MatchString(label)
}

type certificateAuthority struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
}

func createAuthority(now time.Time) (*certificateAuthority, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := certificateSerial()
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "Workbench private access"},
		NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(10, 0, 0),
		IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		PermittedDNSDomainsCritical: true, PermittedDNSDomains: []string{".wb.inthedark.boo"},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &certificateAuthority{certificate: certificate, key: key}, nil
}

func createLeafRequest(host string) (*ecdsa.PrivateKey, []byte, error) {
	if !validMachineHostname(host) {
		return nil, nil, errors.New("invalid private machine hostname")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	request, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
	}, key)
	return key, request, err
}

func persistentLeafRequest(directory, host string) (*ecdsa.PrivateKey, []byte, error) {
	if !validMachineHostname(host) {
		return nil, nil, errors.New("invalid private machine hostname")
	}
	path := filepath.Join(directory, "leaf-key.pem")
	data, err := os.ReadFile(path)
	var key *ecdsa.PrivateKey
	if errors.Is(err, os.ErrNotExist) {
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, nil, err
		}
		data, err = privateKeyPEM(key)
		if err != nil {
			return nil, nil, err
		}
		if err := writePrivateFile(path, data); err != nil {
			return nil, nil, err
		}
	} else if err != nil {
		return nil, nil, errors.New("private machine key could not be read")
	} else {
		block, _ := pem.Decode(data)
		if block == nil {
			return nil, nil, errors.New("private machine key is invalid")
		}
		value, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		var valid bool
		key, valid = value.(*ecdsa.PrivateKey)
		if err != nil || !valid || key.Curve != elliptic.P256() {
			return nil, nil, errors.New("private machine key is invalid")
		}
	}
	request, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
	}, key)
	return key, request, err
}

func (authority *certificateAuthority) issue(request []byte, host string, now time.Time, aliases ...string) ([]byte, error) {
	if !validMachineHostname(host) {
		return nil, errors.New("refusing certificate outside private machine namespace")
	}
	csr, err := x509.ParseCertificateRequest(request)
	if err != nil {
		return nil, errors.New("invalid certificate request")
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, errors.New("certificate request signature is invalid")
	}
	key, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("certificate request must use a P-256 key")
	}
	if len(csr.DNSNames) != 1 || csr.DNSNames[0] != host || len(csr.IPAddresses) != 0 || len(csr.EmailAddresses) != 0 || len(csr.URIs) != 0 {
		return nil, errors.New("certificate request hostname does not match approved machine")
	}
	names := []string{host}
	for _, alias := range aliases {
		if !validMachineHostname(alias) {
			return nil, errors.New("refusing certificate alias outside private machine namespace")
		}
		if !slices.Contains(names, alias) { names = append(names, alias) }
	}
	if len(names) > 3 {
		return nil, errors.New("private certificate has too many transition names")
	}
	if !authority.certificate.NotAfter.After(now.Add(30 * 24 * time.Hour)) {
		return nil, errors.New("certificate authority is expiring; renew device trust before issuing certificates")
	}
	serial, err := certificateSerial()
	if err != nil {
		return nil, err
	}
	expires := now.AddDate(1, 0, 0)
	if expires.After(authority.certificate.NotAfter) {
		expires = authority.certificate.NotAfter
	}
	template := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: host}, DNSNames: names,
		NotBefore: now.Add(-5 * time.Minute), NotAfter: expires,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	return x509.CreateCertificate(rand.Reader, template, authority.certificate, csr.PublicKey, authority.key)
}

func encryptBackup(data []byte, password string) ([]byte, error) {
	if len(password) < 12 || len(data) > 4<<20 {
		return nil, errors.New("use a recovery password of at least 12 characters; backup limit is 4 MiB")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	aead, err := backupCipher(password, salt)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	header := append([]byte("WBN1"), salt...)
	header = append(header, nonce...)
	return aead.Seal(header, nonce, data, header), nil
}

func decryptBackup(data []byte, password string) ([]byte, error) {
	if len(data) < 48 || len(data) > (4<<20)+64 || !bytes.Equal(data[:4], []byte("WBN1")) {
		return nil, errors.New("invalid Workbench network backup")
	}
	aead, err := backupCipher(password, data[4:20])
	if err != nil {
		return nil, err
	}
	headerLength := 20 + aead.NonceSize()
	plain, err := aead.Open(nil, data[20:headerLength], data[headerLength:], data[:headerLength])
	if err != nil {
		return nil, errors.New("backup password is incorrect or backup was modified")
	}
	return plain, nil
}

func renewalDue(certificate *x509.Certificate, now time.Time) bool {
	return !now.Before(certificate.NotAfter.Add(-30 * 24 * time.Hour))
}

func backupCipher(password string, salt []byte) (cipher.AEAD, error) {
	key, err := pbkdf2.Key(sha256.New, password, salt, 600_000, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func certificateSerial() (*big.Int, error) {
	number, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	return number.Add(number, big.NewInt(1)), nil
}

func publicCertificatePEM(certificate *x509.Certificate) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
}

func sameAuthority(left, right string) bool {
	first, _ := pem.Decode([]byte(left))
	second, _ := pem.Decode([]byte(right))
	return first != nil && second != nil && first.Type == "CERTIFICATE" && second.Type == "CERTIFICATE" && bytes.Equal(first.Bytes, second.Bytes)
}

func privateKeyPEM(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func (authority *certificateAuthority) marshal() ([]byte, error) {
	key, err := privateKeyPEM(authority.key)
	if err != nil {
		return nil, err
	}
	return append(publicCertificatePEM(authority.certificate), key...), nil
}

func parseAuthority(data []byte) (*certificateAuthority, error) {
	certificateBlock, rest := pem.Decode(data)
	keyBlock, _ := pem.Decode(rest)
	if certificateBlock == nil || keyBlock == nil {
		return nil, errors.New("authority material is incomplete")
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil || !certificate.IsCA {
		return nil, errors.New("authority certificate is invalid")
	}
	value, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	key, ok := value.(*ecdsa.PrivateKey)
	if err != nil || !ok || !key.PublicKey.Equal(certificate.PublicKey) {
		return nil, errors.New("authority key does not match its certificate")
	}
	return &certificateAuthority{certificate: certificate, key: key}, nil
}

func loadAuthority(directory string) (*certificateAuthority, error) {
	data, err := os.ReadFile(filepath.Join(directory, "authority.pem"))
	if err != nil {
		return nil, err
	}
	return parseAuthority(data)
}

func saveLeaf(directory string, key *ecdsa.PrivateKey, leafDER []byte, rootPEM []byte, host string) (*tls.Certificate, error) {
	pair, material, err := prepareLeaf(key, leafDER, rootPEM, host)
	if err != nil { return nil, err }
	if err := writePrivateFile(filepath.Join(directory, "leaf.pem"), material); err != nil { return nil, err }
	return pair, nil
}

func prepareLeaf(key *ecdsa.PrivateKey, leafDER []byte, rootPEM []byte, host string) (*tls.Certificate, []byte, error) {
	leaf, err := x509.ParseCertificate(leafDER)
	if err != nil {
		return nil, nil, errors.New("invalid issued certificate")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(rootPEM) {
		return nil, nil, errors.New("invalid issuing authority")
	}
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: roots}); err != nil {
		return nil, nil, errors.New("issued certificate does not authenticate this installation")
	}
	privatePEM, err := privateKeyPEM(key)
	if err != nil {
		return nil, nil, err
	}
	certPEM := append(publicCertificatePEM(leaf), rootPEM...)
	pair, err := tls.X509KeyPair(certPEM, privatePEM)
	if err != nil {
		return nil, nil, err
	}
	pair.Leaf = leaf
	return &pair, certPEM, nil
}
