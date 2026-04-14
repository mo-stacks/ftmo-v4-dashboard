#!/bin/bash
# FTMO V4 Dashboard — cron deploy script
# Runs every 15 minutes to rebuild data + deploy to Vercel
# Usage: Called by crontab, or manually: bash scripts/deploy-cron.sh

set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
PROJECT_DIR="/Users/mmmacbook/Projects/Hosting Artifacts/ftmo-v4-dashboard"
LOG_FILE="$PROJECT_DIR/deploy-cron.log"

# Keep log file from growing unbounded (last 500 lines)
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 500 ]; then
    tail -200 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

echo "--- $(date -u '+%Y-%m-%d %H:%M:%S UTC') ---" >> "$LOG_FILE"

cd "$PROJECT_DIR"

# 1. Rebuild data from live engine state
node scripts/build-data.js >> "$LOG_FILE" 2>&1

# 2. Vite build
npx vite build >> "$LOG_FILE" 2>&1

# 3. Vercel prebuilt deploy (local build, no remote build needed)
vercel build --prod >> "$LOG_FILE" 2>&1
vercel deploy --prebuilt --prod --yes >> "$LOG_FILE" 2>&1

echo "Deploy complete at $(date -u '+%H:%M:%S UTC')" >> "$LOG_FILE"
