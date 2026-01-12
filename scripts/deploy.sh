#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-/opt/pepepow-wallet-suite}"

log() {
  printf "[deploy] %s\n" "$*"
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || {
    printf "[deploy] error: missing %s\n" "$cmd" >&2
    exit 1
  }
}

copy_tree() {
  local src="$1"
  local dst="$2"
  sudo mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    sudo rsync -a --delete "$src"/ "$dst"/
  else
    sudo cp -a "$src"/. "$dst"/
  fi
}

copy_file() {
  local src="$1"
  local dst="$2"
  sudo mkdir -p "$(dirname "$dst")"
  sudo cp -a "$src" "$dst"
}

require_cmd npm

log "[1/5] Install deps (wallet-api)"
cd "$ROOT_DIR/services/wallet-api"
npm ci

log "[2/5] Build wallet-api"
npm run build

log "[3/5] Install deps + build (pepew-api)"
cd "$ROOT_DIR/pepew-api/pepew-api"
npm ci
npm run build

log "[4/5] Copy runtime bundles -> ${TARGET}"
copy_tree "$ROOT_DIR/services/wallet-api/dist" "$TARGET/services/wallet-api/dist"
copy_tree "$ROOT_DIR/services/wallet-api/node_modules" "$TARGET/services/wallet-api/node_modules"
copy_file "$ROOT_DIR/services/wallet-api/package.json" "$TARGET/services/wallet-api/package.json"
copy_file "$ROOT_DIR/services/wallet-api/package-lock.json" "$TARGET/services/wallet-api/package-lock.json"

copy_tree "$ROOT_DIR/pepew-api/pepew-api/dist" "$TARGET/pepew-api/pepew-api/dist"
copy_tree "$ROOT_DIR/pepew-api/pepew-api/node_modules" "$TARGET/pepew-api/pepew-api/node_modules"
copy_file "$ROOT_DIR/pepew-api/pepew-api/package.json" "$TARGET/pepew-api/pepew-api/package.json"
copy_file "$ROOT_DIR/pepew-api/pepew-api/package-lock.json" "$TARGET/pepew-api/pepew-api/package-lock.json"

log "[5/5] Reload systemd and restart services"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl daemon-reload
  sudo systemctl restart pepew-api.service
  sudo systemctl restart pepepow-wallet-api.service
else
  log "systemctl not found; skipping service restart"
fi
