// No exports. Own durable two-party certificate-authority handover without moving DNS.
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

func nextOwnershipDirectory(directory networkDirectory, operation, target, phase string) (networkDirectory, error) {
	current := directory.Group.Transfer
	if phase == "prepare" {
		if operation == "" || target == directory.Group.OwnerNodeID ||
			(current != nil && current.Phase != "activated") {
			return directory, errors.New("another ownership transfer is pending or the target already owns this network")
		}
		directory.Group.Transfer = &ownershipTransfer{
			ID: operation, FromNodeID: directory.Group.OwnerNodeID, ToNodeID: target, Phase: phase,
		}
	} else {
		if current == nil || current.ID != operation || current.ToNodeID != target ||
			!((current.Phase == "prepare" && phase == "relinquished") ||
				(current.Phase == "relinquished" && phase == "activated")) {
			return directory, errors.New("ownership transfer must prepare, relinquish, then activate")
		}
		next := *current
		next.Phase = phase
		directory.Group.Transfer = &next
		if phase == "activated" { directory.Group.OwnerNodeID = target }
	}
	directory.Group.Revision++
	return directory, directory.validate()
}

type transferRequest struct {
	Envelope directoryEnvelope `json:"envelope"`
	Authority []byte `json:"authority,omitempty"`
}

func (group *networkGroupController) transferOwner(ctx context.Context, targetID string) error {
	group.mu.Lock()
	defer group.mu.Unlock()
	directory := group.directory()
	self := group.node.snapshot().NodeID
	if directory == nil || self == nil || directory.Group.OwnerNodeID != *self {
		return errors.New("only the current owner can transfer network ownership")
	}
	var target *networkMember
	for _, member := range directory.Members {
		if member.NodeID == targetID { copy := member; target = &copy }
	}
	if target == nil || targetID == *self { return errors.New("choose another enrolled app") }
	transfer := directory.Group.Transfer
	if transfer == nil || transfer.Phase == "activated" {
		id, err := newGroupID()
		if err != nil { return errors.New("ownership transfer identity could not be created") }
		next, err := nextOwnershipDirectory(*directory, id, targetID, "prepare")
		if err != nil { return err }
		if err := group.store(ctx, next); err != nil { return err }
		directory = &next
		transfer = next.Group.Transfer
	}
	if transfer.ToNodeID != targetID { return errors.New("complete the pending ownership transfer first") }
	ca, err := loadAuthority(group.node.directory)
	if err != nil { return errors.New("current owner signing key is unavailable") }
	if transfer.Phase == "prepare" {
		material, err := ca.marshal()
		if err != nil { return err }
		envelope, err := signDirectory(*directory, ca)
		if err != nil { return err }
		if err := group.request(ctx, *target, "/transfer/prepare", transferRequest{Envelope: envelope, Authority: material}, nil); err != nil {
			return errors.New("new owner has not durably prepared the handover; retry when it is available")
		}
		next, err := nextOwnershipDirectory(*directory, transfer.ID, targetID, "relinquished")
		if err != nil { return err }
		if err := group.store(ctx, next); err != nil { return err }
		directory = &next
		transfer = next.Group.Transfer
	}
	envelope, err := signDirectory(*directory, ca)
	if err != nil { return err }
	var activated directoryEnvelope
	if err := group.request(ctx, *target, "/transfer/activate", transferRequest{Envelope: envelope}, &activated); err != nil {
		return errors.New("ownership is relinquished and awaiting the new app; retry this handover, do not create another network")
	}
	if err := activated.verify(envelope.Root, targetID); err != nil { return err }
	receipt := activated.Directory.Group.Transfer
	if receipt == nil || receipt.ID != transfer.ID || receipt.Phase != "activated" ||
		activated.Directory.Group.DNSNodeID != directory.Group.DNSNodeID {
		return errors.New("new owner returned an invalid handover acknowledgement")
	}
	if err := group.store(ctx, activated.Directory); err != nil { return err }
	return removePrivateFile(filepath.Join(group.node.directory, "authority.pem"))
}

func (group *networkGroupController) acceptTransfer(ctx context.Context, peerID, phase string, input transferRequest) (directoryEnvelope, error) {
	root := group.node.snapshot().RootCertificate
	self := group.node.snapshot().NodeID
	current := group.directory()
	directory := input.Envelope.Directory
	transfer := directory.Group.Transfer
	if root == nil || self == nil || current == nil || transfer == nil || !renameIDPattern.MatchString(transfer.ID) ||
		transfer.FromNodeID != peerID || transfer.ToNodeID != *self || directory.Group.ID != current.Group.ID ||
		input.Envelope.verify(*root, peerID) != nil {
		return directoryEnvelope{}, errors.New("ownership transfer identity could not be verified")
	}
	staged := filepath.Join(group.node.directory, "owner-transfer-"+transfer.ID+".pem")
	if phase == "activate" && current.Group.Transfer != nil &&
		current.Group.Transfer.ID == transfer.ID && current.Group.Transfer.Phase == "activated" &&
		current.Group.OwnerNodeID == *self {
		if err := removePrivateFile(staged); err != nil { return directoryEnvelope{}, err }
		return group.envelope()
	}
	if current.Group.OwnerNodeID != peerID { return directoryEnvelope{}, errors.New("only the current owner may hand over this network") }
	if phase == "prepare" {
		if transfer.Phase != "prepare" { return directoryEnvelope{}, errors.New("invalid handover preparation") }
		ca, err := parseAuthority(input.Authority)
		if err != nil || !sameAuthority(*root, string(publicCertificatePEM(ca.certificate))) {
			return directoryEnvelope{}, errors.New("handover would replace network trust")
		}
		if err := writePrivateFile(staged, input.Authority); err != nil { return directoryEnvelope{}, err }
		if current.Group.Revision < directory.Group.Revision {
			if err := group.store(ctx, directory); err != nil { return directoryEnvelope{}, err }
		}
		return directoryEnvelope{}, nil
	}
	if phase != "activate" || transfer.Phase != "relinquished" {
		return directoryEnvelope{}, errors.New("old owner must relinquish before activation")
	}
	material, err := os.ReadFile(staged)
	if err != nil { return directoryEnvelope{}, errors.New("prepared owner key is unavailable") }
	ca, err := parseAuthority(material)
	if err != nil || !sameAuthority(*root, string(publicCertificatePEM(ca.certificate))) {
		return directoryEnvelope{}, errors.New("prepared owner key does not match network trust")
	}
	if current.Group.Revision < directory.Group.Revision {
		if err := group.store(ctx, directory); err != nil { return directoryEnvelope{}, err }
	}
	next, err := nextOwnershipDirectory(directory, transfer.ID, *self, "activated")
	if err != nil { return directoryEnvelope{}, err }
	if err := writePrivateFile(filepath.Join(group.node.directory, "authority.pem"), material); err != nil { return directoryEnvelope{}, err }
	if err := group.store(ctx, next); err != nil { return directoryEnvelope{}, err }
	if err := removePrivateFile(staged); err != nil { return directoryEnvelope{}, err }
	return signDirectory(next, ca)
}
