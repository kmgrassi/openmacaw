package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDialAddressAddsDefaultPortForIPv6URL(t *testing.T) {
	t.Parallel()
	got, err := dialAddress("https://[::1]/worker-bridge/relay/ws")
	if err != nil {
		t.Fatal(err)
	}
	if got != "[::1]:443" {
		t.Fatalf("dialAddress = %q, want [::1]:443", got)
	}
}

func TestCheckOpenAIModelsRejectsInvalidPayload(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>not models</html>"))
	}))
	defer server.Close()

	err := checkOpenAIModels(context.Background(), runnerConfig{
		Kind:     "openai_compatible",
		Endpoint: server.URL + "/v1",
		Model:    "qwen2.5-coder:latest",
	})
	if err == nil {
		t.Fatal("expected invalid /models payload to fail")
	}
}

func TestHTTPChecksUseContextDeadline(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(25 * time.Millisecond)
		_, _ = w.Write([]byte(`{"data":[{"id":"qwen2.5-coder:latest"}]}`))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	err := checkOpenAIModels(ctx, runnerConfig{
		Kind:     "openai_compatible",
		Endpoint: server.URL + "/v1",
		Model:    "qwen2.5-coder:latest",
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("checkOpenAIModels error = %v, want context deadline exceeded", err)
	}
}
