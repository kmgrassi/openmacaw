package relay

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
	"github.com/kmgrassi/local-runtime-helper/internal/runner"
	"github.com/kmgrassi/local-runtime-helper/internal/tools"
)

// TestToolExecutionRequestRunsRealGitHubCLI drives the exact path a local
// model's tool call triggers — tool_execution_request -> dispatcher -> real
// local executor -> real `gh` on this machine -> tool_call_result — against a
// live repo using the developer's own gh auth.
//
// Guarded: only runs when RUN_LOCAL_GH_E2E=1 because it shells out to `gh` and
// needs an authenticated GitHub CLI. Drive it explicitly, e.g.:
//
//	RUN_LOCAL_GH_E2E=1 LOCAL_GH_WORKSPACE_ROOT=$HOME/Desktop/repos \
//	  go test ./internal/relay/ -run TestToolExecutionRequestRunsRealGitHubCLI -v
func TestToolExecutionRequestRunsRealGitHubCLI(t *testing.T) {
	if os.Getenv("RUN_LOCAL_GH_E2E") != "1" {
		t.Skip("set RUN_LOCAL_GH_E2E=1 to run the live gh integration test")
	}

	workspaceRoot := os.Getenv("LOCAL_GH_WORKSPACE_ROOT")
	if workspaceRoot == "" {
		t.Fatal("LOCAL_GH_WORKSPACE_ROOT is required (an existing directory the helper runs gh in)")
	}
	repo := os.Getenv("LOCAL_GH_REPO")
	if repo == "" {
		repo = "kmgrassi/alpha-agent"
	}

	executor, err := tools.NewExecutor(workspaceRoot)
	if err != nil {
		t.Fatalf("new executor: %v", err)
	}

	registry, err := runner.NewRegistry()
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	sender := &recordingSender{}
	dispatcher, err := NewDispatcher(DispatcherOptions{Runners: registry, Sender: sender, ToolExecutor: executor})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}

	frame := &protocol.ToolExecutionRequestFrame{
		CorrelatedFrame: correlated(protocol.TypeToolExecRequest, "e2e-1"),
		ToolCallID:      "gh-pr-list-1",
		Name:            "git.run",
		Arguments: map[string]any{
			"command": "gh pr list --repo " + repo + " --state all --limit 3 --json number,title,state",
		},
		ExecutionKind: "helper",
		TimeoutMs:     30_000,
	}

	if err := dispatcher.HandleFrame(context.Background(), frame); err != nil {
		t.Fatalf("handle frame: %v", err)
	}

	done := make(chan struct{})
	go func() { dispatcher.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(40 * time.Second):
		t.Fatal("tool execution did not complete in time")
	}

	result, ok := sender.only(t).(*protocol.ToolCallResultFrame)
	if !ok {
		t.Fatalf("frame type = %T, want *ToolCallResultFrame", sender.frames[0])
	}
	if frame.CorrelationID != "e2e-1" || result.ToolCallID != "gh-pr-list-1" {
		t.Fatalf("correlation mismatch: %#v", result)
	}

	t.Logf("success=%v duration_ms=%d", result.Success, result.DurationMs)
	t.Logf("gh output: %#v", result.Output)

	if !result.Success {
		t.Fatalf("gh command failed on the helper: %#v", result.Output)
	}
}
