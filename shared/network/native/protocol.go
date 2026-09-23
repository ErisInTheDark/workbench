// No exports. Own bounded request framing, cancellation and parent-disconnect cleanup.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"sync"
)

type pipeRequest struct {
	ID      string          `json:"id"`
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload"`
}

type pipeResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type pipeDispatch func(context.Context, pipeRequest) (json.RawMessage, error)

type issuerAddress struct {
	Address  string `json:"address"`
	Hostname string `json:"hostname"`
}

type privateConfiguration struct {
	rename *networkRename
	Role    string         `json:"role"`
	Enabled bool           `json:"enabled"`
	Label   string         `json:"label"`
	NodeLabel string       `json:"nodeLabel,omitempty"`
	Issuer  *issuerAddress `json:"issuer,omitempty"`
}

type hostConfiguration struct {
	Enabled bool   `json:"enabled"`
	Port    uint16 `json:"port"`
}

type networkConfiguration struct {
	Mode          string               `json:"mode,omitempty"`
	HostServe     hostConfiguration     `json:"hostServe"`
	PrivateAccess *privateConfiguration `json:"privateAccess"`
	Members       []networkMember       `json:"members"`
	Rename        *networkRename       `json:"rename,omitempty"`
	Group         *networkGroup        `json:"group,omitempty"`
}

type networkRename struct {
	ID string `json:"id"`
	From string `json:"from"`
	To string `json:"to"`
	Phase string `json:"phase,omitempty"`
}

type hostIdentity struct {
	NodeID *string `json:"nodeId,omitempty"`
	Hostname *string `json:"hostname"`
	Address *string `json:"address"`
}

type sidecarConfiguration struct {
	RetainedHostPort uint16 `json:"retainedHostPort,omitempty"`
	IngressToken string `json:"ingressToken,omitempty"`
	DaemonIngressToken string `json:"daemonIngressToken,omitempty"`
	Configuration networkConfiguration `json:"configuration"`
	AppOrigin     string               `json:"appOrigin"`
	DaemonOrigin  string               `json:"daemonOrigin"`
	DaemonPort    *uint16              `json:"daemonPort"`
	PublishDaemon bool                `json:"publishDaemon,omitempty"`
	PrivateAppAllowed *bool           `json:"privateAppAllowed,omitempty"`
	Preparing     bool                 `json:"preparing"`
}

type modeStatus struct {
	Phase   string  `json:"phase"`
	Message *string `json:"message"`
	URL     *string `json:"url"`
}

type privateStatus struct {
	Discovery string `json:"discovery,omitempty"`
	Networks []networkCandidate `json:"networks,omitempty"`
	Devices []networkDevice `json:"devices,omitempty"`
	PendingUpdates []string `json:"pendingUpdates,omitempty"`
	modeStatus
	DaemonURL            *string          `json:"daemonUrl"`
	Hostname             *string          `json:"hostname"`
	LoginURL             *string          `json:"loginUrl"`
	NodeID               *string          `json:"nodeId"`
	KeyFingerprint       *string          `json:"keyFingerprint"`
	Addresses            []string         `json:"addresses"`
	RootCertificate      *string          `json:"rootCertificate"`
	RootFingerprint      *string          `json:"rootFingerprint"`
	CertificateExpiresAt *string          `json:"certificateExpiresAt"`
	Pending              []pairingRequest `json:"pending"`
}

type networkRuntime struct {
	HostServe     modeStatus    `json:"hostServe"`
	DaemonServe   modeStatus    `json:"daemonServe"`
	Host          hostIdentity `json:"host"`
	PrivateAccess privateStatus `json:"privateAccess"`
}

type actionResult struct {
	Kind          string                `json:"kind"`
	Code          string                `json:"code,omitempty"`
	PrivateAccess *privateConfiguration `json:"privateAccess,omitempty"`
	Members       *[]networkMember      `json:"members,omitempty"`
	Group         *networkGroup         `json:"group,omitempty"`
}

type networkPersistence struct {
	configuration networkConfiguration
	result chan error
}

