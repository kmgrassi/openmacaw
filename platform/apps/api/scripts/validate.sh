#!/usr/bin/env bash
set -euo pipefail

echo "=== Symphony Server: Full Validation ==="
echo ""

echo "1/4  Linting..."
pnpm run lint
echo "  ✓ Lint passed"
echo ""

echo "2/4  Checking formatting..."
pnpm run format:check
echo "  ✓ Format check passed"
echo ""

echo "3/4  Type checking..."
pnpm run typecheck
echo "  ✓ Type check passed"
echo ""

echo "4/4  Running tests..."
pnpm test
echo "  ✓ Tests passed"
echo ""

echo "=== All checks passed ==="
