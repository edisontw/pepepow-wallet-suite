#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-pepepow-wallet-suite}"
APP_ROOT="${APP_ROOT:-/opt/${APP_NAME}}"
APP_USER="${APP_USER:-www-data}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"

usage() {
  echo "Usage: $0 <release.tar.gz> [app_root]"
  exit 2
}

log() {
  printf "[deploy] %s\n" "$*"
}

warn() {
  printf "[deploy] warning: %s\n" "$*" >&2
}

die() {
  printf "[deploy] error: %s\n" "$*" >&2
  exit 1
}

TARBALL="${1:-}"
if [[ -z "$TARBALL" ]]; then
  usage
fi
if [[ -n "${2:-}" ]]; then
  APP_ROOT="$2"
fi

if [[ ! -f "$TARBALL" ]]; then
  die "Tarball not found: $TARBALL"
fi

RELEASES_DIR="${APP_ROOT}/releases"
SHARED_DIR="${APP_ROOT}/shared"
CURRENT_LINK="${APP_ROOT}/current"

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "Missing required command: $cmd"
}

copy_tree() {
  local src="$1" dst="$2"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$src"/ "$dst"/
  else
    cp -a "$src"/. "$dst"/
  fi
}

run_doctor() {
  local phase="$1" root="$2"
  local doctor="${root}/scripts/doctor.sh"
  if [[ ! -x "$doctor" ]]; then
    warn "Doctor ${phase} skipped (missing ${doctor})"
    return 0
  fi
  log "Doctor ${phase}..."
  if ! APP_ROOT="$APP_ROOT" ENV_FILE="${SHARED_DIR}/.env" PEPEW_ENV_FILE="${SHARED_DIR}/.env" bash "$doctor"; then
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

  if [[ -z "$port" && -f "${SHARED_DIR}/.env" ]]; then
    port="$(grep -E '^PORT=' "${SHARED_DIR}/.env" | tail -n1 | cut -d'=' -f2- | tr -d '\r' || true)"
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

require_cmd tar

log "Validating tarball integrity..."
tar -tf "$TARBALL" >/dev/null || die "Tarball is not readable by tar"

sha_file=""
if [[ -f "${TARBALL}.sha256" ]]; then
  sha_file="${TARBALL}.sha256"
elif [[ -f "${TARBALL}.sha256sum" ]]; then
  sha_file="${TARBALL}.sha256sum"
elif [[ -f "$(dirname "$TARBALL")/SHA256SUMS" ]]; then
  sha_file="$(dirname "$TARBALL")/SHA256SUMS"
fi

if [[ -n "$sha_file" ]]; then
  if grep -q " $(basename "$TARBALL")$" "$sha_file"; then
    log "Verifying sha256 checksum..."
    grep " $(basename "$TARBALL")$" "$sha_file" | sha256sum -c - >/dev/null
  else
    warn "Checksum file present but no entry for $(basename "$TARBALL"); skipping"
  fi
fi

log "Ensuring release layout under ${APP_ROOT}"
mkdir -p "$RELEASES_DIR" "$SHARED_DIR"
mkdir -p "${SHARED_DIR}/logs" "${SHARED_DIR}/data" "${SHARED_DIR}/uploads"

if [[ -f "${CURRENT_LINK}/scripts/doctor.sh" ]]; then
  run_doctor "preflight" "$CURRENT_LINK"
else
  warn "Preflight doctor skipped (no current release)"
fi

release_id="$(date -u +%Y%m%d%H%M%S)"
release_dir="${RELEASES_DIR}/${release_id}"
if [[ -e "$release_dir" ]]; then
  release_id="${release_id}_$(date -u +%s)"
  release_dir="${RELEASES_DIR}/${release_id}"
fi
mkdir -p "$release_dir"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

log "Extracting tarball to ${release_dir}"
tar -xf "$TARBALL" -C "$tmp_dir"
entries=("$tmp_dir"/*)
if [[ "${#entries[@]}" -eq 1 && -d "${entries[0]}" ]]; then
  copy_tree "${entries[0]}" "$release_dir"
else
  copy_tree "$tmp_dir" "$release_dir"
fi

log "Updating current symlink"
ln -sfn "$release_dir" "$CURRENT_LINK"

if [[ "$(id -u)" -eq 0 ]]; then
  if id "$APP_USER" >/dev/null 2>&1; then
    if command -v getent >/dev/null 2>&1 && ! getent group "$APP_GROUP" >/dev/null 2>&1; then
      warn "Group ${APP_GROUP} not found; falling back to ${APP_USER}"
      APP_GROUP="$APP_USER"
    fi
    log "Setting ownership to ${APP_USER}:${APP_GROUP}"
    chown -R "${APP_USER}:${APP_GROUP}" "$release_dir" "$SHARED_DIR"
  else
    warn "User ${APP_USER} not found; skipping chown"
  fi
else
  warn "Not running as root; skipping chown"
fi

restart_services "${CURRENT_LINK}/systemd"
run_doctor "postflight" "$CURRENT_LINK"
smoke_test

log "Deploy complete: ${release_id}"
