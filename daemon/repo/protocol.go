// No exports. Own bounded JSON-line request framing, per-request cancellation and parent-disconnect shutdown.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

const maxRequestLine = 1 << 20

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

type pipeDispatch func(ctx context.Context, action string, payload json.RawMessage) (any, error)

type protocolWriter struct {
	mu     sync.Mutex
	output io.Writer
}

func (writer *protocolWriter) send(response pipeResponse) error {
	encoded, err := json.Marshal(response)
	if err != nil {
		return err
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	_, err = writer.output.Write(append(encoded, '\n'))
	return err
}

func boundedMessage(err error) string {
	message := err.Error()
	if errors.Is(err, context.Canceled) {
		message = "request was cancelled"
	}
	if len(message) > 500 {
		message = message[:500] + "..."
	}
	return message
}

// serveProtocol returns when input ends or ctx ends, after every in-flight request settles.
func serveProtocol(ctx context.Context, input io.Reader, output io.Writer, dispatch pipeDispatch) error {
	ctx, cancelAll := context.WithCancel(ctx)
	defer cancelAll()
	writer := &protocolWriter{output: output}
	var mu sync.Mutex
	inflight := make(map[string]context.CancelFunc)
	var group sync.WaitGroup
	lines := make(chan []byte)
	readFailure := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 64*1024), maxRequestLine)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
		readFailure <- scanner.Err()
	}()
	finish := func(err error) error {
		cancelAll()
		group.Wait()
		return err
	}
	for {
		var line []byte
		select {
		case <-ctx.Done():
			return finish(nil)
		case err := <-readFailure:
			return finish(err)
		case line = <-lines:
		}
		var request pipeRequest
		if err := json.Unmarshal(line, &request); err != nil || request.ID == "" || request.Action == "" {
			return finish(errors.New("invalid request frame"))
		}
		if request.Action == "cancel" {
			var payload struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(request.Payload, &payload) == nil {
				mu.Lock()
				if cancel := inflight[payload.ID]; cancel != nil {
					cancel()
				}
				mu.Unlock()
			}
			if err := writer.send(pipeResponse{ID: request.ID, Result: json.RawMessage("{}")}); err != nil {
				return finish(err)
			}
			continue
		}
		mu.Lock()
		if inflight[request.ID] != nil {
			mu.Unlock()
			if err := writer.send(pipeResponse{ID: request.ID, Error: "duplicate request id"}); err != nil {
				return finish(err)
			}
			continue
		}
		requestCtx, cancel := context.WithCancel(ctx)
		inflight[request.ID] = cancel
		mu.Unlock()
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := dispatch(requestCtx, request.Action, request.Payload)
			mu.Lock()
			delete(inflight, request.ID)
			mu.Unlock()
			cancel()
			response := pipeResponse{ID: request.ID}
			if err != nil {
				response.Error = boundedMessage(err)
			} else if encoded, encodeErr := json.Marshal(result); encodeErr != nil {
				response.Error = "response could not be encoded"
			} else {
				response.Result = encoded
			}
			if writer.send(response) != nil {
				// Losing the parent pipe ends the process rather than leaving mounts unowned.
				cancelAll()
			}
		}()
	}
}

func decodeStrict(payload json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid request payload")
	}
	return nil
}
