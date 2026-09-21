// No exports. Own authenticated, resumable private URL transitions without replacing node identity or trust.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var renameIDPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func validateRename(rename networkRename) error {
	if !renameIDPattern.MatchString(rename.ID) || rename.From == rename.To || rename.Phase != "" {
		return errors.New("invalid URL rename operation")
	}
	if _, err := machineHostname(rename.From); err != nil { return err }
	if _, err := machineHostname(rename.To); err != nil { return err }
	return nil
}

func (authority *networkAuthority) rename(ctx context.Context, action string, rename networkRename) error {
	if err := validateRename(rename); err != nil { return err }
	node := authority.node
	node.certificates.Lock()
	defer node.certificates.Unlock()
	settings := node.settings.Load()
	oldHost, _ := machineHostname(rename.From)
	newHost, _ := machineHostname(rename.To)
	pendingPath := filepath.Join(node.directory, "rename-"+rename.ID+".pem")
	if settings.Role == "unconfigured" {
		if node.certificate() != nil { return errors.New("finish private setup before renaming its certificate") }
		if action == "rename-activate" { return node.present(newHost, []string{newHost, oldHost}, nil) }
		if action == "rename-retire" { return node.present(newHost, []string{newHost}, nil) }
		return nil
	}
	switch action {
	case "rename-prepare":
		root := node.snapshot().RootCertificate
		if root == nil { return errors.New("private setup trust is unavailable") }
		key, request, err := persistentLeafRequest(node.directory, newHost)
		if err != nil { return err }
		response, err := authority.requestRename(ctx, "prepare", rename, request)
		if err != nil { return err }
		certificate, material, err := prepareLeaf(key, response.Certificate, []byte(*root), newHost)
		if err != nil { return err }
		if certificate.Leaf.VerifyHostname(oldHost) != nil {
			return errors.New("rename certificate does not retain the old working address")
		}
		if settings.Role == "authority" && certificate.Leaf.VerifyHostname(node.controlHostname()) != nil {
			return errors.New("rename certificate lost the stable setup control name")
		}
		return writePrivateFile(pendingPath, material)
	case "rename-activate":
		material, err := os.ReadFile(pendingPath)
		if err != nil { return errors.New("prepared rename certificate is unavailable; retry preparation") }
		key, err := os.ReadFile(filepath.Join(node.directory, "leaf-key.pem"))
		if err != nil { return errors.New("private machine key is unavailable") }
		certificate, err := tls.X509KeyPair(material, key)
		if err != nil { return errors.New("prepared rename certificate is invalid") }
		details, err := privateCertificateDetails(&certificate, newHost)
		if err != nil { return err }
		root := node.snapshot().RootCertificate
		if root == nil || details.RootCertificate == nil || !sameAuthority(*root, *details.RootCertificate) ||
			certificate.Leaf.VerifyHostname(oldHost) != nil {
			return errors.New("prepared rename certificate changed trust or lost the previous address")
		}
		if settings.Role == "authority" && certificate.Leaf.VerifyHostname(node.controlHostname()) != nil {
			return errors.New("prepared rename certificate lost the stable setup control name")
		}
		if err := writePrivateFile(filepath.Join(node.directory, "leaf.pem"), material); err != nil { return err }
		return node.present(newHost, []string{newHost, oldHost}, &certificate)
	case "rename-retire":
		certificate := node.certificate()
		if node.hostname() != newHost || certificate == nil || certificate.Leaf.VerifyHostname(newHost) != nil {
			return errors.New("activate the new private address before retiring the old one")
		}
		_, request, err := persistentLeafRequest(node.directory, newHost)
		if err != nil { return err }
		if _, err := authority.requestRename(ctx, "retire", rename, request); err != nil { return err }
		if err := node.present(newHost, []string{newHost}, certificate); err != nil { return err }
		if err := os.Remove(pendingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.New("retired rename certificate could not be removed")
		}
		return nil
	default:
		return errors.New("unsupported URL rename phase")
	}
}

