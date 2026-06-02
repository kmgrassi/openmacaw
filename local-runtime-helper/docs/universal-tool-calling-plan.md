# Universal Tool Calling — Helper Daemon Scoping Document

## Overview

This document scopes the local-runtime-helper (Go daemon) work required to support universal tool calling. The helper is responsible for receiving tool execution requests, executing tools locally on the user's machine (file I/O, shell commands, git operations), sandboxing execution to the workspace, and formatting results back for the model.

## Current State

- **Runner interface** (`internal/runner/runner.go`) defines the `Runner` adapter interface with `Kind()` and `Dispatch()`. The `ChatCompletionInput` struct has `Model`, `Messages`, `Temperature`, `MaxTokens`, `Stream` — no tool-related fields.
- **OpenAI-compatible runner** (`internal/runner/openai_compatible/openai_compatible.go`) sends chat completions to a local endpoint (Ollama, etc). It parses streamed and non-streamed responses but ignores `tool_calls` in the response. The `chatRequest` struct does not include `tools` or `tool_choice`.
- **Protocol** (`internal/protocol/protocol.go`) defines frame types (`dispatch`, `progress`, `output`, `complete`, `error`) but has no tool-call-specific frames.
- **Relay** (`internal/relay/relay.go`) is currently a stub — the WSS connection and dispatch routing are planned (PR 6 from OQ-02).

## Architecture — Helper's Role in Tool Calling

The helper receives tool definitions as the effective per-turn grant
set resolved by Platform/Runtime. It does not derive tools from local
bundles, agent roles, database policy templates, or user override
configuration. A tool absent from the dispatch frame is unavailable to
the model and cannot be executed by the helper, even if the helper has
local code capable of running a tool with that name.

### Helper-Managed Loop (Primary Mode)

```
Runtime sends dispatch frame with effective tool_definitions[]
  |
  v
Helper parses the effective tool definitions from dispatch payload
  |
  v
Helper translates effective tools to provider format (OpenAI function_calling)
  |
  v
Helper sends chat completion request with tools to local model
  |
  v
Model responds
  |
  +--[tool_calls in response]
  |    |
  |    v
  |  Helper emits progress frame: tool.started
  |    |
  |    v
  |  Helper executes the dispatched tool locally (sandboxed)
  |    - filesystem_read: read file within workspace
  |    - filesystem_write: write file within workspace
  |    - shell: run command within workspace
  |    - git: git operation within workspace
  |    |
  |    v
  |  Helper emits progress frame: tool.completed (with result)
  |    |
  |    v
  |  Helper appends tool result to messages, loops back to model
  |
  +--[no tool_calls, just text]
       |
       v
     Helper emits complete frame with final response
```

### Cloud-Managed Loop (Fallback Mode)

```
Runtime sends dispatch frame (single turn, no loop)
  |
  v
Helper sends to model, gets tool_call response
  |
  v
Helper sends tool_call_request frame to runtime
  |
  v
Runtime sends tool_execution_request frame back to helper
  |
  v
Helper executes tool, sends tool_call_result frame to runtime
  |
  v
Runtime builds next turn and sends new dispatch
```

## PR Plan

### PR1: Tool Executor Framework

**Branch:** `feat/tool-executor`

**Files:**
- `internal/tool/executor.go` — Tool executor interface and dispatcher
- `internal/tool/filesystem.go` — Filesystem read/write tool executor
- `internal/tool/shell.go` — Shell command tool executor
- `internal/tool/git.go` — Git operation tool executor
- `internal/tool/executor_test.go` — Tests
- `internal/tool/filesystem_test.go` — Tests
- `internal/tool/shell_test.go` — Tests
- `internal/tool/git_test.go` — Tests

**Executor interface:**

