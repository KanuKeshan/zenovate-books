#!/bin/bash
# End-to-end gate: starts the API, drives the real UI in Chromium, tears down.
set -u
cd "$(dirname "$0")/.." || exit 1

: "${DATABASE_URL:=postgres://localhost/clarabooks_e2e}"
: "${PORT:=8099}"
export DATABASE_URL PORT
export NODE_ENV=development DEV_AUTH_SECRET="${DEV_AUTH_SECRET:-e2e-only}" \
       AWS_REGION="${AWS_REGION:-us-east-1}" LOG_LEVEL=warn RUN_MIGRATIONS_ON_BOOT=true

# pkill covers Linux/Mac. It does not exist in Git Bash on Windows, where a
# server left over from an interrupted previous run silently survives this
# line and then collides with the one below on the same port — so also kill
# whatever is actually listening on $PORT, via lsof where that exists or
# PowerShell where it doesn't, rather than trusting one platform-specific tool.
kill_port() {
  pkill -9 -f "src/server.ts" 2>/dev/null
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$1" 2>/dev/null | xargs -r kill -9 2>/dev/null
    return
  fi
  # Git Bash on Windows has neither pkill nor lsof, and powershell.exe is not
  # on PATH there even though the PowerShell tooling itself is installed — has
  # to be called by full path or this whole branch silently no-ops.
  local ps=""
  if command -v powershell.exe >/dev/null 2>&1; then
    ps="powershell.exe"
  elif [ -x "/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" ]; then
    ps="/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  fi
  [ -n "$ps" ] && "$ps" -NoProfile -Command \
    "Get-NetTCPConnection -LocalPort $1 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" \
    >/dev/null 2>&1
}

kill_port "$PORT"; sleep 1
npx tsx src/server.ts > /tmp/cb_e2e.log 2>&1 &
SRV=$!
for _ in $(seq 1 45); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/auth/config" && break; sleep 1; done

E2E_BASE="http://127.0.0.1:$PORT" node test/e2e/journey.mjs
RC=$?
kill -9 $SRV 2>/dev/null
kill_port "$PORT"
exit $RC
