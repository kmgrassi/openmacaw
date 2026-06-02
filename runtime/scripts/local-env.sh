#!/usr/bin/env bash

local_env_path() {
  local root_dir="$1"
  local repos_dir
  local candidate

  for candidate in \
    "$root_dir/apps/orchestrator/.env" \
    "$root_dir/.env" \
    "$HOME/.symphony/runtime.env" \
    "$HOME/.symphony/orchestrator.env"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  repos_dir="$(dirname "$root_dir")"

  for candidate in \
    "$repos_dir"/parallel-agent-runtime*/apps/orchestrator/.env \
    "$repos_dir"/parallel-agent-runtime*/.env; do
    if [ -f "$candidate" ] && [ "$(cd "$(dirname "$candidate")/../.." 2>/dev/null && pwd -P)" != "$(cd "$root_dir" && pwd -P)" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

load_local_env() {
  local root_dir="$1"
  local env_file

  if env_file="$(local_env_path "$root_dir")"; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
    printf '[local-runtime] loaded local env from %s\n' "$env_file"
  else
    printf '[local-runtime] no local env file found; continuing with process environment\n'
  fi
}
