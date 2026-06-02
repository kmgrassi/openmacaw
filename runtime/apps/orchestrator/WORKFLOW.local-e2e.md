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
  root: /tmp/symphony-local-e2e
agent:
  max_concurrent_agents: 1
  max_turns: 1
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
server:
  host: "127.0.0.1"
---

Create a file named LOCAL_E2E_RESULT.txt in the workspace containing the issue identifier and the text local launcher smoke test.
