// Package diagnostics defines structured local execution events.
//
// The relay and runner packages use these envelopes for operator-facing logs.
// Events intentionally carry endpoint hosts instead of full URLs, and callers
// should keep credentials out of free-form fields.
package diagnostics

import (
	"encoding/json"
	"io"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
)

// EventType identifies the local execution lifecycle event being logged.
type EventType string

const (
	EventConnectionAttempt EventType = "connection_attempt"
	EventRegisterAck       EventType = "register_ack"
	EventDispatchStarted   EventType = "dispatch_started"
	EventDispatchCompleted EventType = "dispatch_completed"
	EventDispatchCanceled  EventType = "dispatch_canceled"
	EventModelCallStarted  EventType = "model_call_started"
	EventModelCallEnded    EventType = "model_call_ended"
	EventModelError        EventType = "model_error"
	EventToolError         EventType = "tool_error"
	EventCancellation      EventType = "cancellation"
)

// FailureReason is a stable, typed reason suitable for filtering diagnostics.
type FailureReason string

const (
	FailureAuthFailed        FailureReason = "auth_failed"
	FailureCanceled          FailureReason = "canceled"
	FailureConnectionRefused FailureReason = "connection_refused"
	FailureDispatchFailed    FailureReason = "dispatch_failed"
	FailureModelError        FailureReason = "model_error"
	FailureRegisterRejected  FailureReason = "register_rejected"
	FailureTimeout           FailureReason = "timeout"
	FailureToolError         FailureReason = "tool_error"
	FailureUnknown           FailureReason = "unknown"
)

// EventEnvelope is the JSON log shape shared by relay and runner diagnostics.
type EventEnvelope struct {
	SchemaVersion string                 `json:"schema_version"`
	Timestamp     time.Time              `json:"timestamp"`
	Type          EventType              `json:"type"`
	CorrelationID string                 `json:"correlation_id,omitempty"`
	RunnerKind    string                 `json:"runner_kind,omitempty"`
	Model         string                 `json:"model,omitempty"`
	EndpointHost  string                 `json:"endpoint_host,omitempty"`
	FailureReason FailureReason          `json:"failure_reason,omitempty"`
	DurationMS    int64                  `json:"duration_ms,omitempty"`
	Message       string                 `json:"message,omitempty"`
	Fields        map[string]interface{} `json:"fields,omitempty"`
}

// NewEvent creates an event envelope with the current schema version.
func NewEvent(eventType EventType) EventEnvelope {
	return EventEnvelope{
		SchemaVersion: protocol.SchemaVersion,
		Timestamp:     time.Now().UTC(),
		Type:          eventType,
	}
}

// WithCorrelation returns a copy tagged with a dispatch correlation id.
func (e EventEnvelope) WithCorrelation(correlationID string) EventEnvelope {
	e.CorrelationID = correlationID
	return e
}

// WithRunner returns a copy tagged with local runner metadata.
func (e EventEnvelope) WithRunner(kind, model, endpoint string) EventEnvelope {
	e.RunnerKind = kind
	e.Model = model
	e.EndpointHost = EndpointHost(endpoint)
	return e
}

// WithEndpoint returns a copy tagged with only a sanitized endpoint host.
func (e EventEnvelope) WithEndpoint(endpoint string) EventEnvelope {
	e.EndpointHost = EndpointHost(endpoint)
	return e
}

// WithFailure returns a copy tagged with a typed failure reason.
func (e EventEnvelope) WithFailure(reason FailureReason, message string) EventEnvelope {
	e.FailureReason = reason
	e.Message = RedactString(message)
	return e
}

// WithDuration returns a copy tagged with a duration.
func (e EventEnvelope) WithDuration(duration time.Duration) EventEnvelope {
	e.DurationMS = duration.Milliseconds()
	return e
}

// WithField returns a copy tagged with one redacted structured field.
func (e EventEnvelope) WithField(key string, value interface{}) EventEnvelope {
	if e.Fields == nil {
		e.Fields = map[string]interface{}{}
	}
	e.Fields[key] = RedactField(key, value)
	return e
}

// Logger writes diagnostic envelopes.
type Logger interface {
	Log(EventEnvelope) error
}

// JSONLogger writes one JSON envelope per line.
type JSONLogger struct {
	mu sync.Mutex
	w  io.Writer
}

// NewJSONLogger creates a JSON-lines logger.
func NewJSONLogger(w io.Writer) *JSONLogger {
	return &JSONLogger{w: w}
}

// Log writes an event as a single JSON line.
func (l *JSONLogger) Log(event EventEnvelope) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	event = sanitizeEvent(event)
	if event.SchemaVersion == "" {
		event.SchemaVersion = protocol.SchemaVersion
	}
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}

	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := l.w.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

// EndpointHost returns only the host component of an endpoint.
func EndpointHost(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return ""
	}
	return parsed.Host
}

// RedactField removes credentials from structured log fields.
func RedactField(key string, value interface{}) interface{} {
	return redactValue(key, value)
}

func sanitizeEvent(event EventEnvelope) EventEnvelope {
	if event.Message != "" {
		event.Message = RedactString(event.Message)
	}
	if event.Fields != nil {
		fields := make(map[string]interface{}, len(event.Fields))
		for key, value := range event.Fields {
			fields[key] = RedactField(key, value)
		}
		event.Fields = fields
	}
	return event
}

func redactValue(key string, value interface{}) interface{} {
	if isSensitiveKey(key) {
		return "[redacted]"
	}
	if s, ok := value.(string); ok {
		return RedactString(s)
	}

	reflected := reflect.ValueOf(value)
	if !reflected.IsValid() {
		return value
	}

	switch reflected.Kind() {
	case reflect.Map:
		if reflected.Type().Key().Kind() != reflect.String {
			return value
		}
		redacted := make(map[string]interface{}, reflected.Len())
		for _, mapKey := range reflected.MapKeys() {
			childKey := mapKey.String()
			redacted[childKey] = redactValue(childKey, reflected.MapIndex(mapKey).Interface())
		}
		return redacted
	case reflect.Slice, reflect.Array:
		redacted := make([]interface{}, reflected.Len())
		for i := 0; i < reflected.Len(); i++ {
			redacted[i] = redactValue(key, reflected.Index(i).Interface())
		}
		return redacted
	}

	return value
}

// RedactString removes common bearer-token and API-key fragments from messages.
func RedactString(value string) string {
	words := strings.Fields(value)
	for i, word := range words {
		lower := strings.ToLower(strings.Trim(word, ":=,;"))
		switch lower {
		case "authorization":
			if i+1 < len(words) {
				words[i+1] = "[redacted]"
			}
			if i+2 < len(words) {
				words[i+2] = "[redacted]"
			}
		case "bearer", "token", "api_key", "apikey":
			if i+1 < len(words) {
				words[i+1] = "[redacted]"
			}
		}
		if strings.Contains(lower, "token=") || strings.Contains(lower, "api_key=") || strings.Contains(lower, "apikey=") {
			parts := strings.SplitN(word, "=", 2)
			if len(parts) == 2 {
				words[i] = parts[0] + "=[redacted]"
			}
		}
	}
	return strings.Join(words, " ")
}

func isSensitiveKey(key string) bool {
	lower := strings.ToLower(key)
	return strings.Contains(lower, "token") ||
		strings.Contains(lower, "api_key") ||
		strings.Contains(lower, "apikey") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "authorization") ||
		strings.Contains(lower, "bearer")
}
