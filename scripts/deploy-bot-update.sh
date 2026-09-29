#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${WALLET_SERVICE:-pepepow-wallet-api.service}"

echo "PEPEPOW Wallet API - Bot update"
echo "Source: $ROOT_DIR"

npm --prefix "$ROOT_DIR/services/wallet-api" run build
sudo systemctl restart "$SERVICE"

echo
systemctl status "$SERVICE" --no-pager -l | head -n 15
echo
curl -fsS http://127.0.0.1:9194/healthz
echo
curl -fsS http://127.0.0.1:9194/readyz
echo

echo "Bot update deployed from the Git checkout; no /var/www service copy is used."
