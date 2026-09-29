#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT="${WEBROOT:-/var/www/pepepow-wallet}"
WALLET_SERVICE="${WALLET_SERVICE:-pepepow-wallet-api.service}"

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

require_cmd npm
require_cmd rsync
require_cmd curl

log "source: ${ROOT_DIR}"
if command -v git >/dev/null 2>&1 && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "git: $(git -C "$ROOT_DIR" rev-parse --short HEAD)"
fi

log "[1/5] Build wallet-core"
npm --prefix "$ROOT_DIR/packages/wallet-core" run build

log "[2/5] Build wallet-api"
npm --prefix "$ROOT_DIR/services/wallet-api" run build

log "[3/5] Build Web Wallet / Mini App"
npm --prefix "$ROOT_DIR/apps/web" run build

log "[4/5] Publish static web -> ${WEBROOT}"
sudo install -d "$WEBROOT"
sudo rsync -a --delete --delay-updates "$ROOT_DIR/apps/web/dist/" "$WEBROOT/"

log "[5/5] Restart wallet-api and validate"
sudo systemctl restart "$WALLET_SERVICE"
curl -fsS http://127.0.0.1:9194/healthz >/dev/null
curl -fsS http://127.0.0.1:9194/readyz >/dev/null

if command -v nginx >/dev/null 2>&1; then
  sudo nginx -t
  sudo systemctl reload nginx
fi

log "wallet deployment complete"
