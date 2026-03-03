#!/usr/bin/env bash

set -euo pipefail

# Keep cli-gateway alive with restart-on-crash behavior.
#
# Default command:
#   node dist/main.js
#
# Override command:
#   bash scripts/run-guard.sh npm run dev
#
# Tuning via env:
#   RESTART_BASE_DELAY_SECONDS=2
#   RESTART_MAX_DELAY_SECONDS=30
#   RESTART_MAX_ATTEMPTS=0   # 0 means unlimited
#   RESTART_ON_EXIT_0=0      # 1 to restart even on exit code 0

if [[ $# -gt 0 ]]; then
  CMD=("$@")
else
  CMD=("node" "dist/main.js")
fi

BASE_DELAY="${RESTART_BASE_DELAY_SECONDS:-2}"
MAX_DELAY="${RESTART_MAX_DELAY_SECONDS:-30}"
MAX_ATTEMPTS="${RESTART_MAX_ATTEMPTS:-0}"
RESTART_ON_EXIT_0="${RESTART_ON_EXIT_0:-0}"

attempt=0

echo "[guard] command: ${CMD[*]}"
echo "[guard] base_delay=${BASE_DELAY}s max_delay=${MAX_DELAY}s max_attempts=${MAX_ATTEMPTS}"

while true; do
  start_at="$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "[guard] starting at ${start_at}"

  set +e
  "${CMD[@]}"
  exit_code=$?
  set -e

  ended_at="$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "[guard] process exited code=${exit_code} at ${ended_at}"

  if [[ "${exit_code}" -eq 0 && "${RESTART_ON_EXIT_0}" != "1" ]]; then
    echo "[guard] clean exit, not restarting"
    exit 0
  fi

  attempt=$((attempt + 1))
  if [[ "${MAX_ATTEMPTS}" -gt 0 && "${attempt}" -gt "${MAX_ATTEMPTS}" ]]; then
    echo "[guard] restart limit reached (${MAX_ATTEMPTS}), giving up"
    exit "${exit_code}"
  fi

  delay=$((BASE_DELAY * (2 ** (attempt - 1))))
  if [[ "${delay}" -gt "${MAX_DELAY}" ]]; then
    delay="${MAX_DELAY}"
  fi

  echo "[guard] restarting in ${delay}s (attempt=${attempt})"
  sleep "${delay}"
done
