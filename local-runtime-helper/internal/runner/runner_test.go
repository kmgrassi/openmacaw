package runner

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/diagnostics"
)

type recordingRunner struct {
	kind  string
	input any
	err   error
}

func (r *recordingRunner) Kind() string {
	return r.kind
}

func (r *recordingRunner) Dispatch(_ context.Context, input any, emit func(event any) error) error {
	r.input = input
	if r.err != nil {
		return r.err
	}
	return emit(Event{Kind: EventComplete})
}

func TestRegistryRoutesByRunnerKind(t *testing.T) {
	openclawRunner := &recordingRunner{kind: KindOpenClaw}
	otherRunner := &recordingRunner{kind: "openai_compatible"}
	registry, err := NewRegistry(otherRunner, openclawRunner)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}

	var events []Event
	err = registry.Dispatch(
		context.Background(),
		DispatchRequest{Kind: KindOpenClaw, Payload: map[string]string{"prompt": "ship it"}},
		func(event any) error {
			events = append(events, event.(Event))
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Dispatch returned error: %v", err)
	}

	if openclawRunner.input == nil {
		t.Fatal("openclaw runner was not called")
	}
	if otherRunner.input != nil {
		t.Fatal("wrong runner was called")
	}
	if len(events) != 1 || events[0].Kind != EventComplete {
		t.Fatalf("events = %#v, want one complete event", events)
	}
}

func TestRegistryRejectsUnknownKind(t *testing.T) {
	registry, err := NewRegistry(&recordingRunner{kind: KindOpenClaw})
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}

	err = registry.Dispatch(context.Background(), DispatchRequest{Kind: "missing"}, nil)
	if !errors.Is(err, ErrUnknownKind) {
		t.Fatalf("Dispatch error = %v, want ErrUnknownKind", err)
	}
}

type recordingLogger struct {
	events []diagnostics.EventEnvelope
}

func (l *recordingLogger) Log(event diagnostics.EventEnvelope) error {
	l.events = append(l.events, event)
	return nil
}

type fakeInput struct {
	id string
}

func (i fakeInput) CorrelationID() string {
	return i.id
}

func TestInstrumentedRunnerLogsSuccessfulDispatch(t *testing.T) {
	logger := &recordingLogger{}
	wrapped := Instrumented(&recordingRunner{kind: "openai_compatible"}, logger, Metadata{
		Model:    "qwen2.5-coder:latest",
		Endpoint: "http://127.0.0.1:11434/v1",
	})

	if err := wrapped.Dispatch(context.Background(), fakeInput{id: "dispatch-123"}, func(any) error { return nil }); err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	if len(logger.events) != 2 {
		t.Fatalf("logged %d events, want 2", len(logger.events))
	}
	if logger.events[0].Type != diagnostics.EventDispatchStarted {
		t.Fatalf("first event = %q", logger.events[0].Type)
	}
	if logger.events[1].Type != diagnostics.EventDispatchCompleted {
		t.Fatalf("second event = %q", logger.events[1].Type)
	}
	if logger.events[1].CorrelationID != "dispatch-123" {
		t.Fatalf("correlation id = %q", logger.events[1].CorrelationID)
	}
	if logger.events[1].EndpointHost != "127.0.0.1:11434" {
		t.Fatalf("endpoint host = %q", logger.events[1].EndpointHost)
	}
}

func TestInstrumentedRunnerLogsToolError(t *testing.T) {
	logger := &recordingLogger{}
	wrapped := Instrumented(&recordingRunner{
		kind: "openai_compatible",
		err:  errors.New("tool failed with token secret"),
	}, logger, Metadata{})

	if err := wrapped.Dispatch(context.Background(), fakeInput{id: "dispatch-123"}, nil); err == nil {
		t.Fatal("Dispatch() error = nil, want error")
	}

	if got := logger.events[len(logger.events)-1]; got.Type != diagnostics.EventToolError {
		t.Fatalf("last event = %q, want tool error", got.Type)
	} else if got.FailureReason != diagnostics.FailureToolError {
		t.Fatalf("failure reason = %q", got.FailureReason)
	} else if got.Message == "tool failed with token secret" {
		t.Fatalf("message was not redacted: %q", got.Message)
	}
}

func TestInstrumentedRunnerLogsCancellation(t *testing.T) {
	logger := &recordingLogger{}
	wrapped := Instrumented(&recordingRunner{
		kind: "openai_compatible",
		err:  context.Canceled,
	}, logger, Metadata{})

	if err := wrapped.Dispatch(context.Background(), fakeInput{id: "dispatch-123"}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("Dispatch() error = %v, want context.Canceled", err)
	}

	if got := logger.events[len(logger.events)-1]; got.Type != diagnostics.EventDispatchCanceled {
		t.Fatalf("last event = %q, want dispatch canceled", got.Type)
	} else if got.FailureReason != diagnostics.FailureCanceled {
		t.Fatalf("failure reason = %q", got.FailureReason)
	}
}

func TestModelCallHelpersLogEndpointAndFailureReason(t *testing.T) {
	logger := &recordingLogger{}
	metadata := Metadata{
		Model:    "qwen2.5-coder:latest",
		Endpoint: "http://127.0.0.1:11434/v1",
	}

	LogModelCallStarted(logger, "dispatch-123", "openai_compatible", metadata)
	LogModelCallEnded(logger, "dispatch-123", "openai_compatible", metadata, 12*time.Millisecond)
	LogModelError(logger, "dispatch-123", "openai_compatible", metadata, 15*time.Millisecond, errors.New("model failed with api_key=secret"))

	if logger.events[0].Type != diagnostics.EventModelCallStarted {
		t.Fatalf("first event = %q", logger.events[0].Type)
	}
	if logger.events[1].Type != diagnostics.EventModelCallEnded {
		t.Fatalf("second event = %q", logger.events[1].Type)
	}
	got := logger.events[2]
	if got.Type != diagnostics.EventModelError {
		t.Fatalf("third event = %q", got.Type)
	}
	if got.FailureReason != diagnostics.FailureModelError {
		t.Fatalf("failure reason = %q", got.FailureReason)
	}
	if got.EndpointHost != "127.0.0.1:11434" {
		t.Fatalf("endpoint host = %q", got.EndpointHost)
	}
	if got.Message == "model failed with api_key=secret" {
		t.Fatalf("message was not redacted: %q", got.Message)
	}
}
