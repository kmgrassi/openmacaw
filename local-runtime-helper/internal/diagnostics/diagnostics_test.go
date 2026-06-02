package diagnostics

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
)

func TestJSONLoggerWritesEnvelope(t *testing.T) {
	var buf bytes.Buffer
	logger := NewJSONLogger(&buf)

	event := NewEvent(EventDispatchStarted).
		WithCorrelation("dispatch-123").
		WithRunner("openai_compatible", "qwen2.5-coder:latest", "http://127.0.0.1:11434/v1").
		WithField("api_key", "ollama-secret")

	if err := logger.Log(event); err != nil {
		t.Fatalf("Log() error = %v", err)
	}

	var got EventEnvelope
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("logged JSON did not decode: %v", err)
	}

	if got.SchemaVersion != protocol.SchemaVersion {
		t.Fatalf("schema version = %q, want %q", got.SchemaVersion, protocol.SchemaVersion)
	}
	if got.CorrelationID != "dispatch-123" {
		t.Fatalf("correlation id = %q", got.CorrelationID)
	}
	if got.RunnerKind != "openai_compatible" {
		t.Fatalf("runner kind = %q", got.RunnerKind)
	}
	if got.Model != "qwen2.5-coder:latest" {
		t.Fatalf("model = %q", got.Model)
	}
	if got.EndpointHost != "127.0.0.1:11434" {
		t.Fatalf("endpoint host = %q", got.EndpointHost)
	}
	if got.Fields["api_key"] != "[redacted]" {
		t.Fatalf("api key field was not redacted: %#v", got.Fields["api_key"])
	}
}

func TestRedactString(t *testing.T) {
	got := RedactString("request failed with Authorization Bearer local-runtime-token and api_key=abc123")

	if strings.Contains(got, "local-runtime-token") || strings.Contains(got, "abc123") {
		t.Fatalf("RedactString leaked secret: %q", got)
	}
	if !strings.Contains(got, "[redacted]") {
		t.Fatalf("RedactString did not redact: %q", got)
	}
}

func TestRedactFieldSanitizesNestedStructuredValues(t *testing.T) {
	got := RedactField("headers", map[string][]string{
		"Authorization": []string{"Bearer nested-token"},
		"X-Trace":       []string{"request token also-secret"},
	}).(map[string]interface{})

	if got["Authorization"] != "[redacted]" {
		t.Fatalf("Authorization header was not redacted: %#v", got["Authorization"])
	}

	traceValues, ok := got["X-Trace"].([]interface{})
	if !ok {
		t.Fatalf("X-Trace value type = %T, want []interface{}", got["X-Trace"])
	}
	if strings.Contains(traceValues[0].(string), "also-secret") {
		t.Fatalf("nested trace value leaked secret: %#v", traceValues[0])
	}
}

func TestJSONLoggerSanitizesFieldsBeforeMarshal(t *testing.T) {
	var buf bytes.Buffer
	logger := NewJSONLogger(&buf)

	event := NewEvent(EventToolError)
	event.Fields = map[string]interface{}{
		"headers": map[string]string{
			"Authorization": "Bearer secret-token",
		},
	}

	if err := logger.Log(event); err != nil {
		t.Fatalf("Log() error = %v", err)
	}

	if strings.Contains(buf.String(), "secret-token") {
		t.Fatalf("logged JSON leaked nested secret: %s", buf.String())
	}
}

func TestEndpointHostDropsPathAndQuery(t *testing.T) {
	got := EndpointHost("https://runtime.example.test/relay/ws?token=secret")
	if got != "runtime.example.test" {
		t.Fatalf("EndpointHost() = %q, want host only", got)
	}
}
