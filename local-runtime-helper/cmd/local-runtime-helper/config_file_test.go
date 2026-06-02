package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRuntimeConfig(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.toml")
	err := os.WriteFile(path, []byte(`
[machine]
display_name = "Kevin MBP"

[cloud]
endpoint = "wss://relay.example.com/worker-bridge/relay/ws"
token = "lrh_test_token"

[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key = "ollama"
model = "qwen2.5-coder:latest"
`), 0o600)
	if err != nil {
		t.Fatal(err)
	}

	cfg, err := loadRuntimeConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Machine.DisplayName != "Kevin MBP" {
		t.Fatalf("display name = %q", cfg.Machine.DisplayName)
	}
	if cfg.Cloud.Endpoint != "wss://relay.example.com/worker-bridge/relay/ws" {
		t.Fatalf("endpoint = %q", cfg.Cloud.Endpoint)
	}
	runner := cfg.Runners["openai_compatible"]
	if runner.Endpoint != "http://127.0.0.1:11434/v1" {
		t.Fatalf("runner endpoint = %q", runner.Endpoint)
	}
	if runner.Model != "qwen2.5-coder:latest" {
		t.Fatalf("runner model = %q", runner.Model)
	}
}

func TestValidationErrors(t *testing.T) {
	t.Parallel()
	cfg := runtimeConfig{
		Runners: map[string]runnerConfig{
			"openai_compatible": {Kind: "openai_compatible", Endpoint: "http://127.0.0.1:11434/v1"},
		},
	}
	errs := validationErrors(cfg)
	if len(errs) != 3 {
		t.Fatalf("validation error count = %d, want 3: %v", len(errs), errs)
	}
}

func TestAppendPath(t *testing.T) {
	t.Parallel()
	got, err := appendPath("http://127.0.0.1:11434/v1/", "models")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:11434/v1/models" {
		t.Fatalf("appendPath = %q", got)
	}
}
