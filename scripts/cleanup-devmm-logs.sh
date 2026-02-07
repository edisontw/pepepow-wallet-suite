#!/bin/bash
# DevMM Log Cleanup Script
# 
# Cleans up old DevMM logs to prevent disk overflow.
# Keep last 7 days or max 50MB of logs.
#
# Usage: Run via cron or systemd timer
#   0 3 * * * /path/to/cleanup-logs.sh >> /var/log/devmm-cleanup.log 2>&1

set -euo pipefail

LOG_DIR="${DEVMM_LOG_DIR:-/var/log/pepepow}"
MAX_AGE_DAYS=7
MAX_SIZE_MB=50

echo "[$(date -Iseconds)] DevMM log cleanup starting..."

# Create log dir if it doesn't exist
mkdir -p "$LOG_DIR"

# Remove logs older than MAX_AGE_DAYS
if [ -d "$LOG_DIR" ]; then
    find "$LOG_DIR" -name "devmm*.log" -mtime +$MAX_AGE_DAYS -type f -delete 2>/dev/null || true
    find "$LOG_DIR" -name "devmm*.log.*" -mtime +$MAX_AGE_DAYS -type f -delete 2>/dev/null || true
fi

# Check total size and remove oldest if over MAX_SIZE_MB
total_size=$(du -sm "$LOG_DIR" 2>/dev/null | cut -f1 || echo "0")

if [ "$total_size" -gt "$MAX_SIZE_MB" ]; then
    echo "[$(date -Iseconds)] Log dir size ${total_size}MB exceeds ${MAX_SIZE_MB}MB, removing oldest logs..."
    
    # Find and remove oldest devmm logs
    ls -t "$LOG_DIR"/devmm*.log* 2>/dev/null | tail -n +10 | while read -r file; do
        rm -f "$file"
        new_size=$(du -sm "$LOG_DIR" 2>/dev/null | cut -f1 || echo "0")
        if [ "$new_size" -le "$MAX_SIZE_MB" ]; then
            break
        fi
    done
fi

echo "[$(date -Iseconds)] DevMM log cleanup complete."
