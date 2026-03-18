#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_COMMANDER_DATA_DIR="${HOME}/.hammurabi/commander"

# Production default: keep commander state outside the repo tree.
export COMMANDER_DATA_DIR="${COMMANDER_DATA_DIR:-${DEFAULT_COMMANDER_DATA_DIR}}"
# Enable in-process cron sync jobs (5-min memory-only + hourly full).
export COMMANDER_S3_SYNC_ENABLED="${COMMANDER_S3_SYNC_ENABLED:-1}"

if ! "${SCRIPT_DIR}/commander-memory-restore.sh"; then
  echo "[commander-restore] WARN $(date -u +%Y-%m-%dT%H:%M:%SZ) restore failed; continuing startup"
fi

exec pnpm tsx server/index.ts
