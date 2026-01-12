#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-pepepow-wallet-suite}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
LOG_LINES="${LOG_LINES:-120}"

log() {
  printf "[status] %s\n" "$*"
}

warn() {
  printf "[status] warning: %s\n" "$*" >&2
}

die() {
  printf "[status] error: %s\n" "$*" >&2
  exit 1
}

discover_services() {
  local dir="$1"
  local unit
  if [[ -d "$dir" ]]; then
    for unit in "$dir"/*.service; do
      [[ -e "$unit" ]] || continue
      basename "$unit"
    done
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SYSTEMD_DIR="${SYSTEMD_DIR:-${CODE_ROOT}/systemd}"
if [[ -d "${APP_ROOT}/current/systemd" ]]; then
  SYSTEMD_DIR="${APP_ROOT}/current/systemd"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  die "systemctl not available"
fi

units=()
while IFS= read -r unit; do
  units+=("$unit")
done < <(discover_services "$SYSTEMD_DIR")

if [[ "${#units[@]}" -eq 0 ]]; then
  warn "No systemd units found under ${SYSTEMD_DIR}"
  exit 0
fi

log "Systemd status for units in ${SYSTEMD_DIR}"
for unit in "${units[@]}"; do
  echo
  log "Status: ${unit}"
  systemctl status --no-pager --full "$unit" || true
  log "Recent logs: ${unit}"
  journalctl -u "$unit" -n "$LOG_LINES" --no-pager || true
done
