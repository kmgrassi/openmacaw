#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  guard-supabase-prod-migration.sh [--project-ref <ref>] [--check-only] [--] <command> [args...]

Refuses to run production Supabase migration commands unless the checkout is a
clean main branch at origin/main. This is intended for break-glass/manual
production pushes; normal production migration applies should run from the
private deployment workflow.

Production project refs are read from OPENMACAW_PROD_SUPABASE_PROJECT_REFS,
comma-separated. If unset, the KG production ref is guarded by default.

Examples:
  platform/scripts/guard-supabase-prod-migration.sh --project-ref "$SUPABASE_PROJECT_ID" -- supabase db push
  OPENMACAW_PROD_SUPABASE_PROJECT_REFS=abc123 platform/scripts/guard-supabase-prod-migration.sh --check-only
USAGE
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
platform_dir="${repo_root}/platform"

exec_from_platform() {
  cd "${platform_dir}"
  exec "$@"
}

project_ref=""
check_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-ref)
      if [[ $# -lt 2 ]]; then
        echo "error: --project-ref requires a value" >&2
        exit 2
      fi
      project_ref="$2"
      shift 2
      ;;
    --check-only)
      check_only=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ -z "${project_ref}" && -f "${platform_dir}/supabase/.temp/project-ref" ]]; then
  project_ref="$(tr -d '[:space:]' < "${platform_dir}/supabase/.temp/project-ref")"
fi

prod_refs="${OPENMACAW_PROD_SUPABASE_PROJECT_REFS:-smaxrxamqpyvxbgeylko}"
is_prod_ref=0
IFS=',' read -r -a refs <<< "${prod_refs}"
for ref in "${refs[@]}"; do
  ref="$(echo "${ref}" | xargs)"
  if [[ -n "${ref}" && "${ref}" == "${project_ref}" ]]; then
    is_prod_ref=1
    break
  fi
done

if [[ "${is_prod_ref}" != "1" ]]; then
  echo "Supabase project '${project_ref:-unknown}' is not listed as production; no production guard required."
  if [[ "${check_only}" == "1" || $# -eq 0 ]]; then
    exit 0
  fi
  exec_from_platform "$@"
fi

branch="$(git -C "${repo_root}" branch --show-current)"
if [[ "${branch}" != "main" ]]; then
  cat >&2 <<EOF
error: refusing production Supabase migration from branch '${branch:-detached HEAD}'.

Production migrations must be applied from clean main at origin/main, preferably
through the private KG production deploy workflow.
EOF
  exit 1
fi

git -C "${repo_root}" fetch origin main --quiet
local_head="$(git -C "${repo_root}" rev-parse HEAD)"
remote_head="$(git -C "${repo_root}" rev-parse origin/main)"
if [[ "${local_head}" != "${remote_head}" ]]; then
  cat >&2 <<EOF
error: refusing production Supabase migration because local main is not origin/main.

local HEAD:  ${local_head}
origin/main: ${remote_head}
EOF
  exit 1
fi

if [[ -n "$(git -C "${repo_root}" status --porcelain)" ]]; then
  cat >&2 <<'EOF'
error: refusing production Supabase migration from a dirty checkout.

Commit or discard local changes first so the remote migration history cannot get
ahead of reviewed repository state.
EOF
  exit 1
fi

case "${repo_root}" in
  *"/.claude/worktrees/"*|*"/.codex/worktrees/"*|*"/worktrees/"*)
    cat >&2 <<EOF
error: refusing production Supabase migration from worktree path:
${repo_root}

Use the canonical repository checkout on clean main, or the private production
deploy workflow.
EOF
    exit 1
    ;;
esac

echo "Production Supabase migration guard passed for project ${project_ref} at ${local_head}."

if [[ "${check_only}" == "1" || $# -eq 0 ]]; then
  exit 0
fi

exec_from_platform "$@"