```go
package tool

import "context"

// Definition is the model-agnostic effective tool definition received from the runtime dispatch.
type Definition struct {
    Name            string         `json:"name"`
    Description     string         `json:"description"`
    ParametersSchema map[string]any `json:"parameters_schema"`
    ExecutionKind   string         `json:"execution_kind"`
    ExecutionConfig map[string]any `json:"execution_config"`
}

// CallRequest is a tool execution request.
type CallRequest struct {
    ToolCallID string         `json:"tool_call_id"`
    Name       string         `json:"name"`
    Arguments  map[string]any `json:"arguments"`
    Definition *Definition    `json:"definition,omitempty"`
}

// CallResult is the result of executing a tool.
type CallResult struct {
    ToolCallID string `json:"tool_call_id"`
    Success    bool   `json:"success"`
    Output     string `json:"output"`
    DurationMs int64  `json:"duration_ms"`
}

// Executor executes tool calls within a sandboxed workspace.
type Executor struct {
    workspacePath string
    config        ExecutorConfig
}

type ExecutorConfig struct {
    // Root directory for workspace-scoped file operations.
    WorkspacePath string

    // Shell command allowlist. Empty means use the default safe set.
    // Use ["*"] only for explicitly unrestricted command execution.
    AllowedCommands []string

    // Maximum file size for read operations.
    MaxReadBytes int64

    // Per-tool execution timeout.
    TimeoutMs int64

    // Git operations allowlist.
    AllowedGitOps []string
}

// Execute dispatches a tool call to the appropriate handler.
func (e *Executor) Execute(ctx context.Context, req CallRequest) CallResult

// executeFilesystemRead reads a file within the workspace.
func (e *Executor) executeFilesystemRead(ctx context.Context, req CallRequest) CallResult

// executeFilesystemWrite writes a file within the workspace.
func (e *Executor) executeFilesystemWrite(ctx context.Context, req CallRequest) CallResult

// executeShell runs a shell command within the workspace.
func (e *Executor) executeShell(ctx context.Context, req CallRequest) CallResult

// executeGit runs a git operation within the workspace.
func (e *Executor) executeGit(ctx context.Context, req CallRequest) CallResult
```

**Tool implementations:**

| Execution Kind | Arguments | Behavior |
|---|---|---|
| `filesystem_read` | `path: string` | Read file contents, resolve relative to workspace root, reject path traversal |
| `filesystem_write` | `path: string, content: string` | Write file, create parent dirs, resolve relative to workspace root |
| `shell` | `command: string, args?: string[]` | Run command in workspace dir, capture stdout+stderr, enforce timeout |
| `git` | `operation: string, args?: string[]` | Run git operation in workspace dir, validate operation is allowed |

**Acceptance criteria:**
- [ ] `Executor` dispatches to correct handler based on `execution_kind`
- [ ] `filesystem_read` reads files, rejects paths outside workspace (symlink-aware)
- [ ] `filesystem_write` creates/overwrites files, creates parent directories
- [ ] `shell` executes commands with timeout, captures output, respects allowlist
- [ ] `git` executes git commands, validates operation against allowlist
- [ ] All executors return structured `CallResult` with success/failure and output
- [ ] Unknown `execution_kind` returns error result (not panic)
- [ ] Tests cover happy paths and security edge cases (path traversal, command injection)

**Sequencing:** No dependencies. Can start immediately.

---

### PR2: Tool Result Formatting and Runner Integration

**Branch:** `feat/tool-result-formatting`

**Files:**
- `internal/runner/runner.go` — Extend `ChatCompletionInput` with tool fields
- `internal/runner/openai_compatible/openai_compatible.go` — Add tool support to request/response handling
- `internal/runner/openai_compatible/tool_loop.go` — Tool-calling loop for helper-managed mode
- `internal/runner/openai_compatible/openai_compatible_test.go` — Extended tests
- `internal/runner/openai_compatible/tool_loop_test.go` — Loop tests
- `internal/protocol/protocol.go` — Add tool-call frame types

**Extended `ChatCompletionInput`:**

```go
type ChatCompletionInput struct {
    Model       string        `json:"model,omitempty"`
    Messages    []ChatMessage `json:"messages"`
    Temperature *float64      `json:"temperature,omitempty"`
    MaxTokens   *int          `json:"max_tokens,omitempty"`
    Stream      *bool         `json:"stream,omitempty"`
    // New fields for tool calling:
    Tools           []ToolSpec      `json:"tools,omitempty"`
    ToolDefinitions []ToolDefinition `json:"tool_definitions,omitempty"`
    ToolCallingMode string          `json:"tool_calling_mode,omitempty"` // "helper_managed" | "cloud_managed"
    ToolCallingConfig *ToolCallingConfig `json:"tool_calling_config,omitempty"`
}

type ToolSpec struct {
    Type     string       `json:"type"`
    Function ToolFunction `json:"function"`
}

type ToolFunction struct {
    Name        string         `json:"name"`
    Description string         `json:"description"`
    Parameters  map[string]any `json:"parameters"`
}

type ToolDefinition struct {
    Name             string         `json:"name"`
    Description      string         `json:"description"`
    ParametersSchema map[string]any `json:"parameters_schema"`
    ExecutionKind    string         `json:"execution_kind"`
    ExecutionConfig  map[string]any `json:"execution_config"`
}

type ToolCallingConfig struct {
    MaxIterations    int `json:"max_iterations"`
    TimeoutPerToolMs int `json:"timeout_per_tool_ms"`
    TotalTimeoutMs   int `json:"total_timeout_ms"`
}

// Extended ChatMessage to support tool roles
type ChatMessage struct {
    Role       string      `json:"role"`
    Content    string      `json:"content"`
    ToolCalls  []ToolCall  `json:"tool_calls,omitempty"`
    ToolCallID string      `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
    ID       string       `json:"id"`
    Type     string       `json:"type"`
    Function ToolCallFunc `json:"function"`
}

