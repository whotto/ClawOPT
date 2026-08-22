#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACKEND_DIR="$PROJECT_ROOT/backend"
PORT="${PORT:-3115}"
CLAWOPT_DATA_DIR="${CLAWOPT_DATA_DIR:-.clawopt_release}"
LOG_FILE="${LOG_FILE:-/tmp/clawopt_back.log}"

pkill -f "$BACKEND_DIR/dist/index.js" 2>/dev/null || true
sleep 1

cd "$PROJECT_ROOT"
npm run build

cd "$BACKEND_DIR"
nohup env PORT="$PORT" CLAWOPT_DATA_DIR="$CLAWOPT_DATA_DIR" /usr/bin/node dist/index.js >"$LOG_FILE" 2>&1 &

sleep 2

echo "backend: $(ss -tlnp | grep \":$PORT \" || true)"
echo "frontend: served by backend on http://127.0.0.1:$PORT/"
