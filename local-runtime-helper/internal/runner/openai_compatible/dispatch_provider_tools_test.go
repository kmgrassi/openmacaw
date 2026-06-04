package openai_compatible

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestDispatchSendsToolsInRequest(t *testing.T) {
	requests := make(chan chatRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "read"}},
		Stream:   &stream,
		ProviderToolSpecs: []runner.ToolSpec{{
			Type:     "function",
			Function: runner.ToolFunction{Name: "already_translated"},
		}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			Description:      "Read a workspace file",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	if len(req.Tools) != 1 {
		t.Fatalf("tools = %#v, want one tool", req.Tools)
	}
	if req.Tools[0].Type != "function" || req.Tools[0].Function.Name != "already_translated" {
		t.Fatalf("tool = %#v", req.Tools[0])
	}
}

func TestDispatchTranslatesToolDefinitionsWhenProviderSpecsAbsent(t *testing.T) {
	requests := make(chan chatRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "read"}},
		Stream:   &stream,
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			Description:      "Read a workspace file",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	if len(req.Tools) != 1 {
		t.Fatalf("tools = %#v, want one tool", req.Tools)
	}
	if req.Tools[0].Type != "function" || req.Tools[0].Function.Name != "filesystem_read" {
		t.Fatalf("tool = %#v", req.Tools[0])
	}
}

func TestDispatchRespectsExplicitEmptyProviderToolSpecs(t *testing.T) {
	requests := make(chan chatRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:          []runner.ChatMessage{{Role: "user", Content: "read"}},
		Stream:            &stream,
		ProviderToolSpecs: []runner.ToolSpec{},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			Description:      "Read a workspace file",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	if len(req.Tools) != 0 {
		t.Fatalf("tools = %#v, want none", req.Tools)
	}
}

func TestDispatchEmitsToolCallRequestForNonStreamingResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_123","type":"function","function":{"name":"filesystem_read","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "read"}},
		Stream:   &stream,
		ProviderToolSpecs: []runner.ToolSpec{{
			Type:     "function",
			Function: runner.ToolFunction{Name: "filesystem_read"},
		}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 || event.ToolCalls[0].Name != "filesystem_read" || event.ToolCalls[0].Arguments["path"] != "README.md" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}

func TestDispatchAggregatesStreamingToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_123\",\"type\":\"function\",\"function\":{\"name\":\"filesystem_read\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:          []runner.ChatMessage{{Role: "user", Content: "read"}},
		ProviderToolSpecs: []runner.ToolSpec{{Type: "function", Function: runner.ToolFunction{Name: "filesystem_read"}}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if got := event.ToolCalls[0].Arguments["path"]; got != "README.md" {
		t.Fatalf("arguments path = %q", got)
	}
}

func TestDispatchPreservesSparseStreamingToolCallIndexes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":3,\"id\":\"call_3\",\"type\":\"function\",\"function\":{\"name\":\"git_status\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"filesystem_read\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:          []runner.ChatMessage{{Role: "user", Content: "inspect"}},
		ProviderToolSpecs: []runner.ToolSpec{{Type: "function", Function: runner.ToolFunction{Name: "filesystem_read"}}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}, {
			Name:             "git_status",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 2 {
		t.Fatalf("tool calls = %#v, want two calls", event.ToolCalls)
	}
	if event.ToolCalls[0].ID != "call_1" || event.ToolCalls[1].ID != "call_3" {
		t.Fatalf("tool call order = %#v, want sparse indexes sorted", event.ToolCalls)
	}
}