type ToolCallFunc struct {
    Name      string `json:"name"`
    Arguments string `json:"arguments"` // JSON string
}
```

**Tool-calling loop in `tool_loop.go`:**

```go
func (r *Runner) dispatchWithTools(
    ctx context.Context,
    input ChatCompletionInput,
    executor *tool.Executor,
    emit func(event any) error,
) error {
    messages := input.Messages
    tools := translateToolDefinitions(input.ToolDefinitions)
    maxIter := 10
    if input.ToolCallingConfig != nil && input.ToolCallingConfig.MaxIterations > 0 {
        maxIter = input.ToolCallingConfig.MaxIterations
    }

    for i := 0; i < maxIter; i++ {
        response, err := r.chatWithTools(ctx, input.Model, messages, tools)
        if err != nil {
            return err
        }

        if len(response.ToolCalls) == 0 {
            // Final response — emit output and complete
            return emitFinalResponse(response, emit)
        }

        // Execute each tool call
        for _, tc := range response.ToolCalls {
            emit(ToolCallStartedEvent{...})
            result := executor.Execute(ctx, tool.CallRequest{...})
            emit(ToolCallCompletedEvent{...})

            // Append assistant message with tool_calls + tool result message
            messages = appendToolMessages(messages, response, tc, result)
        }
    }

    return &runner.Error{Kind: runner.ErrorKindProvider, Message: "tool calling loop exceeded max iterations"}
}
```

**Response parsing changes in `openai_compatible.go`:**

The `completionResponse` and `streamChunk` structs need to be extended to parse `tool_calls`:

```go
type completionResponse struct {
    Choices []struct {
        Message struct {
            Content   string     `json:"content"`
            ToolCalls []ToolCall `json:"tool_calls,omitempty"`
        } `json:"message"`
        FinishReason string `json:"finish_reason"`
    } `json:"choices"`
}
```

When `finish_reason` is `"tool_calls"` (or `"stop"` with `tool_calls` present), the runner enters the tool loop instead of emitting a final response.

**New protocol frame types:**

```go
const (
    // ... existing types ...
    TypeToolCallRequest    = "tool_call_request"
    TypeToolExecRequest    = "tool_execution_request"
    TypeToolCallResult     = "tool_call_result"
)

type ToolCallRequestFrame struct {
    CorrelatedFrame
    ToolCalls []ToolCallInfo `json:"tool_calls"`
}

type ToolExecutionRequestFrame struct {
    CorrelatedFrame
    ToolCallID      string         `json:"tool_call_id"`
    Name            string         `json:"name"`
    Arguments       map[string]any `json:"arguments"`
    ExecutionKind   string         `json:"execution_kind"`
    ExecutionConfig map[string]any `json:"execution_config"`
}