func (authority *networkAuthority) requestRename(ctx context.Context, phase string, rename networkRename, request []byte) (certificateResponse, error) {
	settings := authority.node.settings.Load()
	status := authority.node.snapshot()
	if settings.Role == "authority" {
		if status.NodeID == nil { return certificateResponse{}, errors.New("private node identity is unavailable") }
		return authority.renameMember(ctx, phase, *status.NodeID, status.Addresses, request, rename)
	}
	if settings.Issuer == nil || status.RootCertificate == nil {
		return certificateResponse{}, errors.New("private setup is incomplete")
	}
	return authority.requestIssuer(ctx, *settings.Issuer, *status.RootCertificate, "/_workbench-network/rename-"+phase,
		certificateRequest{Label: rename.To, Request: request, Rename: &rename})
}

func (authority *networkAuthority) renameMember(ctx context.Context, phase, nodeID string, addresses []string, request []byte, rename networkRename) (certificateResponse, error) {
	if group := authority.node.group; group != nil {
		group.mu.Lock()
		defer group.mu.Unlock()
		directory := group.directory()
		if directory != nil && directory.Group.Transfer != nil && directory.Group.Transfer.Phase != "activated" {
			return certificateResponse{}, errors.New("finish ownership handover before renaming an app")
		}
	}
	if err := validateRename(rename); err != nil { return certificateResponse{}, err }
	if phase != "prepare" && phase != "retire" { return certificateResponse{}, errors.New("invalid issuer rename phase") }
	proposed, err := memberFromRequest(nodeID, rename.To, addresses, request)
	if err != nil { return certificateResponse{}, err }
	authority.membership.Lock()
	defer authority.membership.Unlock()
	members := authority.members()
	var existing *networkMember
	for _, member := range members {
		if member.NodeID == nodeID { copy := member; existing = &copy; break }
	}
	if existing == nil || existing.KeyFingerprint != proposed.KeyFingerprint {
		return certificateResponse{}, errors.New("rename requires the enrolled node and its existing key")
	}
	// A lost final acknowledgement must not remove an arbitrary old name again.
	if existing.Label == rename.To && existing.Rename == nil && phase == "retire" {
		if authority.publishDirectory != nil {
			if err := authority.publishDirectory(ctx); err != nil { return certificateResponse{}, err }
		}
		return certificateResponse{}, nil
	}
	if existing.Label != rename.From || (existing.Rename != nil && *existing.Rename != rename) {
		return certificateResponse{}, errors.New("rename differs from the member's current address or pending operation")
	}
	for _, member := range members {
		if member.NodeID == nodeID { continue }
		if member.Label == rename.To || (member.Rename != nil && (member.Rename.To == rename.To || member.Rename.From == rename.To)) {
			return certificateResponse{}, errors.New("new address belongs to another installation")
		}
	}
	if authority.persist == nil { return certificateResponse{}, errors.New("durable membership owner is unavailable") }
	oldHost, _ := machineHostname(rename.From)
	newHost, _ := machineHostname(rename.To)
	if phase == "prepare" {
		reserved := *existing
		reserved.Rename = &rename
		if !sameMember(existing, &reserved) {
			if err := authority.persist(ctx, existing, reserved); err != nil { return certificateResponse{}, err }
		}
		ca, err := loadAuthority(authority.node.directory)
		if err != nil { return certificateResponse{}, errors.New("setup certificate authority is unavailable") }
		aliases := []string{oldHost}
		if own := authority.node.snapshot().NodeID; own != nil && *own == nodeID {
			aliases = append(aliases, authority.node.controlHostname())
		}
		certificate, err := ca.issue(request, newHost, time.Now(), aliases...)
		if err != nil { return certificateResponse{}, err }
		if authority.publishDirectory != nil {
			if err := authority.publishDirectory(ctx); err != nil { return certificateResponse{}, err }
		}
		return certificateResponse{Certificate: certificate}, nil
	}
	if existing.Rename == nil { return certificateResponse{}, errors.New("prepare the rename before retiring its old address") }
	proposed.HostNodeID = existing.HostNodeID
	proposed.Published = existing.Published
	if err := authority.persist(ctx, existing, proposed); err != nil { return certificateResponse{}, err }
	if authority.publishDirectory != nil {
		if err := authority.publishDirectory(ctx); err != nil { return certificateResponse{}, err }
	}
	return certificateResponse{}, nil
}
