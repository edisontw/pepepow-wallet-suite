#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-/opt/pepepow-wallet-suite}"

echo "[1/6] Copy sources to ${TARGET}"
sudo mkdir -p "$TARGET"
sudo rsync -a --delete ./ "$TARGET/"

cd "$TARGET"

echo "[2/6] Build wallet-core"
cd packages/wallet-core
#npm ci
npm install
npm run build

echo "[3/6] Build wallet-api"
cd ../../services/wallet-api
#npm ci
npm install
npm run build

echo "[4/6] Build web"
cd ../../apps/web
#npm ci
npm install
npm run build

echo "[5/6] Deploy web dist -> /srv/wallet"
sudo mkdir -p /srv/wallet
sudo rsync -a --delete dist/ /srv/wallet/

echo "[6/6] Reload systemd + nginx"
sudo systemctl daemon-reload
sudo systemctl restart pepepow-wallet-api.service || true
sudo nginx -t
sudo systemctl reload nginx

echo "Done."
