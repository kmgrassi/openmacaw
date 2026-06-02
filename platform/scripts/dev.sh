#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
CLEANUP_DONE=0

API_LOG_DIR="$ROOT_DIR/.run-logs"
mkdir -p "$API_LOG_DIR"

# Default ports are 3100 (api) and 5173 (web) for the main worktree. Linked
# worktrees derive a per-worktree offset from their absolute path so multiple
# dev servers can run side by side without stomping on each other. Either can
# be overridden by setting API_PORT / WEB_PORT in the environment.
derive_ports() {
  if [ -n "${API_PORT:-}" ] && [ -n "${WEB_PORT:-}" ]; then
    return 0
  fi

  local git_dir
  local git_common_dir
  git_dir="$(git -C "$ROOT_DIR" rev-parse --absolute-git-dir 2>/dev/null || true)"
  git_common_dir="$(git -C "$ROOT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"

  # --git-common-dir can be returned relative to ROOT_DIR (e.g. ".git" when
  # invoked from inside the main worktree). Resolve to absolute before
  # comparing against --absolute-git-dir.
  if [ -n "$git_common_dir" ]; then
    case "$git_common_dir" in
      /*) ;;
      *) git_common_dir="$ROOT_DIR/$git_common_dir" ;;
    esac
    if [ -d "$git_common_dir" ]; then
      git_common_dir="$(cd "$git_common_dir" && pwd -P)"
    fi
  fi

  local is_main_worktree=0
  if [ -n "$git_dir" ] && [ "$git_dir" = "$git_common_dir" ]; then
    is_main_worktree=1
  fi

  if [ "$is_main_worktree" -eq 1 ]; then
    API_PORT="${API_PORT:-3100}"
    WEB_PORT="${WEB_PORT:-5173}"
    WORKTREE_KIND="main"
  else
    local hash_hex
    local offset
    hash_hex="$(printf '%s' "$ROOT_DIR" | shasum -a 1 | cut -c1-4)"
    # Range 1..80 — keeps API in 3101-3180 and web in 5174-5253. Collisions
    # between two worktrees just trigger the foreign-process error below; user
    # can then set API_PORT / WEB_PORT explicitly.
    offset=$(( 0x$hash_hex % 80 + 1 ))
    API_PORT="${API_PORT:-$((3100 + offset))}"
    WEB_PORT="${WEB_PORT:-$((5173 + offset))}"
    WORKTREE_KIND="linked"
  fi
}

derive_ports

quote_shell() {
  printf '%q' "$1"
}

find_local_env_file() {
  local direct_path="$ROOT_DIR/.env"
  local worktree_path
  local candidate_path

  if [ -f "$direct_path" ]; then
    echo "$direct_path"
    return 0
  fi

  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        worktree_path="${line#worktree }"
        candidate_path="$worktree_path/.env"
        if [ "$worktree_path" != "$ROOT_DIR" ] && [ -f "$candidate_path" ]; then
          echo "$candidate_path"
          return 0
        fi
        ;;
    esac
  done < <(git -C "$ROOT_DIR" worktree list --porcelain 2>/dev/null || true)
}

build_env_source_command() {
  local root_env_file
  local command="set -a;"

  root_env_file="$(find_local_env_file)"

  if [ -n "$root_env_file" ]; then
    command="$command . $(quote_shell "$root_env_file");"
  fi

  command="$command set +a;"
  echo "$command"
}

print_env_source_summary() {
  local root_env_file

  root_env_file="$(find_local_env_file)"

  if [ -n "$root_env_file" ]; then
    echo "Env: $root_env_file"
  else
    echo "Env: <none>"
  fi
}

is_port_in_use() {
  lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1
}

port_pids() {
  lsof -iTCP:"$1" -sTCP:LISTEN -n -P -t 2>/dev/null || true
}

describe_pids() {
  local port="$1"
  local -a pids
  local pid
  local command_line

  for pid in $(port_pids "$port"); do
    pids+=("$pid")
  done

  if [ ${#pids[@]} -eq 0 ]; then
    return 0
  fi

  echo "Current listeners on port ${port}:"
  for pid in "${pids[@]}"; do
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    printf '  PID=%s command=%s\n' "$pid" "${command_line:-<unknown>}"
  done
}

process_worktree_path() {
  local pid="$1"
  local cwd_path

  cwd_path="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | awk '/^n/ {print substr($0, 2); exit}' || true)"
  if [ -z "$cwd_path" ]; then
    return 1
  fi
  printf '%s' "$cwd_path"
}

is_our_process() {
  # A listener is "ours" only if its current working directory lives inside
  # THIS worktree. The old substring check on the command line matched any
  # dev server from any worktree of this repo, which let parallel worktrees
  # silently kill each other's API/web processes.
  local pid="$1"
  local cwd_path

  cwd_path="$(process_worktree_path "$pid" || true)"
  if [ -z "$cwd_path" ]; then
    return 1
  fi

  case "$cwd_path" in
    "$ROOT_DIR"|"$ROOT_DIR"/*) return 0 ;;
  esac
  return 1
}

kill_if_port_bound_to_us() {
  local port="$1"
  local service="$2"
  local -a detected_pids
  local -a our_pids
  local -a foreign_pids
  local pid
  local foreign_cwd
  local timeout_seconds=15
  local elapsed=0

  for pid in $(port_pids "$port"); do
    detected_pids+=("$pid")
    if is_our_process "$pid"; then
      our_pids+=("$pid")
    else
      foreign_pids+=("$pid")
    fi
  done

  if [ ${#detected_pids[@]} -eq 0 ]; then
    return 0
  fi

  if [ ${#foreign_pids[@]} -gt 0 ]; then
    echo "❌ Cannot start ${service}: port ${port} is in use by another process."
    for pid in "${foreign_pids[@]}"; do
      foreign_cwd="$(process_worktree_path "$pid" 2>/dev/null || true)"
      if [ -n "$foreign_cwd" ]; then
        echo "   PID ${pid} (cwd=${foreign_cwd})"
      fi
    done
    describe_pids "$port"
    if [ "$service" = "api" ]; then
      echo "   This worktree's API was assigned port ${port}. If another worktree's"
      echo "   dev server is on this port, stop it there or rerun with: API_PORT=<n> pnpm run dev"
    else
      echo "   This worktree's web was assigned port ${port}. If another worktree's"
      echo "   dev server is on this port, stop it there or rerun with: WEB_PORT=<n> pnpm run dev"
    fi
    exit 1
  fi

  echo "Detected running ${service} process(es) from this worktree on port ${port}; restarting."
  for pid in "${our_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  while is_port_in_use "$port" && [ "$elapsed" -lt "$timeout_seconds" ]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if is_port_in_use "$port"; then
    echo "❌ Could not free port ${port} after stopping old ${service} process(es)."
    describe_pids "$port"
    exit 1
  fi
}

show_port_hint() {
  local port="$1"
  local service="$2"
  echo "❌ Cannot start ${service}: fixed port ${port} is already in use."
  echo "   To see processes on this port:"
  echo "   lsof -nP -iTCP:${port} -sTCP:LISTEN"
  echo "   To stop one of them (example):"
  echo "   kill <PID>"
}

kill_if_port_bound_to_us "$API_PORT" "api"
kill_if_port_bound_to_us "$WEB_PORT" "web"

API_ENV_CMD="$(build_env_source_command)"
WEB_ENV_CMD="$(build_env_source_command)"

API_CMD="(cd \"$ROOT_DIR/apps/api\" && \
  $API_ENV_CMD \
  NODE_ENV=development \
  HOST=127.0.0.1 \
  PORT=$API_PORT \
  CHOKIDAR_USEPOLLING=1 \
  CORS_ORIGINS=\"\${CORS_ORIGINS:-http://127.0.0.1:5173,http://localhost:5173},http://127.0.0.1:$WEB_PORT,http://localhost:$WEB_PORT\" \
  pnpm run dev)"

WEB_CMD="(cd \"$ROOT_DIR/apps/web\" && \
  $WEB_ENV_CMD \
  NODE_ENV=development \
  CHOKIDAR_USEPOLLING=1 \
  WATCHPACK_POLLING=1 \
  VITE_BROKER_BASE=http://127.0.0.1:$API_PORT \
  VITE_GATEWAY_WS_URL=ws://127.0.0.1:$API_PORT/ws \
  pnpm run dev --host 127.0.0.1 --port $WEB_PORT --strictPort)"

echo "Starting API and web locally from $ROOT_DIR (${WORKTREE_KIND:-main} worktree)"
echo "API port: $API_PORT  Web port: $WEB_PORT"
if [ "${WORKTREE_KIND:-main}" = "linked" ]; then
  echo "  (linked worktree — ports derived from path; override with API_PORT / WEB_PORT)"
fi
print_env_source_summary
echo "API:  $API_CMD"
echo "WEB:  $WEB_CMD"

echo "> starting API"
bash -lc "$API_CMD" 2>&1 | tee -a "$API_LOG_DIR/api.log" &
API_PID=$!

echo "> starting WEB"
bash -lc "$WEB_CMD" 2>&1 | tee -a "$API_LOG_DIR/web.log" &
WEB_PID=$!

cleanup() {
  if [[ "$CLEANUP_DONE" -eq 1 ]]; then
    return
  fi
  CLEANUP_DONE=1
  printf '\nStopping processes...\n'
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

echo "Running."
echo "Logs:"
echo "  API:  $API_LOG_DIR/api.log"
echo "  WEB:  $API_LOG_DIR/web.log"
echo "Press Ctrl+C to stop both."

echo "API: http://127.0.0.1:${API_PORT}"
echo "Web: http://127.0.0.1:${WEB_PORT}"

while true; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API process exited."
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Web process exited."
    break
  fi
  sleep 1
done
cleanup
