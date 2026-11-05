#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Smoke test: launch the built app, require it to stay alive for 15 s,
# then shut it down. Catches "builds but crashes on start" breakage on the
# community (macOS/Linux) CI jobs.
set -u

BIN="${1:?usage: smoke-app.sh <path-to-binary>}"
SECONDS_TO_SURVIVE=15
LOG="$(mktemp -t mtcb-smoke)"

if [ ! -x "$BIN" ]; then
  echo "smoke FAIL: $BIN not found or not executable"
  exit 1
fi

"$BIN" >"$LOG" 2>&1 &
pid=$!

sleep "$SECONDS_TO_SURVIVE"

if kill -0 "$pid" 2>/dev/null; then
  echo "smoke OK: $BIN stayed up for ${SECONDS_TO_SURVIVE}s"
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -f "$LOG"
  exit 0
fi

wait "$pid"
code=$?
echo "smoke FAIL: $BIN exited within ${SECONDS_TO_SURVIVE}s (status $code)"
cat "$LOG"
rm -f "$LOG"
exit 1
