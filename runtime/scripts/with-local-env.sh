#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=./local-env.sh
. "$ROOT_DIR/scripts/local-env.sh"

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <cwd> <command> [args...]" >&2
  exit 64
fi

COMMAND_CWD="$1"
shift

load_local_env "$ROOT_DIR"

cd "$ROOT_DIR/$COMMAND_CWD"
exec "$@"
