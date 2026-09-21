// No exports. Own private Windows permissions and explicit current-user certificate trust.
package main

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func trustCurrentUserRoot(encoded []byte) (result error) {
	block, _ := pem.Decode(encoded)
	if block == nil {
		return errors.New("private root certificate is invalid")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !certificate.IsCA {
		return errors.New("private root certificate is invalid")
	}
	name, err := windows.UTF16PtrFromString("ROOT")
	if err != nil {
		return err
	}
	store, err := windows.CertOpenStore(windows.CERT_STORE_PROV_SYSTEM_W, 0, 0, windows.CERT_SYSTEM_STORE_CURRENT_USER, uintptr(unsafe.Pointer(name)))
	if err != nil {
		return errors.New("Windows current-user certificate store could not be opened")
	}
	defer func() { result = errors.Join(result, windows.CertCloseStore(store, 0)) }()
	context, err := windows.CertCreateCertificateContext(windows.X509_ASN_ENCODING, &block.Bytes[0], uint32(len(block.Bytes)))
	if err != nil {
		return errors.New("Windows could not read the private root certificate")
	}
	defer func() { result = errors.Join(result, windows.CertFreeCertificateContext(context)) }()
	if err := windows.CertAddCertificateContextToStore(store, context, windows.CERT_STORE_ADD_REPLACE_EXISTING, nil); err != nil {
		return errors.New("Windows did not accept the private root in its current-user trust store")
	}
	return nil
}

func protectPrivatePath(path string, directory bool) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	descriptor, err := windows.SecurityDescriptorFromString(
		"D:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;BA)(A;" + flags + ";FA;;;" + user.User.Sid.String() + ")",
	)
	if err != nil {
		return err
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}
