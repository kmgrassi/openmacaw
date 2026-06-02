# Agent Tool Grant Data Model - Local Helper Scope

## Goal

Keep `local-runtime-helper` aligned with the new tool policy model without
making the helper a database policy owner.

The helper should treat incoming dispatch tool definitions as already resolved
from Platform/Runtime effective grants:

```text
Harper/Platform: agent_tool_grant -> effective tool definitions
Runtime: dispatch frame with effective tool definitions
Helper: execute or forward only those definitions
```

The helper must not read `tool_policy_template`, `tool_policy_template_tool`, or
`agent_tool_grant` directly.

## Current Helper Surfaces

### Wire Protocol Types

Files:

- `internal/runner/runner.go`
- `internal/protocol/*`
- `docs/universal-tool-calling-plan.md`
- `docs/unified-tool-contract-helper-prs.md`

Needed changes:

- Clarify that `tool_definitions` and `provider_tool_specs` are effective
  per-turn grants.
- Do not add template IDs as required fields.
- If Platform/Runtime sends grant provenance, parse it as optional metadata and
  ignore it for execution decisions.

### OpenAI-Compatible Runner

Files:

- `internal/runner/openai_compatible/openai_compatible.go`
- `internal/runner/openai_compatible/tool_loop.go`
- `internal/runner/openai_compatible/openai_compatible_test.go`

Needed changes:

- Continue sending only the provided `ProviderToolSpecs`/translated effective
  tool definitions to the model.
- Native tool calls and prompt-fallback tool calls must be matched against the
  incoming effective tool definition list.
- A tool absent from the dispatch frame must not be executable, regardless of
  whether the helper knows how to run it locally.

### Helper-Managed Execution

Files:

- `internal/tool/*` if present in the branch being changed
- `internal/runner/openai_compatible/tool_loop.go`

Needed changes:

- Execution remains a pure function of the dispatch-provided tool definition:
  `execution_kind`, name, parameters, and helper/runtime-managed mode.
- Do not add role defaults such as "coding agents always get shell.exec".
- Keep sandbox and command allowlist checks independent from grant resolution.

### Runtime-Managed Tool Forwarding

Files:

- `internal/runner/openai_compatible/tool_loop.go`
- `internal/runner/runner.go`

Needed changes:

- For runtime-managed/external tools, forward calls only when the tool exists in
  the effective dispatch definitions.
- Tool call request frames should not mention templates. They may include the
  tool name, arguments, call ID, and optional grant provenance if Runtime adds
  it.

### Doctor And Config

Files:

- `cmd/local-runtime-helper/doctor.go`
- `cmd/local-runtime-helper/config_file.go`
- `internal/config/config.go`
- `docs/install.md`
- `docs/local-runtime-helper-pr-plan.md`

Needed changes:

- No DB configuration should be added for grants/templates.
- Doctor checks should stay focused on local endpoint/model/helper capability.
- If a user is missing a tool, the helper should surface that the dispatch did
  not include it rather than suggesting local config changes.

## Helper PR Sequence

### HELPER-1 - Documentation Cleanup

- Replace old bundle/override language in helper docs.
- State that the helper consumes effective grant-derived tool definitions.

### HELPER-2 - Contract Tests

- Add or update tests proving absent tools in the dispatch frame cannot be
  called.
- Keep mixed helper-managed/runtime-managed tests based on tool definition
  metadata.

### HELPER-3 - Optional Provenance Support

Only if Runtime decides to include grant provenance on tool definitions:

- Add optional fields to the parsed tool definition shape.
- Do not use provenance to authorize execution.
- Preserve provenance in logs/progress only if it contains no secrets.

## Verification

- `go test ./...`
- focused OpenAI-compatible runner tests:
  - native tool call for included tool succeeds
  - native tool call for absent tool is denied
  - prompt-fallback tool call for absent tool is denied
  - runtime-managed tool calls are forwarded only when present in dispatch