func (owner *networkProcess) persistNetwork(ctx context.Context, previousRevision *uint64, configuration networkConfiguration) error {
	if err := ctx.Err(); err != nil { return err }
	if err := owner.ctx.Err(); err != nil { return err }
	owner.persistenceMu.Lock()
	if owner.networkPersistence == nil { owner.networkPersistence = make(map[string]*networkPersistence) }
	if len(owner.networkPersistence) >= 256 {
		owner.persistenceMu.Unlock()
		return errors.New("too many network changes are awaiting persistence")
	}
	owner.nextPersistence++
	id := strconv.FormatUint(owner.nextPersistence, 10)
	pending := &networkPersistence{configuration: configuration, result: make(chan error, 1)}
	owner.networkPersistence[id] = pending
	owner.persistenceMu.Unlock()
	message := struct {
		Event string `json:"event"`
		ID string `json:"id"`
		PreviousRevision *uint64 `json:"previousRevision"`
		Configuration networkConfiguration `json:"configuration"`
	}{"persist-network", id, previousRevision, configuration}
	if err := json.NewEncoder(owner.output).Encode(message); err != nil {
		owner.cancel()
		return errors.New("network persistence request could not reach the parent")
	}
	select {
	case <-ctx.Done(): return ctx.Err()
	case <-owner.ctx.Done(): return owner.ctx.Err()
	case err := <-pending.result: return err
	}
}

func (owner *networkProcess) acknowledgeNetwork(payload []byte) (json.RawMessage, error) {
	var acknowledgement struct {
		RequestID string `json:"requestId"`
		Accepted bool `json:"accepted"`
	}
	if err := decodePipeValue(payload, &acknowledgement); err != nil { return nil, err }
	owner.persistenceMu.Lock()
	pending := owner.networkPersistence[acknowledgement.RequestID]
	delete(owner.networkPersistence, acknowledgement.RequestID)
	owner.persistenceMu.Unlock()
	if pending == nil { return nil, errors.New("unknown network persistence acknowledgement") }
	var result error
	if !acknowledgement.Accepted {
		result = errors.New("parent declined durable network persistence")
	} else {
		owner.mu.Lock()
		current := owner.config.Configuration.Group
		next := pending.configuration.Group
		if current == nil || (next != nil && current.ID == next.ID && current.Revision <= next.Revision) {
			configuration := pending.configuration
			local := owner.config.Configuration
			configuration.Mode, configuration.HostServe, configuration.Rename = local.Mode, local.HostServe, local.Rename
			if configuration.PrivateAccess != nil && local.PrivateAccess != nil {
				settings := *configuration.PrivateAccess
				settings.Label, settings.NodeLabel, settings.rename = local.PrivateAccess.Label, local.PrivateAccess.NodeLabel, local.Rename
				settings.Enabled = local.Mode == "tailnet-service" && settings.Role != "unconfigured"
				configuration.PrivateAccess = &settings
			}
			owner.config.Configuration = configuration
		}
		owner.mu.Unlock()
	}
	pending.result <- result
	return json.RawMessage(`{"kind":"ok"}`), nil
}

type memberPersistence struct {
	previous *networkMember
	member networkMember
	result chan error
}

func sameMember(left, right *networkMember) bool {
	if left == nil || right == nil { return left == right }
	if left.NodeID != right.NodeID || left.HostNodeID != right.HostNodeID || left.Label != right.Label || left.KeyFingerprint != right.KeyFingerprint || !slices.Equal(left.Addresses, right.Addresses) {
		return false
	}
	if (left.Published == nil) != (right.Published == nil) || (left.Published != nil && *left.Published != *right.Published) { return false }
	if left.Rename == nil || right.Rename == nil { return left.Rename == right.Rename }
	return *left.Rename == *right.Rename
}

func (owner *networkProcess) persistMember(ctx context.Context, previous *networkMember, member networkMember) error {
	if err := ctx.Err(); err != nil { return err }
	if err := owner.ctx.Err(); err != nil { return err }
	owner.persistenceMu.Lock()
	if owner.persistence == nil { owner.persistence = make(map[string]*memberPersistence) }
	if len(owner.persistence) >= 256 {
		owner.persistenceMu.Unlock()
		return errors.New("too many membership changes are awaiting persistence")
	}
	owner.nextPersistence++
	id := strconv.FormatUint(owner.nextPersistence, 10)
	pending := &memberPersistence{previous: previous, member: member, result: make(chan error, 1)}
	owner.persistence[id] = pending
	owner.persistenceMu.Unlock()
	message := struct {
		Event string `json:"event"`
		ID string `json:"id"`
		Previous *networkMember `json:"previous"`
		Member networkMember `json:"member"`
	}{Event: "persist-member", ID: id, Previous: previous, Member: member}
	if err := json.NewEncoder(owner.output).Encode(message); err != nil {
		owner.cancel()
		return errors.New("membership persistence request could not reach the parent")
	}
	// Cancellation ends the caller's work, not the already-submitted SQL write.
	// Retain its bounded entry until acknowledgement or process shutdown.
	select {
	case <-ctx.Done(): return ctx.Err()
	case <-owner.ctx.Done(): return owner.ctx.Err()
	case err := <-pending.result: return err
	}
}

