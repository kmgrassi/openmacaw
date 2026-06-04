package openai_compatible

import (
	"context"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

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
