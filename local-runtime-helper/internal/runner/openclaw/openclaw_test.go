package openclaw

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestDispatchStreamsEventsFromFakeServer(t *testing.T) {
	var requestPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dispatch" {
			t.Fatalf("path = %q, want /dispatch", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q, want bearer token", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&requestPayload); err != nil {
			t.Fatalf("decode request payload: %v", err)
		}

		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(`{"kind":"progress","message":"queued"}` + "\n"))
		_, _ = w.Write([]byte(`{"kind":"output","output":"done"}` + "\n"))
		_, _ = w.Write([]byte(`{"kind":"complete"}` + "\n"))
	}))
	defer server.Close()

	openclawRunner, err := New(Config{Endpoint: server.URL, APIKey: "test-key"})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	var events []runner.Event
	err = openclawRunner.Dispatch(
		context.Background(),
		map[string]any{"task": "inspect repo"},
		func(event any) error {
			events = append(events, event.(runner.Event))
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Dispatch returned error: %v", err)
	}

	if requestPayload["task"] != "inspect repo" {
		t.Fatalf("request payload = %#v, want task", requestPayload)
	}
	if len(events) != 3 {
		t.Fatalf("events length = %d, want 3: %#v", len(events), events)
	}
	if events[0].Kind != runner.EventProgress || events[0].Message != "queued" {
		t.Fatalf("first event = %#v, want progress queued", events[0])
	}
	if events[1].Kind != runner.EventOutput || events[1].Output != "done" {
		t.Fatalf("second event = %#v, want output done", events[1])
	}
	if events[2].Kind != runner.EventComplete {
		t.Fatalf("third event = %#v, want complete", events[2])
	}
}

func TestDispatchDecodesJSONResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"complete","payload":{"ok":true}}`))
	}))
	defer server.Close()

	openclawRunner, err := New(Config{Endpoint: server.URL + "/run"})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	var events []runner.Event
	err = openclawRunner.Dispatch(context.Background(), map[string]any{"task": "x"}, func(event any) error {
		events = append(events, event.(runner.Event))
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch returned error: %v", err)
	}

	if len(events) != 1 || events[0].Kind != runner.EventComplete {
		t.Fatalf("events = %#v, want one complete event", events)
	}
}

func TestDispatchStreamsLargeNDJSONEvent(t *testing.T) {
	largeOutput := strings.Repeat("x", 2*1024*1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_ = json.NewEncoder(w).Encode(runner.Event{Kind: runner.EventOutput, Output: largeOutput})
	}))
	defer server.Close()

	openclawRunner, err := New(Config{Endpoint: server.URL})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	var events []runner.Event
	err = openclawRunner.Dispatch(context.Background(), map[string]any{"task": "x"}, func(event any) error {
		events = append(events, event.(runner.Event))
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch returned error: %v", err)
	}

	if len(events) != 1 {
		t.Fatalf("events length = %d, want 1", len(events))
	}
	if events[0].Output != largeOutput {
		t.Fatalf("output len = %d, want %d", len(events[0].Output), len(largeOutput))
	}
}

func TestDispatchRejectsTrailingJSONValue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"complete"} {"kind":"output","output":"late"}`))
	}))
	defer server.Close()

	openclawRunner, err := New(Config{Endpoint: server.URL})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	err = openclawRunner.Dispatch(context.Background(), map[string]any{"task": "x"}, nil)
	if err == nil {
		t.Fatal("Dispatch returned nil error, want trailing JSON error")
	}
	if !strings.Contains(err.Error(), "unexpected trailing JSON value") {
		t.Fatalf("Dispatch error = %v, want trailing JSON error", err)
	}
}

func TestDispatchMapsServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"local executor unavailable"}`))
	}))
	defer server.Close()

	openclawRunner, err := New(Config{Endpoint: server.URL})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	err = openclawRunner.Dispatch(context.Background(), map[string]any{"task": "x"}, nil)
	if err == nil {
		t.Fatal("Dispatch returned nil error, want server error")
	}
}
