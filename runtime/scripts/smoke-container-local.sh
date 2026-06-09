#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-openmacaw/container-coding-executor:local}"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openmacaw-container-smoke.XXXXXX")"

cleanup() {
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT

repo="$SMOKE_ROOT/workspace/repo"
mkdir -p "$repo"
printf 'before\n' > "$repo/message.txt"
cat > "$repo/test.sh" <<'SCRIPT'
#!/bin/sh
grep -q after message.txt
SCRIPT
chmod +x "$repo/test.sh"

cat > "$SMOKE_ROOT/request.json" <<'JSON'
{"existing_workspace":"repo"}
JSON

cat > "$SMOKE_ROOT/frames.jsonl" <<'JSONL'
{"type":"tool_execution_request","schema_version":"1","correlation_id":"smoke","tool_call_id":"call-read","name":"shell.exec","arguments":{"argv":["cat","message.txt"]}}
{"type":"tool_execution_request","schema_version":"1","correlation_id":"smoke","tool_call_id":"call-patch","name":"apply_patch","arguments":{"patch":"*** Begin Patch\n*** Update File: message.txt\n@@\n-before\n+after\n*** End Patch\n"}}
{"type":"tool_execution_request","schema_version":"1","correlation_id":"smoke","tool_call_id":"call-verify","name":"shell.exec","arguments":{"argv":["./test.sh"]}}
JSONL

docker build -f "$ROOT_DIR/apps/orchestrator/deploy/Dockerfile.container-executor" -t "$IMAGE_TAG" "$ROOT_DIR"

docker run --rm -i \
  -v "$SMOKE_ROOT/workspace:/workspace" \
  -v "$SMOKE_ROOT/request.json:/tmp/request.json:ro" \
  "$IMAGE_TAG" coding-executor --request-json /tmp/request.json < "$SMOKE_ROOT/frames.jsonl" > "$SMOKE_ROOT/output.jsonl"

node - "$SMOKE_ROOT/output.jsonl" "$repo/message.txt" <<'NODE'
const fs = require("fs");
const [outputPath, messagePath] = process.argv.slice(2);
const frames = fs.readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const results = frames.filter((frame) => frame.type === "tool_call_result");
if (results.length !== 3) {
  throw new Error(`expected 3 tool_call_result frames, got ${results.length}`);
}
for (const result of results) {
  if (result.success !== true) {
    throw new Error(`tool call ${result.tool_call_id} failed: ${JSON.stringify(result.output)}`);
  }
}
if (fs.readFileSync(messagePath, "utf8") !== "after\n") {
  throw new Error("patch did not land in mounted workspace");
}
NODE

echo "smoke:container-local passed"
