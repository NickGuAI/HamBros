#!/usr/bin/env bash
# Commander memory restore:
#   s3://gehirn-hammurabi/commander/<machine-id>/ -> COMMANDER_DATA_DIR
# Run this after EC2 rebuild/wipe to restore all commander state from S3.
set -euo pipefail

BUCKET="${COMMANDER_S3_BUCKET:-gehirn-hammurabi}"
S3_PREFIX="${COMMANDER_S3_PREFIX:-commander}"
DEFAULT_LOCAL_DIR="${HOME}/.hammurabi/commander"
LOCAL_DIR="${COMMANDER_DATA_DIR:-${HAMMURABI_COMMANDER_MEMORY_DIR:-${DEFAULT_LOCAL_DIR}}}"
RAW_MACHINE_ID="${COMMANDER_MACHINE_ID:-${HOSTNAME:-unknown-machine}}"
MACHINE_ID="$(printf '%s' "${RAW_MACHINE_ID}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
if [ -z "${MACHINE_ID}" ]; then
  MACHINE_ID="unknown-machine"
fi

REMOTE_PREFIX="${S3_PREFIX}/${MACHINE_ID}"
MACHINE_URI="s3://${BUCKET}/${REMOTE_PREFIX}/"
LEGACY_URI="s3://${BUCKET}/${S3_PREFIX}/"

mkdir -p "${LOCAL_DIR}"
MACHINE_LISTING="$(aws s3 ls "${MACHINE_URI}" --recursive 2>/dev/null || true)"
if [ -n "${MACHINE_LISTING}" ]; then
  aws s3 sync "${MACHINE_URI}" "${LOCAL_DIR}/" --no-progress
  echo "[commander-restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) OK ${MACHINE_URI} -> ${LOCAL_DIR}"
else
  aws s3 sync "${LEGACY_URI}" "${LOCAL_DIR}/" --no-progress
  echo "[commander-restore] $(date -u +%Y-%m-%dT%H:%M:%SZ) OK ${LEGACY_URI} -> ${LOCAL_DIR} (legacy prefix fallback)"
fi
