#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3100}"

echo "=== Health Check: $BASE_URL ==="
echo ""

echo "1. Server health..."
HTTP_CODE=$(curl -s -o /tmp/health_response.json -w "%{http_code}" "$BASE_URL/health" 2>&1) && {
  BODY=$(cat /tmp/health_response.json)
  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "  ✓ ($HTTP_CODE) $BODY"
  else
    echo "  ⚠ Server responded with $HTTP_CODE (upstream may be down): $BODY"
  fi
} || {
  echo "  ✗ Server unreachable at $BASE_URL"
  exit 1
}
echo ""

echo "2. Upstream health (orchestrator)..."
HTTP_CODE=$(curl -s -o /tmp/upstream_response.json -w "%{http_code}" "$BASE_URL/api/v1/health" 2>&1) && {
  BODY=$(cat /tmp/upstream_response.json)
  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "  ✓ ($HTTP_CODE) $BODY"
  else
    echo "  ⚠ Orchestrator returned $HTTP_CODE: $BODY"
  fi
} || {
  echo "  ⚠ Orchestrator not reachable (this may be expected locally)"
}
echo ""

echo "=== Health check complete ==="