type ToolCallResultFrame struct {
    CorrelatedFrame
    ToolCallID string `json:"tool_call_id"`
    Success    bool   `json:"success"`
    Output     string `json:"output"`
    DurationMs int64  `json:"duration_ms"`
}
```

**Prompt-based fallback:**

For models that don't support native tool calling (return 400 when `tools` is in the request), the runner:
1. Removes `tools` from the API request
2. Prepends a system message with tool descriptions and JSON response format instructions
3. After each model response, parses the text for `{"tool_call": {"name": "...", "arguments": {...}}}`
4. If found, executes the tool and appends the result, loops
5. If not found, treats as final response

```go
func (r *Runner) dispatchWithPromptBasedTools(
    ctx context.Context,
    input ChatCompletionInput,
    executor *tool.Executor,
    emit func(event any) error,
) error {
    messages := prependToolSystemMessage(input.Messages, input.ToolDefinitions)
    // ... same loop but parse tool calls from text instead of structured response
}
```

**Acceptance criteria:**
- [ ] `ChatCompletionInput` extended with tool fields
- [ ] `ChatMessage` supports `tool_calls` and `tool_call_id` for multi-turn tool messages
- [ ] OpenAI-compatible runner sends `tools` in request when present
- [ ] Response parsing extracts `tool_calls` from completion response
- [ ] Tool-calling loop executes tools via `Executor` and loops back to model
- [ ] Progress events emitted for each tool call (tool.started, tool.completed)
- [ ] Prompt-based fallback activated when model returns 400 with tools
- [ ] Protocol frame types added for cloud-managed mode
- [ ] Streaming responses with tool calls handled correctly (aggregate deltas)
- [ ] Tests cover: single tool call, multiple tool calls, max iterations, prompt-based fallback

**Sequencing:** Depends on PR1 (executor).

---

### PR3: Security and Sandboxing

**Branch:** `feat/tool-sandboxing`

**Files:**
- `internal/tool/sandbox.go` — Path validation, command sanitization
- `internal/tool/sandbox_test.go` — Security-focused tests
- `internal/config/config.go` — Tool execution config in `runtime.toml`

**Sandbox rules:**

```go
package tool

// Sandbox validates and constrains tool execution to safe boundaries.
type Sandbox struct {
    // WorkspacePath is the root directory. All file paths must resolve within it.
    WorkspacePath string

    // AllowedCommands is the shell command allowlist. If empty, a default safe
    // set is used. If set to ["*"], all commands are allowed.
    AllowedCommands []string

    // DeniedCommands is always enforced even if AllowedCommands contains "*".
    DeniedCommands []string

    // MaxReadBytes caps file read size.
    MaxReadBytes int64

    // MaxWriteBytes caps file write size.
    MaxWriteBytes int64

    // CommandTimeoutMs caps individual command execution time.
    CommandTimeoutMs int64

    // AllowedGitOperations restricts which git subcommands are permitted.
    AllowedGitOperations []string
}

// ValidatePath checks that a path resolves within the workspace root.
// Follows symlinks and rejects any path that escapes the workspace.
func (s *Sandbox) ValidatePath(path string) (string, error)

// ValidateCommand checks that a command is in the allowlist and not in the denylist.
func (s *Sandbox) ValidateCommand(command string) error

// ValidateGitOperation checks that a git subcommand is allowed.
func (s *Sandbox) ValidateGitOperation(operation string) error
```

**Default safe command allowlist:**

```go
var DefaultAllowedCommands = []string{
    "ls", "cat", "head", "tail", "find", "grep", "wc", "sort", "uniq",
    "diff", "echo", "pwd", "date", "env",
    "node", "npm", "npx", "yarn", "pnpm",
    "python", "python3", "pip", "pip3",
    "go", "cargo", "rustc",
    "make", "cmake",
    "git",
    "curl", "wget",
    "jq", "sed", "awk",
    "tar", "zip", "unzip",
    "mkdir", "cp", "mv", "touch",
}

var DefaultDeniedCommands = []string{
    "rm -rf /", "rm -rf ~", "rm -rf $HOME",
    "shutdown", "reboot", "halt",
    "dd",
    "mkfs", "fdisk",
    "chmod 777",
    "> /dev/sda",
}

