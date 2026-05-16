#!/bin/bash
# Installs dependencies for the ObjetivaAR app (ifc-wall-viewer/) so that
# typecheck (pnpm run check) and the production build work in Claude Code
# on the web sessions. Idempotent and non-interactive.
set -euo pipefail

# Only needed in the remote (web) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

APP_DIR="$CLAUDE_PROJECT_DIR/ifc-wall-viewer"
[ -d "$APP_DIR" ] || exit 0
cd "$APP_DIR"

# Use the pinned package manager via corepack when available.
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --prefer-offline --no-frozen-lockfile
else
  npx --yes pnpm@10 install --prefer-offline --no-frozen-lockfile
fi

echo "ObjetivaAR deps installed in $APP_DIR"
