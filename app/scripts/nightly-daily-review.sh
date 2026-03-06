#!/bin/bash
# nightly-daily-review.sh
# Invoked by cron at 04:00 UTC (23:00 EST / 00:00 EDT) to run /daily-review.
# Logs to ~/.ginsights/logs/daily-review-YYYY-MM-DD.log

set -euo pipefail

# --- Environment ---
export HOME="/home/ec2-user"
export PATH="/home/ec2-user/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Load bashrc for GOG_KEYRING_PASSWORD and other env vars
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

# --- Logging ---
LOG_DIR="$HOME/.ginsights/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-review-$(date +%Y-%m-%d).log"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting nightly daily-review" >> "$LOG_FILE"

# --- Run /daily-review via Claude non-interactive ---
claude \
  --print \
  --dangerously-skip-permissions \
  --max-budget-usd 2.00 \
  --output-format text \
  "/daily-review" \
  >> "$LOG_FILE" 2>&1

EXIT=$?

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Finished. Exit code: $EXIT" >> "$LOG_FILE"

# Keep only last 30 days of logs
find "$LOG_DIR" -name "daily-review-*.log" -mtime +30 -delete

exit $EXIT
