// No exports. Verify parent EOF and explicit cancellation release pending sidecar work.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestPipeBurstDoesNotKillIndependentChecks(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	started := make(chan struct{}, 32)
	result := make(chan error, 1)
	go func() {
		result <- serveProtocol(context.Background(), reader, io.Discard, func(ctx context.Context, request pipeRequest) (json.RawMessage, error) {
			started <- struct{}{}
			<-ctx.Done()
			return nil, ctx.Err()
		})
	}()
	for index := range 32 {
		if _, err := fmt.Fprintf(writer, "{\"id\":\"%d\",\"action\":\"retry\",\"payload\":{}}\n", index); err != nil {
			t.Fatal(err)
		}
		select {
		case <-started:
		case err := <-result:
			t.Fatalf("connection burst killed active checks: %v", err)
		}
	}
	writer.Close()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestMembershipAcknowledgementBypassesWaitingActionsAndSurvivesCallerCancellation(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		for _, accepted := range []bool{false, true} {
			ctx, cancel := context.WithCancel(context.Background())
			reader, writer := io.Pipe()
			owner := &networkProcess{ctx: ctx, cancel: cancel, output: writer}
			previous := networkMember{NodeID: "node", Label: "desktop", KeyFingerprint: strings.Repeat("a", 64), Addresses: []string{"100.80.0.1"}}
			next := previous
			next.Rename = &networkRename{ID: "ffecbbf7-697b-42cf-ae46-dbcfe74a126d", From: "desktop", To: "desk"}
			owner.config.Configuration.Members = []networkMember{previous}
			caller, stop := context.WithCancel(ctx)
			result := make(chan error, 1)
			owner.actions.Lock()
			go func() { result <- owner.persistMember(caller, &previous, next) }()
			var event struct { ID string `json:"id"` }
			if err := json.NewDecoder(reader).Decode(&event); err != nil { t.Fatal(err) }
			if cancelled {
				stop()
				if err := <-result; !errors.Is(err, context.Canceled) { t.Fatal("cancelled caller did not finish", err) }
			}
			body, err := json.Marshal(struct {
				RequestID string `json:"requestId"`
				Accepted bool `json:"accepted"`
			}{event.ID, accepted})
			if err != nil { t.Fatal(err) }
			if _, err := owner.dispatch(ctx, pipeRequest{Action: "persist-member-result", Payload: body}); err != nil { t.Fatal(err) }
			owner.actions.Unlock()
			if !cancelled {
				err := <-result
				if (err == nil) != accepted { t.Fatal("persistence rejection was not propagated", err) }
			}
			want := previous
			if accepted { want = next }
			if !sameMember(&owner.members()[0], &want) { t.Fatal("acknowledgement did not reconcile durable membership") }
			stop()
			cancel()
			reader.Close()
			writer.Close()
		}
	}
}

func TestPipeEOFCancelsActiveOperation(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	started := make(chan struct{})
	released := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- serveProtocol(context.Background(), reader, io.Discard, func(ctx context.Context, request pipeRequest) (json.RawMessage, error) {
			close(started)
			<-ctx.Done()
			close(released)
			return nil, ctx.Err()
		})
	}()
	written := make(chan error, 1)
	go func() {
		_, err := io.WriteString(writer, "{\"id\":\"one\",\"action\":\"join\",\"payload\":{}}\n")
		written <- err
	}()
	select {
	case <-started:
	case err := <-result:
		t.Fatalf("protocol ended before dispatch: %v", err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	select {
	case <-released:
	default:
		t.Fatal("parent disconnect returned without disposing the active operation")
	}
}

func TestPipeRejectsMalformedInputWithoutEchoingSecrets(t *testing.T) {
	var output bytes.Buffer
	err := serveProtocol(context.Background(), io.NopCloser(strings.NewReader(
		"{\"id\":\"one\",\"action\":\"join\",\"payload\":{},\"secret\":\"PRIVATE\"}\n",
	)), &output, func(context.Context, pipeRequest) (json.RawMessage, error) {
		t.Fatal("invalid request reached the owner")
		return nil, nil
	})
	if err == nil || strings.Contains(err.Error(), "PRIVATE") || strings.Contains(output.String(), "PRIVATE") {
		t.Fatal("malformed input must fail without reflecting its payload")
	}
}

func TestPipeCancellationDoesNotCancelIndependentRequest(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	started := make(chan struct{})
	cancelled := make(chan struct{})
	completed := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- serveProtocol(context.Background(), reader, io.Discard, func(ctx context.Context, request pipeRequest) (json.RawMessage, error) {
			if request.ID == "one" {
				close(started)
				<-ctx.Done()
				close(cancelled)
				return nil, ctx.Err()
			}
			if ctx.Err() != nil {
				t.Error("independent request was cancelled")
			}
			close(completed)
			return json.RawMessage(`{}`), nil
		})
	}()
	go func() {
		defer writer.Close()
		if _, err := io.WriteString(writer, "{\"id\":\"one\",\"action\":\"join\",\"payload\":{}}\n"); err != nil {
			return
		}
		<-started
		if _, err := io.WriteString(writer, "{\"id\":\"cancel-one\",\"action\":\"cancel\",\"payload\":{\"id\":\"one\"}}\n"); err != nil {
			return
		}
		<-cancelled
		if _, err := io.WriteString(writer, "{\"id\":\"two\",\"action\":\"status\",\"payload\":{}}\n"); err != nil {
			return
		}
		<-completed
	}()
	if err := <-result; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case <-completed:
	default:
		t.Fatal("independent request never completed")
	}
}