var DefaultAllowedGitOps = []string{
    "status", "diff", "log", "show", "branch", "tag",
    "add", "commit", "stash", "checkout", "switch",
    "pull", "fetch", "merge", "rebase",
    "push",
}
```

**Path validation:**

```go
func (s *Sandbox) ValidatePath(requestedPath string) (string, error) {
    // 1. Resolve relative to workspace root
    absPath := filepath.Join(s.WorkspacePath, requestedPath)

    // 2. Evaluate symlinks to get real path
    realPath, err := filepath.EvalSymlinks(absPath)
    if err != nil {
        // For new files, evaluate parent directory
        realPath, err = evalParentSymlinks(absPath)
        if err != nil {
            return "", fmt.Errorf("path validation failed: %w", err)
        }
    }

    // 3. Resolve the workspace root, failing closed if the root cannot be
    // resolved because a missing or broken workspace makes boundary checks
    // unreliable.
    realWorkspace, err := filepath.EvalSymlinks(s.WorkspacePath)
    if err != nil {
        return "", fmt.Errorf("workspace path validation failed: %w", err)
    }

    // 4. Check that real path is within workspace
    if !strings.HasPrefix(realPath, realWorkspace+string(filepath.Separator)) &&
       realPath != realWorkspace {
        return "", fmt.Errorf("path %q escapes workspace boundary", requestedPath)
    }

    return realPath, nil
}
```

**Config in `runtime.toml`:**

```toml
[tool_execution]
workspace_path = "/path/to/workspace"
max_read_bytes = 10485760      # 10MB
max_write_bytes = 10485760     # 10MB
command_timeout_ms = 30000     # 30s
allowed_commands = []          # empty = use defaults
denied_commands = []           # empty = use defaults
allowed_git_operations = []    # empty = use defaults
```

**Acceptance criteria:**
- [ ] Path traversal attacks blocked (`../`, symlink escape, absolute path outside workspace)
- [ ] Shell commands validated against allowlist before execution
- [ ] Denied commands always blocked even with permissive allowlist
- [ ] Command execution enforces timeout via `context.WithTimeout`
- [ ] File read/write size limits enforced
- [ ] Git operations validated against operation allowlist
- [ ] Config loaded from `runtime.toml`
- [ ] Tests cover: path traversal (20+ cases), symlink escape, command injection, timeout enforcement
- [ ] All sandbox failures return structured errors (not panics)

**Sequencing:** Can start in parallel with PR1. Must merge before PR2 (executor uses sandbox).

---

## Sequencing Diagram

```
PR1: Tool Executor    PR3: Security/Sandboxing
         |                      |
         v                      v
         +----------+-----------+
                    |
                    v
        PR2: Tool Result Formatting
            + Runner Integration
            + Tool-Calling Loop
```

PR1 and PR3 can be developed in parallel. PR2 integrates both.

## Cross-Cutting Concerns

### Prompt-based fallback detection

The helper should detect when a model doesn't support native tool calling and automatically fall back:

1. **Try with tools**: Send request with `tools` field
2. **If 400/422 error mentioning "tools" or "functions"**: Retry without `tools`, using prompt-based approach
3. **Cache the result**: Remember that this model/endpoint doesn't support tools to skip the failed attempt on subsequent calls

```go
// modelToolSupport tracks which models support native tool calling.
var modelToolSupport = sync.Map{} // map[string]bool

func supportsNativeTools(model string) *bool {
    if v, ok := modelToolSupport.Load(model); ok {
        b := v.(bool)
        return &b
    }
    return nil // unknown, try and detect
}
```

### Streaming with tool calls

When the model streams a response with tool calls, the delta format differs from text deltas:

```json
{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_abc", "function": {"name": "read", "arguments": ""}}]}}]}
{"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"pa"}}]}}]}
{"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "th\": \"src"}}]}}]}
{"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "/main.ts\"}"}}]}}]}
{"choices": [{"finish_reason": "tool_calls"}]}
```

The runner must aggregate `tool_calls` deltas across chunks before executing. The `streamChunk` struct needs to be extended:

```go
type streamChunk struct {
    Choices []struct {
        Delta struct {
            Content   string             `json:"content"`
            ToolCalls []StreamToolCall    `json:"tool_calls,omitempty"`
        } `json:"delta"`
        FinishReason string `json:"finish_reason"`
    } `json:"choices"`
}

type StreamToolCall struct {
    Index    int    `json:"index"`
    ID       string `json:"id,omitempty"`
    Type     string `json:"type,omitempty"`
    Function struct {
        Name      string `json:"name,omitempty"`
        Arguments string `json:"arguments,omitempty"`
    } `json:"function"`
}
```

### Error handling

| Error | Handling |
|-------|----------|
| File not found | Return structured error as tool result: `{"error": "file not found: src/missing.ts"}` |
| Path traversal attempt | Return error, log security warning |
| Command not in allowlist | Return error as tool result |
| Command timeout | Kill process, return timeout error as tool result |
| Model returns invalid JSON arguments | Return parse error as tool result |
| Unknown execution_kind | Return unsupported error as tool result |

### Observability

Each tool execution should log:

```go
log.Info("tool_executed",
    "tool_name", req.Name,
    "execution_kind", def.ExecutionKind,
    "success", result.Success,
    "duration_ms", result.DurationMs,
    "output_size_bytes", len(result.Output),
    "workspace", executor.workspacePath,
    "model", currentModel,
    "iteration", loopIteration,
)
```

Security-relevant events should log at Warn level:

```go
log.Warn("tool_sandbox_violation",
    "tool_name", req.Name,
    "violation", "path_traversal",
    "requested_path", requestedPath,
    "resolved_path", resolvedPath,
    "workspace", executor.workspacePath,
)
```
