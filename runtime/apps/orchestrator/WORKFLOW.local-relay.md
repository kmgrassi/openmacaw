---
tracker:
  kind: api
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 1000
workspace:
  root: /tmp/symphony-local-relay
agent:
  max_concurrent_agents: 1
  max_turns: 1
execution_profile:
  runner_kind: local_relay
  target_runner_kind: openai_compatible
  provider: openai_compatible
  model: qwen3-coder:30b
  role: coding
  workspace_id: dev-workspace
server:
  host: "127.0.0.1"
---

Create a file named LOCAL_RELAY_RESULT.txt in the workspace containing the issue identifier and the text local relay smoke test.
