#!/usr/bin/env bash
# Direct local-chat harness for local model debugging.
#
# This script intentionally targets /local-chat and Ollama directly. It does
# not exercise Coding Agent local_model_coding tool execution, which runs
# through runtime dispatch and the registered local-runtime-helper relay.
# Usage: test-local-model-chain.sh <agent-id> [workspace-id]
#
# Environment:
#   API_BASE  — API base URL (default: http://127.0.0.1:3100)

set -euo pipefail

AGENT_ID="${1:?Usage: test-local-model-chain.sh <agent-id> [workspace-id]}"
WORKSPACE_ID="${2:-}"
API_BASE="${API_BASE:-http://127.0.0.1:3100}"

DIAGNOSTIC_URL="$API_BASE/api/diagnostic/agents/$AGENT_ID"
if [ -n "$WORKSPACE_ID" ]; then
  DIAGNOSTIC_URL="$DIAGNOSTIC_URL?workspaceId=$WORKSPACE_ID"
fi

echo "=== Agent Diagnostic ==="
curl -s "$DIAGNOSTIC_URL" | python3 -m json.tool

echo ""
echo "=== Direct Local Chat Harness (legacy/dev-only) ==="
curl -s -X POST "$API_BASE/api/agents/$AGENT_ID/local-chat" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in one word"}]}' | python3 -m json.tool

echo ""
echo "=== Ollama Direct Test ==="
curl -s http://localhost:11434/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"qwen3-coder:30b","messages":[{"role":"user","content":"Say hello"}],"max_tokens":10}' | python3 -m json.tool
