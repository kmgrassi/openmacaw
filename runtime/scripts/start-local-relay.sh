#!/usr/bin/env bash
# Start the local runtime stack with the local-relay workflow.
# This uses Runner.LocalRelay with an openai_compatible provider (Ollama).
#
# Prerequisites:
#   - Ollama running with a model (e.g. qwen3-coder:30b)
#   - local-runtime-helper running and authenticated with token lrh_dev_local_token_2026
#     (detached mode starts ../local-runtime-helper automatically by default)
#
# Environment overrides:
#   WORKFLOW_PATH        — path to WORKFLOW file (default: ./WORKFLOW.local-relay.md)
#   LAUNCHER_PORT        — launcher port (default: 4100)
#   ORCHESTRATOR_PORT    — orchestrator port (default: 4000)
set -euo pipefail

export WORKFLOW_PATH="${WORKFLOW_PATH:-./WORKFLOW.local-relay.md}"
while [ "${1:-}" = "--" ]; do
  shift
done

if [ "${1:-}" = "--detached" ] || [ "${1:-}" = "--restart" ]; then
  export START_HELPER="${START_HELPER:-1}"
fi

exec "$(dirname "$0")/start-local-runtime.sh" "$@"
