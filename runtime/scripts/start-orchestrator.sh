#!/usr/bin/env bash
set -euo pipefail

DEFAULT_PORT="${ORCHESTRATOR_PORT:-4000}"

resolve_port() {
  local port="$DEFAULT_PORT"
  local expect_value=0

  for arg in "$@"; do
    if [ "$expect_value" -eq 1 ]; then
      port="$arg"
      expect_value=0
      continue
    fi

    case "$arg" in
      --port)
        expect_value=1
        ;;
      --port=*)
        port="${arg#--port=}"
        ;;
    esac
  done

  printf '%s\n' "$port"
}

free_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null) || true
  [ -z "$pids" ] && return 0

  echo "[orchestrator] killing existing process on port $port (pids: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs kill -9 2>/dev/null || true

  # Poll until the port is actually released (up to 5 seconds)
  local i=0
  while [ $i -lt 10 ]; do
    sleep 0.5
    lsof -ti:"$port" >/dev/null 2>&1 || return 0
    i=$((i + 1))
  done

  echo "[orchestrator] warning: port $port still in use after 5s, proceeding anyway" >&2
}

run_orchestrator() {
  local port="$1"
  shift
  local workflow_path="${WORKFLOW_PATH:-./WORKFLOW.md}"

  mix escript.build

  if command -v mise >/dev/null 2>&1; then
    echo "[orchestrator] launching with mise"
    exec mise exec -- ./bin/symphony "$workflow_path" --port "$port" "$@" \
      --i-understand-that-this-will-be-running-without-the-usual-guardrails
  else
    echo "[orchestrator] launching with mix fallback"
    exec ./bin/symphony "$workflow_path" --port "$port" "$@" \
      --i-understand-that-this-will-be-running-without-the-usual-guardrails
  fi
}

PORT="$(resolve_port "$@")"

free_port "$PORT"
run_orchestrator "$PORT" "$@"
