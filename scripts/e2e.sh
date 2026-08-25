#!/bin/bash
# End-to-end gate: starts the API, drives the real UI in Chromium, tears down.
set -u
cd "$(dirname "$0")/.." || exit 1

: "${DATABASE_URL:=postgres://localhost/clarabooks_e2e}"
: "${PORT:=8099}"
export DATABASE_URL PORT
export NODE_ENV=development DEV_AUTH_SECRET="${DEV_AUTH_SECRET:-e2e-only}" \
       AWS_REGION="${AWS_REGION:-us-east-1}" LOG_LEVEL=warn RUN_MIGRATIONS_ON_BOOT=true

pkill -9 -f "src/server.ts" 2>/dev/null; sleep 1
npx tsx src/server.ts > /tmp/cb_e2e.log 2>&1 &
SRV=$!
for _ in $(seq 1 45); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/auth/config" && break; sleep 1; done

E2E_BASE="http://127.0.0.1:$PORT" node test/e2e/journey.mjs
RC=$?
kill -9 $SRV 2>/dev/null; pkill -9 -f "src/server.ts" 2>/dev/null
exit $RC
