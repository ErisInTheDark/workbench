package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
)

type protocolHarness struct {
	input    *io.PipeWriter
	output   *bufio.Scanner
	finished chan error
}

func startProtocol(t *testing.T, dispatch pipeDispatch) protocolHarness {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	finished := make(chan error, 1)
	go func() {
		finished <- serveProtocol(context.Background(), inputReader, outputWriter, dispatch)
		_ = outputWriter.Close()
	}()
	return protocolHarness{input: inputWriter, output: bufio.NewScanner(outputReader), finished: finished}
}

func (harness protocolHarness) send(t *testing.T, id string, action string, payload string) {
	t.Helper()
	if _, err := io.WriteString(harness.input, `{"id":"`+id+`","action":"`+action+`","payload":`+payload+"}\n"); err != nil {
		t.Fatal(err)
	}
}

func (harness protocolHarness) receive(t *testing.T) pipeResponse {
	t.Helper()
	if !harness.output.Scan() {
		t.Fatal("protocol closed before responding")
	}
	var response pipeResponse
	if err := json.Unmarshal(harness.output.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestProtocolCancelsOneRequestAndKeepsServing(t *testing.T) {
	started := make(chan struct{})
	harness := startProtocol(t, func(ctx context.Context, action string, _ json.RawMessage) (any, error) {
		if action == "slow" {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return map[string]string{"echo": action}, nil
	})
	harness.send(t, "1", "slow", "{}")
	<-started
	harness.send(t, "2", "cancel", `{"id":"1"}`)
	responses := map[string]pipeResponse{}
	for len(responses) < 2 {
		response := harness.receive(t)
		responses[response.ID] = response
	}
	if responses["1"].Error != "request was cancelled" || string(responses["2"].Result) != "{}" {
		t.Fatalf("unexpected cancel responses %+v", responses)
	}
	harness.send(t, "3", "ping", "{}")
	if response := harness.receive(t); response.ID != "3" || string(response.Result) != `{"echo":"ping"}` {
		t.Fatalf("unexpected response %+v", response)
	}
	_ = harness.input.Close()
	if err := <-harness.finished; err != nil {
		t.Fatalf("closing input should end cleanly, got %v", err)
	}
}

func TestProtocolParentDisconnectCancelsInFlightWork(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	harness := startProtocol(t, func(ctx context.Context, _ string, _ json.RawMessage) (any, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		return nil, ctx.Err()
	})
	harness.send(t, "1", "slow", "{}")
	<-started
	_ = harness.input.Close()
	go func() {
		for harness.output.Scan() {
		}
	}()
	<-cancelled
	if err := <-harness.finished; err != nil {
		t.Fatal(err)
	}
}

func TestProtocolRejectsMalformedFrames(t *testing.T) {
	harness := startProtocol(t, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("unreachable")
	})
	if _, err := io.WriteString(harness.input, "not json\n"); err != nil {
		t.Fatal(err)
	}
	if err := <-harness.finished; err == nil {
		t.Fatal("a malformed frame should end the protocol with an error")
	}
}
