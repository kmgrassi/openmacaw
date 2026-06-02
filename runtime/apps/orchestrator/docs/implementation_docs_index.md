# Symphony Extension & Implementation Docs

Use these docs to plan and execute the next execution engine stage.

- [implementation_gaps_and_backlog.md](implementation_gaps_and_backlog.md)
  - Section-by-section gap map aligned to this repo’s spec.
- [model-agnostic-lift-plan.md](model-agnostic-lift-plan.md)
  - Concrete migration plan for moving from OpenAI/Codex-specific execution to provider-agnostic orchestration.
- [model-agnostic-agent-refactor-pr-plan.md](model-agnostic-agent-refactor-pr-plan.md)
  - Cross-repo PR plan for resolver-backed execution profiles, central
    planning-agent delegation, provider adapters, and model-agnostic planning
    and coding agents.
- [local-model-first-class-pr-plan.md](local-model-first-class-pr-plan.md)
  - Runtime PR plan for making local OpenAI-compatible models such as
    Ollama/Qwen first-class execution backends through local relay, helper
    daemon, capability probes, and normalized events.
- [local-model-coding-runner-scope.md](local-model-coding-runner-scope.md)
  - Runtime scope and PR plan for local OpenAI-compatible coding agents where
    Runtime owns the tool loop, shell/file/git execution, approvals, and
    workspace boundaries without relying on Codex app-server.
- [local-model-coding-smoke-harness.md](local-model-coding-smoke-harness.md)
  - Manual PR7 smoke flow for local OpenAI-compatible coding models using
    Runtime-owned `apply_patch` and `shell.exec` tools in a disposable workspace.
- [local-model-coding-tool-contract.md](local-model-coding-tool-contract.md)
  - R1 coding tool contract for `shell.exec`, `apply_patch`, command-action
    classification, approval outcomes, and normalized command/file-change
    events.
- [end-to-end-logging-improvement-pr-plan.md](../../../docs/end-to-end-logging-improvement-pr-plan.md)
  - Runtime-owned PR slices from the platform end-to-end logging plan:
    database request logs, launcher lifecycle logs, model-provider logs, tool
    execution logs, diagnostic summaries, production alarms, and smoke tests.
- [claude-code-coding-runner-pr-plan.md](claude-code-coding-runner-pr-plan.md)
  - Cross-repo PR plan for adding Claude Code / Claude Agent SDK as a coding
    runner selectable alongside OpenAI Codex through execution profiles.
- [backend-adapter-contract.md](backend-adapter-contract.md)
  - Backend contract for transport adapters, normalized run events, capability flags, and OpenClaw WS/SSE split.
- [backend-adapter-rollout-plan.md](backend-adapter-rollout-plan.md)
  - PR-scoped checklist for getting the backend-adapter architecture into the runtime incrementally.
- [planning-agent-scope.md](planning-agent-scope.md)
  - Scope-It plan for adding planning agents, planner_safe tools, custom OpenClaw targets, and repo-isolated PR slices.
- [planning-agent-readonly-architecture.md](planning-agent-readonly-architecture.md)
  - Updated architecture and PR plan for repo-aware planning agents with read-only repository tools and no code-writing capabilities.
- [planner-tool-contract.md](planner-tool-contract.md)
  - Runtime contract for planning-agent dynamic tools, schemas, and planner_safe tool policy.
- [planner-work-items-tool-scope.md](planner-work-items-tool-scope.md)
  - Scope for moving planner `task.*` tools from legacy `task` rows to
    `work_items` rows so returned IDs match plan review, coding handoff, and
    runtime routing.
- [agent-tool-source-of-truth-refactor.md](agent-tool-source-of-truth-refactor.md)
  - Refactor plan for moving agent tool assignment from hard-coded runtime profiles to database-backed `tool` and `agent_tool` records.
- [agent-tool-grant-data-model-runtime-scope.md](../../../docs/agent-tool-grant-data-model-runtime-scope.md)
  - Current runtime scope for treating `agent_tool_grant` rows as the
    effective model-facing tool set and `tool_policy_template` rows as
    write-time presets.
- [model-provider-swap.md](model-provider-swap.md)
  - Strategy to support multiple model providers behind a backend-adapter interface.
- [model-agnostic-smoke-harness.md](model-agnostic-smoke-harness.md)
  - Deterministic fixture and Mix task for the planning-provider to coding-provider handoff smoke path.
- [remote-worker-openclaw.md](remote-worker-openclaw.md)
  - Health-aware remote workers + OpenClaw chain execution model.
- [worker-bridge.md](worker-bridge.md)
  - First implementation slice for a credential-aware worker listener and session API.
- [worker_bridge_and_websocket_architecture.md](worker_bridge_and_websocket_architecture.md)
  - High-level split between launcher `worker-bridge`, runtime `/ws`, and platform session mapping.
- [react_frontend_integration.md](react_frontend_integration.md)
  - Frontend API contract for a dedicated React control plane.
- [runtime_websocket_gateway_contract.md](runtime_websocket_gateway_contract.md)
  - Runtime-side `/ws` contract for the API proxy and web client, including implemented methods, event shapes, and current gaps.
- `elixir/deploy/aws.json`
  - Reference AWS deployment topology and runtime parameters.
- [aws.md](../deploy/aws.md)
  - Practical AWS deployment notes for ECS/Fargate, Supabase, and CI/CD.
- [aws_supabase_deployment_and_ci_plan.md](aws_supabase_deployment_and_ci_plan.md)
  - Section-by-section lift plan for AWS + Supabase + GitHub Actions deployment.
- [aws_repo_cache_and_workspace_strategy.md](aws_repo_cache_and_workspace_strategy.md)
  - Phase-by-phase design for repo cache metadata, leases, mirrors, and session workspace materialization on AWS.
- [architecture-launcher-integration.md](../../docs/architecture-launcher-integration.md)
  - Cross-repo integration spec: Launcher process, API server proxy, orchestrator lifecycle, and AWS deployment topology.
- `elixir/deploy/terraform`
  - Reference Terraform state for ECS and autoscaling.

## Suggested next actions

1. Convert the docs into issue tickets by owner:
   - Platform/infra
   - Orchestration/runtime
   - Runner/provider layer
   - UI/API contract
2. Choose deployment target for first pilot:
   - ECS-only (current `aws.json` template)
   - ECS + remote worker nodes
   - ECS + OpenClaw bridge
3. Keep this repo’s current behavior backward compatible by making provider and remote-worker changes additive.
