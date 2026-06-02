#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.run-logs"

# shellcheck source=./local-env.sh
. "$ROOT_DIR/scripts/local-env.sh"
load_local_env "$ROOT_DIR"

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:latest}"
OLLAMA_OPENAI_BASE_URL="${OLLAMA_OPENAI_BASE_URL:-${OLLAMA_HOST%/}/v1}"
OLLAMA_API_KEY="${OLLAMA_API_KEY:-ollama}"
SKIP_OLLAMA_PULL="${SKIP_OLLAMA_PULL:-0}"
LOCAL_RUNTIME_HELPER_COMMAND="${LOCAL_RUNTIME_HELPER_COMMAND:-}"
LOCAL_RUNTIME_HELPER_HEALTH_URL="${LOCAL_RUNTIME_HELPER_HEALTH_URL:-}"
START_LOCAL_RUNTIME="${START_LOCAL_RUNTIME:-0}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-45}"

mkdir -p "$LOG_DIR"

PIDS=()
CLEANUP_DONE=0

cleanup() {
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    return
  fi
  CLEANUP_DONE=1

  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  wait "${PIDS[@]}" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

wait_for_url() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[local-ollama-qwen-smoke] ${name} is ready: ${url}"
      return 0
    fi
    sleep 1
  done

  echo "[local-ollama-qwen-smoke] timed out waiting for ${name}: ${url}" >&2
  return 1
}

ensure_ollama() {
  if curl -fsS "${OLLAMA_HOST%/}/api/tags" >/dev/null 2>&1; then
    echo "[local-ollama-qwen-smoke] Ollama is already running at ${OLLAMA_HOST}"
  else
    if ! command -v ollama >/dev/null 2>&1; then
      echo "[local-ollama-qwen-smoke] Ollama is not running and the ollama CLI is not on PATH" >&2
      exit 1
    fi

    echo "[local-ollama-qwen-smoke] starting ollama serve"
    OLLAMA_HOST="$OLLAMA_HOST" ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
    PIDS+=("$!")
    wait_for_url "Ollama" "${OLLAMA_HOST%/}/api/tags"
  fi

  if [ "$SKIP_OLLAMA_PULL" != "1" ]; then
    echo "[local-ollama-qwen-smoke] ensuring model is available: ${OLLAMA_MODEL}"
    OLLAMA_HOST="$OLLAMA_HOST" ollama pull "$OLLAMA_MODEL"
  fi
}

start_optional_helper() {
  if [ -z "$LOCAL_RUNTIME_HELPER_COMMAND" ]; then
    echo "[local-ollama-qwen-smoke] LOCAL_RUNTIME_HELPER_COMMAND is not set; skipping helper startup"
    return
  fi

  echo "[local-ollama-qwen-smoke] starting local runtime helper"
  (
    cd "$ROOT_DIR"
    eval "$LOCAL_RUNTIME_HELPER_COMMAND"
  ) >"$LOG_DIR/local-runtime-helper.log" 2>&1 &
  PIDS+=("$!")

  if [ -n "$LOCAL_RUNTIME_HELPER_HEALTH_URL" ]; then
    wait_for_url "local runtime helper" "$LOCAL_RUNTIME_HELPER_HEALTH_URL"
  fi
}

start_optional_runtime() {
  if [ "$START_LOCAL_RUNTIME" != "1" ]; then
    echo "[local-ollama-qwen-smoke] START_LOCAL_RUNTIME is not 1; using the direct provider smoke only"
    return
  fi

  echo "[local-ollama-qwen-smoke] starting local runtime stack"
  (
    cd "$ROOT_DIR"
    pnpm run start:local
  ) >"$LOG_DIR/local-runtime-stack.log" 2>&1 &
  PIDS+=("$!")

  wait_for_url "orchestrator" "http://127.0.0.1:${ORCHESTRATOR_PORT:-4000}/api/v1/health"
}

ensure_ollama
start_optional_helper
start_optional_runtime

echo "[local-ollama-qwen-smoke] running normalized event assertion"
(
  cd "$ROOT_DIR/apps/orchestrator"
  SYMPHONY_LOCAL_MODEL_BASE_URL="$OLLAMA_OPENAI_BASE_URL" \
    SYMPHONY_LOCAL_MODEL_NAME="$OLLAMA_MODEL" \
    SYMPHONY_LOCAL_MODEL_API_KEY="$OLLAMA_API_KEY" \
    mix local_model.smoke
)

echo "[local-ollama-qwen-smoke] success"
