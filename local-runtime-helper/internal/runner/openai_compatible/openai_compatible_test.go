package openai_compatible

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestDispatchConstructsStreamingRequest(t *testing.T) {
	requests := make(chan chatRequest, 1)
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", r.Method)
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		headers <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", APIKey: "ollama", Model: "qwen2.5-coder:latest"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	if req.Model != "qwen2.5-coder:latest" {
		t.Fatalf("model = %q", req.Model)
	}
	if !req.Stream {
		t.Fatal("stream = false, want true")
	}
	if req.Messages[0].Content != "hi" {
		t.Fatalf("message content = %q", req.Messages[0].Content)
	}
	if got := (<-headers).Get("Authorization"); got != "Bearer ollama" {
		t.Fatalf("authorization = %q", got)
	}
	assertOutput(t, events, "hello")
}

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

func TestDispatchSupportsNonStreamingFallback(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if attempts == 1 {
			if !req.Stream {
				t.Fatal("first request stream = false, want true")
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"streaming is not supported","code":"unsupported_stream"}}`))
			return
		}
		if req.Stream {
			t.Fatal("fallback request stream = true, want false")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fallback text"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	assertOutput(t, events, "fallback text")
}

func TestDispatchHelperManagedToolLoop(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if attempts == 1 {
			if len(req.Tools) != 1 {
				t.Fatalf("tools = %#v, want one tool", req.Tools)
			}
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_123","type":"function","function":{"name":"filesystem_read","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		if got := req.Messages[len(req.Messages)-1].Role; got != "tool" {
			t.Fatalf("last message role = %q, want tool", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"file summarized"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{ToolCallID: "call_123", Success: true, Output: "contents", DurationMs: 2}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "read"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			Description:      "Read a workspace file",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	assertOutput(t, events, "file summarized")
}

func TestDispatchHelperManagedReturnsAbsentNativeToolAsResult(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_shell","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if got := req.Messages[len(req.Messages)-1].Content; !strings.Contains(got, `"undefined_tool"`) {
			t.Fatalf("last message content = %q, want undefined_tool result", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"shell.exec is not available."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_shell", "undefined_tool")
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
}

func TestDispatchHelperManagedPromptFallback(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if attempts == 1 {
			if len(req.Tools) == 0 {
				t.Fatal("first request did not include native tools")
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"tools are not supported","code":"unsupported_tools"}}`))
			return
		}
		if len(req.Tools) != 0 {
			t.Fatalf("fallback tools = %#v, want none", req.Tools)
		}
		if req.Messages[0].Role != "system" {
			t.Fatalf("first fallback message role = %q, want system", req.Messages[0].Role)
		}
		if attempts == 2 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tool_call\":{\"id\":\"call_prompt\",\"name\":\"filesystem_read\",\"arguments\":{\"path\":\"README.md\"}}}"},"finish_reason":"stop"}]}`))
			return
		}
		if got := req.Messages[len(req.Messages)-1].Role; got != "tool" {
			t.Fatalf("last message role = %q, want tool", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fallback answer"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{ToolCallID: "call_prompt", Success: true, Output: "contents"}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "read"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
	assertOutput(t, events, "fallback answer")
}

func TestDispatchRuntimeManagedParsesTaggedTextToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"I'll check.\n\n<function=scheduled_task.list>\n<parameter=due_only>\ntrue\n</parameter>\n</function>\n<function=scheduled_task.read>\n<parameter=scheduledTaskId>\n\"task-1\"\n</parameter>\n</function>\n</tool_call>"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "list schedules"}},
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "scheduled_task.list",
			ExecutionKind: "runtime",
		}, {
			Name:          "scheduled_task.read",
			ExecutionKind: "runtime",
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
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
	if event.ToolCalls[0].Name != "scheduled_task.list" || event.ToolCalls[1].Name != "scheduled_task.read" {
		t.Fatalf("tool call names = %#v", event.ToolCalls)
	}
	if event.ToolCalls[0].Arguments["due_only"] != true {
		t.Fatalf("arguments = %#v", event.ToolCalls[0].Arguments)
	}
	if event.ToolCalls[1].Arguments["scheduledTaskId"] != "task-1" {
		t.Fatalf("arguments = %#v", event.ToolCalls[1].Arguments)
	}
}

func TestDispatchHelperManagedPromptFallbackReturnsAbsentToolAsResult(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"tools are not supported","code":"unsupported_tools"}}`))
			return
		}
		if attempts == 2 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tool_call\":{\"id\":\"call_shell\",\"name\":\"shell.exec\",\"arguments\":{\"command\":\"pwd\"}}}"},"finish_reason":"stop"}]}`))
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if got := req.Messages[len(req.Messages)-1].Content; !strings.Contains(got, `"undefined_tool"`) {
			t.Fatalf("last message content = %q, want undefined_tool result", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"shell.exec is not available."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_shell", "undefined_tool")
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
}

func TestDispatchHelperManagedDelegatesRuntimeTool(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_runtime_1","type":"function","function":{"name":"task.create","arguments":"{\"title\":\"Plan\"}"}},{"id":"call_runtime_2","type":"function","function":{"name":"task.update","arguments":"{\"id\":\"task-1\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "create"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "task.create",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}, {
			Name:             "task.update",
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
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 2 {
		t.Fatalf("tool calls = %#v, want two forwarded calls", event.ToolCalls)
	}
	if event.ToolCalls[0].Name != "task.create" || event.ToolCalls[1].Name != "task.update" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}

func TestDispatchHelperManagedExecutesHelperAndForwardsRuntimeTools(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_helper","type":"function","function":{"name":"repo.search","arguments":"{\"query\":\"TODO\"}"}},{"id":"call_runtime","type":"function","function":{"name":"task.create","arguments":"{\"title\":\"Follow up\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true, Output: "matches"}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "plan"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "repo.search",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}, {
			Name:             "task.create",
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
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
	event, ok := events[len(events)-1].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("last event = %T, want ToolCallRequestEvent; events = %#v", events[len(events)-1], events)
	}
	if len(event.ToolCalls) != 1 || event.ToolCalls[0].Name != "task.create" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}

func TestDispatchRuntimeManagedReturnsAbsentToolAsResultBeforeForwarding(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_shell","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if got := req.Messages[len(req.Messages)-1].Content; !strings.Contains(got, `"undefined_tool"`) {
			t.Fatalf("last message content = %q, want undefined_tool result", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"shell.exec is not available."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "runtime_managed",
		ProviderToolSpecs: []runner.ToolSpec{{
			Type:     "function",
			Function: runner.ToolFunction{Name: "shell.exec"},
		}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_shell", "undefined_tool")
}

func TestDispatchRuntimeManagedDelegatesHelperTool(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_helper","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "shell.exec",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 || event.ToolCalls[0].Name != "shell.exec" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}

func TestDispatchRuntimeManagedForwardsGrantProvenance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_helper","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "shell.exec",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
			GrantProvenance: &runner.GrantProvenance{
				AgentToolGrantID:     "grant_123",
				Source:               "template",
				SourceToolTemplateID: "template_coding",
				Reason:               "default coding tool",
				CreatedByUserID:      "user_123",
			},
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
	if len(event.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v, want one", event.ToolCalls)
	}
	got := event.ToolCalls[0].GrantProvenance
	if got == nil {
		t.Fatal("grant provenance = nil")
	}
	if got.AgentToolGrantID != "grant_123" || got.Source != "template" || got.SourceToolTemplateID != "template_coding" || got.Reason != "default coding tool" || got.CreatedByUserID != "user_123" {
		t.Fatalf("grant provenance = %#v", got)
	}
}

func TestDispatchRuntimeManagedReturnsAbsentToolAsResult(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_absent","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if got := req.Messages[len(req.Messages)-1].Content; !strings.Contains(got, `"undefined_tool"`) {
			t.Fatalf("last message content = %q, want undefined_tool result", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"shell.exec is not available."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	stream := false
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		Stream:          &stream,
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "repo.search",
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
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_absent", "undefined_tool")
}

func TestDecodeInputParsesOptionalGrantProvenance(t *testing.T) {
	req, err := decodeInput([]byte(`{
		"messages":[{"role":"user","content":"run"}],
		"tool_definitions":[{
			"name":"shell.exec",
			"parameters_schema":{"type":"object"},
			"execution_kind":"helper",
			"grant_provenance":{
				"agent_tool_grant_id":"grant_123",
				"source":"manual",
				"source_tool_template_id":"template_coding",
				"reason":"enabled by user",
				"created_by_user_id":"user_123"
			}
		}]
	}`))
	if err != nil {
		t.Fatalf("decodeInput() error = %v", err)
	}
	if len(req.ToolDefinitions) != 1 {
		t.Fatalf("tool definitions = %#v, want one", req.ToolDefinitions)
	}
	got := req.ToolDefinitions[0].GrantProvenance
	if got == nil {
		t.Fatal("grant provenance = nil")
	}
	if got.AgentToolGrantID != "grant_123" || got.Source != "manual" || got.SourceToolTemplateID != "template_coding" || got.Reason != "enabled by user" || got.CreatedByUserID != "user_123" {
		t.Fatalf("grant provenance = %#v", got)
	}
}

func TestDecodeInputPreservesScheduledMessageMetadata(t *testing.T) {
	req, err := decodeInput([]byte(`{
		"metadata":{"relay":"local"},
		"messages":[{
			"role":"user",
			"content":"scheduled instruction",
			"metadata":{"source":"scheduled_task","kind":"scheduled_agent_message"}
		}]
	}`))
	if err != nil {
		t.Fatalf("decodeInput() error = %v", err)
	}
	if req.Metadata["relay"] != "local" {
		t.Fatalf("request metadata = %#v", req.Metadata)
	}
	if len(req.Messages) != 1 {
		t.Fatalf("messages = %#v, want one", req.Messages)
	}
	if req.Messages[0].Metadata["source"] != "scheduled_task" || req.Messages[0].Metadata["kind"] != "scheduled_agent_message" {
		t.Fatalf("message metadata = %#v", req.Messages[0].Metadata)
	}
}

func TestDispatchStripsMessageMetadataFromProviderRequest(t *testing.T) {
	requests := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
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
		Messages: []runner.ChatMessage{{
			Role:    "user",
			Content: "scheduled instruction",
			Metadata: map[string]any{
				"source": "scheduled_task",
				"kind":   "scheduled_agent_message",
			},
		}},
		Stream: &stream,
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	messages, ok := req["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v", req["messages"])
	}
	message, ok := messages[0].(map[string]any)
	if !ok {
		t.Fatalf("message = %#v", messages[0])
	}
	if _, exists := message["metadata"]; exists {
		t.Fatalf("provider message includes metadata: %#v", message)
	}
}

func TestDispatchNonStreamingByRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Stream {
			t.Fatal("stream = true, want false")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"plain"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
		Stream:   &stream,
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "plain")
}

func TestDispatchMapsProviderErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"model qwen2.5-coder:latest not found"}}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "qwen2.5-coder:latest"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindModelNotFound {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindModelNotFound)
	}
	if runnerErr.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", runnerErr.StatusCode)
	}
}

func TestDispatchDoesNotMapPlainNotFoundToModelNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindProvider {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindProvider)
	}
	if runnerErr.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", runnerErr.StatusCode)
	}
}

func TestDispatchRespectsCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()

	r, err := NewWithClient(Config{Endpoint: server.URL + "/v1", Model: "local-model"}, &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err = r.Dispatch(ctx, runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindCanceled {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindCanceled)
	}
}

func TestDispatchMapsInFlightStreamCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()

	r, err := NewWithClient(Config{Endpoint: server.URL + "/v1", Model: "local-model"}, &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err = r.Dispatch(ctx, runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error {
		if _, ok := event.(runner.OutputEvent); ok {
			cancel()
		}
		return nil
	})
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindCanceled {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindCanceled)
	}
}

func assertOutput(t *testing.T, events []any, want string) {
	t.Helper()
	got := ""
	complete := false
	for _, event := range events {
		switch e := event.(type) {
		case runner.OutputEvent:
			got += e.Text
		case runner.CompleteEvent:
			complete = true
		}
	}
	if got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if !complete {
		t.Fatal("complete event was not emitted")
	}
}

func assertToolFailure(t *testing.T, events []any, toolCallID, code string) {
	t.Helper()
	for _, event := range events {
		toolEvent, ok := event.(runner.ToolExecutionEvent)
		if !ok || toolEvent.Result == nil || toolEvent.ToolCallID != toolCallID {
			continue
		}
		if toolEvent.Result.Success {
			t.Fatalf("tool result success = true, want false")
		}
		output, ok := toolEvent.Result.Output.(map[string]any)
		if !ok {
			t.Fatalf("tool result output = %T, want map[string]any", toolEvent.Result.Output)
		}
		if output["error"] != code {
			t.Fatalf("tool result error = %#v, want %q", output["error"], code)
		}
		return
	}
	t.Fatalf("tool failure %q was not emitted; events = %#v", toolCallID, events)
}

type fakeToolExecutor struct {
	calls  int
	result runner.ToolCallResult
}

func (f *fakeToolExecutor) Execute(ctx context.Context, req runner.ToolCallRequest) runner.ToolCallResult {
	f.calls++
	if f.result.ToolCallID == "" {
		f.result.ToolCallID = req.ToolCallID
	}
	return f.result
}
