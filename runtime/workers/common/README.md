# Common worker runtime assets

These files are copied from the Symphony Elixir service and define how a coding worker session is started and run:

- symphony_elixir/agent_runner.ex — worker process orchestration for an issue
- symphony_elixir/codex/app_server.ex — starts Codex app-server and sessions
- symphony_elixir/workspace.ex — workspace creation/cleanup and hooks
- symphony_elixir/ssh.ex — remote SSH command helpers

The active Parallel Agent Runtime orchestrator uses the same source under apps/orchestrator.
