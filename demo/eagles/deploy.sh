#!/bin/bash
# Deploy Eagles demo to Run402
# Usage: bash demo/eagles/deploy.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ID="${EAGLES_PROJECT_ID:?Set EAGLES_PROJECT_ID env var}"

echo "=== Eagles Deploy ==="
echo "Project: $PROJECT_ID"

# Copy demo assets into public/assets so Astro build includes them in dist/
ASSETS_SRC="$SCRIPT_DIR/assets"
ASSETS_DST="$ROOT/public/assets"

# Clean up copied assets on any exit (success or failure) so a mid-flow failure
# doesn't leave the working tree dirty.
trap '[ -d "$ASSETS_DST" ] && rm -rf "$ASSETS_DST"' EXIT

if [ -d "$ASSETS_SRC" ]; then
  echo "Copying demo assets into public/assets..."
  mkdir -p "$ASSETS_DST"
  cp "$ASSETS_SRC"/* "$ASSETS_DST/"
fi

# Deploy site + images + seed + reset-demo (single-shot via deploy.apply).
# functions: { replace: ... } drops anything not in the map, so check-expirations
# is removed implicitly by EXCLUDE_FUNCTIONS — no separate `run402 functions`
# CLI step needed.
cd "$ROOT"
SEED_FILE="demo/eagles/seed.sql" RUN402_PROJECT_ID="$PROJECT_ID" SUBDOMAIN=eagles \
  EXCLUDE_FUNCTIONS=check-expirations \
  EXTRA_FUNCTION="demo/eagles/reset-demo.js" \
  npx tsx scripts/deploy.ts

# Bootstrap demo accounts (idempotent — creates/links demo-admin + demo-member auth users)
echo ""
echo "Bootstrapping demo accounts..."
ANON_KEY=$(run402 projects keys "$PROJECT_ID" | jq -r '.anon_key')
bash "$ROOT/scripts/bootstrap-demo.sh" "$PROJECT_ID" "$ANON_KEY"

echo ""
echo "=== Deploy complete ==="
echo "Live at: https://eagles.kychon.com"
