#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-pepepow-wallet-suite}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
APP_USER="${APP_USER:-www-data}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
ENV_FILE="${ENV_FILE:-/etc/pepepow/pepepow-wallet-api.env}"
PEPEW_ENV_FILE="${PEPEW_ENV_FILE:-/etc/pepepow/pepew-api.env}"
DEPRECATED_SHARED_ENV="${APP_ROOT}/shared/.env"

log() {
  printf "[rollback] %s\n" "$*"
}

warn() {
  printf "[rollback] warning: %s\n" "$*" >&2
}

die() {
  printf "[rollback] error: %s\n" "$*" >&2
  exit 1
}

resolve_env_file() {
  local preferred="$1"
  local fallback="$2"

  if [[ -f "$preferred" ]]; then
    printf '%s' "$preferred"
    return 0
  fi
  if [[ -f "$fallback" ]]; then
    warn "Using deprecated shared env file at ${fallback}"
    printf '%s' "$fallback"
    return 0
  fi
  printf '%s' "$preferred"
}

RESOLVED_ENV_FILE="$(resolve_env_file "$ENV_FILE" "$DEPRECATED_SHARED_ENV")"
RESOLVED_PEPEW_ENV_FILE="$(resolve_env_file "$PEPEW_ENV_FILE" "$DEPRECATED_SHARED_ENV")"

run_doctor() {
  local phase="$1" root="$2"
  local doctor="${root}/scripts/doctor.sh"
  if [[ ! -x "$doctor" ]]; then
    warn "Doctor ${phase} skipped (missing ${doctor})"
    return 0
  fi
  log "Doctor ${phase}..."
  if ! APP_ROOT="$APP_ROOT" ENV_FILE="$RESOLVED_ENV_FILE" PEPEW_ENV_FILE="$RESOLVED_PEPEW_ENV_FILE" bash "$doctor"; then
    if [[ "${ALLOW_DOCTOR_FAILURE:-0}" == "1" ]]; then
      warn "Doctor ${phase} failed, continuing due to ALLOW_DOCTOR_FAILURE=1"
    else
      die "Doctor ${phase} failed (set ALLOW_DOCTOR_FAILURE=1 to bypass)"
    fi
  fi
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

restart_services() {
  local dir="$1"
  local units=()
  local unit
  while IFS= read -r unit; do
    units+=("$unit")
  done < <(discover_services "$dir")

  if [[ "${#units[@]}" -eq 0 ]]; then
    warn "No systemd units found under ${dir}"
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not available; skipping service restart"
    return 0
  fi
  log "Reloading systemd..."
  systemctl daemon-reload
  for unit in "${units[@]}"; do
    if systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -qx "$unit"; then
      log "Restarting ${unit}"
      systemctl restart "$unit"
    else
      warn "Unit not installed: ${unit} (copy from ${dir})"
    fi
  done
}

smoke_test() {
  local url="${SMOKE_URL:-}"
  local port="${SMOKE_PORT:-}"
  local path="${SMOKE_PATH:-/}"

  if [[ -n "$url" ]]; then
    log "Smoke test (url configured)"
    curl -fsS --max-time 5 "$url" >/dev/null || die "Smoke test failed for SMOKE_URL"
    return 0
  fi

  if [[ -z "$port" && -f "$RESOLVED_ENV_FILE" ]]; then
    port="$(grep -E '^PORT=' "$RESOLVED_ENV_FILE" | tail -n1 | cut -d'=' -f2- | tr -d '\r' || true)"
  fi

  if [[ -z "$port" ]]; then
    warn "Smoke test skipped (set SMOKE_URL or SMOKE_PORT)"
    return 0
  fi

  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${port}${path}" || true)"
    if [[ "$code" == "000" ]]; then
      die "Smoke test failed (no HTTP response on port ${port})"
    fi
    log "Smoke test ok (HTTP ${code} on ${port}${path})"
  elif command -v ss >/dev/null 2>&1; then
    if ss -ltn | awk -v p=":${port}" '$4 ~ p {found=1} END {exit !found}'; then
      log "Smoke test ok (port ${port} listening)"
    else
      die "Smoke test failed (port ${port} not listening)"
    fi
  else
    warn "Smoke test skipped (curl/ss not available)"
  fi
}

RELEASES_DIR="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"

if [[ ! -L "$CURRENT_LINK" ]]; then
  die "current symlink not found at ${CURRENT_LINK}"
fi

current_target="$(readlink -f "$CURRENT_LINK" || true)"
if [[ -z "$current_target" || ! -d "$current_target" ]]; then
  die "current symlink target invalid: ${current_target:-empty}"
fi

current_name="$(basename "$current_target")"

if [[ ! -d "$RELEASES_DIR" ]]; then
  die "releases directory missing: ${RELEASES_DIR}"
fi

mapfile -t releases < <(find "$RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort)
if [[ "${#releases[@]}" -lt 2 ]]; then
  die "No previous release available under ${RELEASES_DIR}"
fi

current_idx=""
for i in "${!releases[@]}"; do
  if [[ "${releases[$i]}" == "$current_name" ]]; then
    current_idx="$i"
    break
  fi
done

if [[ -z "$current_idx" ]]; then
  die "Current release ${current_name} not found in ${RELEASES_DIR}"
fi
if [[ "$current_idx" -eq 0 ]]; then
  die "No previous release before ${current_name}"
fi

prev_name="${releases[$((current_idx - 1))]}"
prev_dir="${RELEASES_DIR}/${prev_name}"

log "Rolling back ${current_name} -> ${prev_name}"
ln -sfn "$prev_dir" "$CURRENT_LINK"

if [[ "$(id -u)" -eq 0 ]]; then
  if id "$APP_USER" >/dev/null 2>&1; then
    if command -v getent >/dev/null 2>&1 && ! getent group "$APP_GROUP" >/dev/null 2>&1; then
      warn "Group ${APP_GROUP} not found; falling back to ${APP_USER}"
      APP_GROUP="$APP_USER"
    fi
    log "Setting ownership to ${APP_USER}:${APP_GROUP}"
    chown -R "${APP_USER}:${APP_GROUP}" "$prev_dir" "${APP_ROOT}/shared"
  else
    warn "User ${APP_USER} not found; skipping chown"
  fi
else
  warn "Not running as root; skipping chown"
fi

restart_services "${CURRENT_LINK}/systemd"
run_doctor "post-rollback" "$CURRENT_LINK"
smoke_test

log "Rollback complete: ${prev_name}"