func (owner *networkProcess) acknowledgeMember(payload []byte) (json.RawMessage, error) {
	var acknowledgement struct {
		RequestID string `json:"requestId"`
		Accepted bool `json:"accepted"`
	}
	if err := decodePipeValue(payload, &acknowledgement); err != nil { return nil, err }
	owner.persistenceMu.Lock()
	pending := owner.persistence[acknowledgement.RequestID]
	delete(owner.persistence, acknowledgement.RequestID)
	owner.persistenceMu.Unlock()
	if pending == nil { return nil, errors.New("unknown membership persistence acknowledgement") }
	var result error
	if !acknowledgement.Accepted {
		result = errors.New("parent declined durable membership persistence")
	} else {
		owner.mu.Lock()
		var current *networkMember
		for _, member := range owner.config.Configuration.Members {
			if member.NodeID == pending.member.NodeID { copy := member; current = &copy; break }
		}
		// A newer configure message may already include a later durable value.
		if sameMember(current, pending.previous) {
			owner.config.Configuration.Members, result = replaceMember(owner.config.Configuration.Members, pending.member)
			if result == nil && owner.config.Configuration.Group != nil {
				group := *owner.config.Configuration.Group
				group.Revision++
				owner.config.Configuration.Group = &group
			}
		}
		owner.mu.Unlock()
	}
	pending.result <- result
	return json.RawMessage(`{"kind":"ok"}`), nil
}

func serveProtocol(parent context.Context, input io.ReadCloser, output io.Writer, dispatch pipeDispatch) (result error) {
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	var stateMu sync.Mutex
	var outputMu sync.Mutex
	var outputError error
	active := make(map[string]context.CancelFunc)
	inputClosed := make(chan error, 1)
	stopClose := context.AfterFunc(ctx, func() { inputClosed <- input.Close() })
	defer func() {
		cancel()
		if !stopClose() {
			result = errors.Join(result, <-inputClosed)
		} else {
			result = errors.Join(result, input.Close())
		}
		workers.Wait()
		result = errors.Join(result, outputError)
	}()
	respond := func(response pipeResponse) {
		outputMu.Lock()
		defer outputMu.Unlock()
		if outputError != nil {
			return
		}
		if err := json.NewEncoder(output).Encode(response); err != nil {
			outputError = errors.New("parent response pipe failed")
			cancel()
		}
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	for scanner.Scan() {
		var request pipeRequest
		if err := decodePipeValue(scanner.Bytes(), &request); err != nil || request.ID == "" || len(request.ID) > 64 || request.Action == "" || len(request.Action) > 64 || len(request.Payload) == 0 {
			return errors.New("invalid network command envelope")
		}
		if request.Action == "cancel" {
			var payload struct {
				ID string `json:"id"`
			}
			if err := decodePipeValue(request.Payload, &payload); err != nil || payload.ID == "" {
				return errors.New("invalid network cancellation command")
			}
			stateMu.Lock()
			if stop := active[payload.ID]; stop != nil {
				stop()
			}
			stateMu.Unlock()
			respond(pipeResponse{ID: request.ID, Result: json.RawMessage(`{"kind":"ok"}`)})
			continue
		}
		stateMu.Lock()
		if active[request.ID] != nil {
			stateMu.Unlock()
			return errors.New("duplicate pending network command")
		}
		requestContext, stop := context.WithCancel(ctx)
		active[request.ID] = stop
		stateMu.Unlock()
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer stop()
			value, err := dispatch(requestContext, request)
			response := pipeResponse{ID: request.ID, Result: value}
			if err != nil {
				response.Result = nil
				response.Error = err.Error()
				if len(response.Error) > 512 {
					response.Error = response.Error[:512]
				}
			}
			respond(response)
			stateMu.Lock()
			delete(active, request.ID)
			stateMu.Unlock()
		}()
	}
	if scanner.Err() != nil && ctx.Err() == nil {
		return errors.New("network command pipe failed or exceeded its frame limit")
	}
	return nil
}

func decodePipeValue[T any](data []byte, value *T) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("invalid network command data")
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF {
		return errors.New("network command contains trailing data")
	}
	return nil
}
