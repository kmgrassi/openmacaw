// Package openclaw adapts local OpenClaw HTTP servers to the helper runner
// interface.
package openclaw

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const defaultDispatchPath = "/dispatch"

// Config contains local OpenClaw adapter settings.
type Config struct {
	Endpoint string
	APIKey   string
	Timeout  time.Duration
}

// Runner executes dispatches against a local OpenClaw server.
type Runner struct {
	endpoint   string
	apiKey     string
	httpClient *http.Client
}

// New creates an OpenClaw runner from config.
func New(cfg Config) (*Runner, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, errors.New("openclaw endpoint is required")
	}

	endpoint, err := normalizeEndpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}

	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 5 * time.Minute
	}

	return &Runner{
		endpoint: endpoint,
		apiKey:   cfg.APIKey,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

// Kind returns the OpenClaw runner kind.
func (r *Runner) Kind() string {
	return runner.KindOpenClaw
}

// Dispatch forwards the input payload to the local OpenClaw server.
func (r *Runner) Dispatch(ctx context.Context, input any, emit func(event any) error) error {
	body, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("marshal openclaw dispatch payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build openclaw dispatch request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/x-ndjson, application/json")
	if r.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.apiKey)
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("openclaw dispatch request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return decodeError(resp)
	}

	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	switch mediaType {
	case "application/x-ndjson", "application/json-seq":
		return decodeNDJSON(ctx, resp.Body, emit)
	default:
		return decodeJSON(resp.Body, emit)
	}
}

func normalizeEndpoint(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse openclaw endpoint: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("openclaw endpoint must use http or https: %s", raw)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("openclaw endpoint is missing host: %s", raw)
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = defaultDispatchPath
	}
	return parsed.String(), nil
}

func decodeNDJSON(ctx context.Context, body io.Reader, emit func(event any) error) error {
	reader := newLineReader(body)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line, err := reader.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("read openclaw event stream: %w", err)
		}
		if len(line) == 0 && errors.Is(err, io.EOF) {
			return nil
		}

		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			if errors.Is(err, io.EOF) {
				return nil
			}
			continue
		}

		var event runner.Event
		if err := json.Unmarshal(line, &event); err != nil {
			return fmt.Errorf("decode openclaw event: %w", err)
		}
		if err := emitOpenClawEvent(emit, event); err != nil {
			return err
		}

		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}

func decodeJSON(body io.Reader, emit func(event any) error) error {
	decoder := json.NewDecoder(body)
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return fmt.Errorf("decode openclaw response: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("decode openclaw response: unexpected trailing JSON value")
		}
		return fmt.Errorf("decode openclaw response trailing data: %w", err)
	}

	if events, ok := decoded.([]any); ok {
		for _, item := range events {
			event, err := mapToEvent(item)
			if err != nil {
				return err
			}
			if err := emitOpenClawEvent(emit, event); err != nil {
				return err
			}
		}
		return nil
	}

	event, err := mapToEvent(decoded)
	if err != nil {
		return err
	}
	return emitOpenClawEvent(emit, event)
}

type lineReader interface {
	ReadBytes(delim byte) ([]byte, error)
}

func newLineReader(r io.Reader) lineReader {
	if reader, ok := r.(lineReader); ok {
		return reader
	}
	return bufio.NewReader(r)
}

func mapToEvent(value any) (runner.Event, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return runner.Event{}, fmt.Errorf("encode openclaw event: %w", err)
	}
	var event runner.Event
	if err := json.Unmarshal(encoded, &event); err != nil {
		return runner.Event{}, fmt.Errorf("decode openclaw event: %w", err)
	}
	if event.Kind == "" {
		event = runner.Event{Kind: runner.EventComplete, Payload: value}
	}
	return event, nil
}

func emitOpenClawEvent(emit func(event any) error, event runner.Event) error {
	if emit == nil {
		return nil
	}
	if event.Kind == "" {
		event.Kind = runner.EventOutput
	}
	return emit(event)
}

func decodeError(resp *http.Response) error {
	const maxErrorBody = 8 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return fmt.Errorf("openclaw dispatch failed: %s", resp.Status)
	}

	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		switch {
		case payload.Error != "":
			return fmt.Errorf("openclaw dispatch failed: %s: %s", resp.Status, payload.Error)
		case payload.Message != "":
			return fmt.Errorf("openclaw dispatch failed: %s: %s", resp.Status, payload.Message)
		}
	}

	return fmt.Errorf("openclaw dispatch failed: %s: %s", resp.Status, string(body))
}
