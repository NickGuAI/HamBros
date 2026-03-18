#!/usr/bin/env bash
# Commander memory sync:
#   full   -> sync all commander state
#   memory -> sync only .memory trees + names.json
# Destination is machine-scoped for multi-host durability:
#   s3://gehirn-hammurabi/commander/<machine-id>/
set -euo pipefail

MODE="${1:-full}"
BUCKET="${COMMANDER_S3_BUCKET:-gehirn-hammurabi}"
S3_PREFIX="${COMMANDER_S3_PREFIX:-commander}"
DEFAULT_LOCAL_DIR="${HOME}/.hammurabi/commander"
LOCAL_DIR="${COMMANDER_DATA_DIR:-${HAMMURABI_COMMANDER_MEMORY_DIR:-${DEFAULT_LOCAL_DIR}}}"
RAW_MACHINE_ID="${COMMANDER_MACHINE_ID:-${HOSTNAME:-unknown-machine}}"
MACHINE_ID="$(printf '%s' "${RAW_MACHINE_ID}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
if [ -z "${MACHINE_ID}" ]; then
  MACHINE_ID="unknown-machine"
fi

REMOTE_URI="s3://${BUCKET}/${S3_PREFIX}/${MACHINE_ID}/"

case "${MODE}" in
  memory)
    aws s3 sync "${LOCAL_DIR}/" "${REMOTE_URI}" \
      --delete \
      --no-progress \
      --exclude "*" \
      --include "names.json" \
      --include "*/.memory/*" \
      --include "*/.memory/**"
    echo "[commander-sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) MODE=memory OK -> ${REMOTE_URI}"
    ;;
  full)
    aws s3 sync "${LOCAL_DIR}/" "${REMOTE_URI}" \
      --delete \
      --no-progress
    echo "[commander-sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) MODE=full OK -> ${REMOTE_URI}"
    ;;
  *)
    echo "[commander-sync] ERROR invalid mode: ${MODE}. expected: full|memory" >&2
    exit 1
    ;;
esac
