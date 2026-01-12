#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

VERSION="$(node -p "require('./services/wallet-api/package.json').version")"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
RELEASE_NAME="release_${VERSION}_${STAMP}"
TARBALL_PATH="${ROOT_DIR}/${RELEASE_NAME}.tar.gz"
STAGING_DIR="$(mktemp -d -t pepepow-release-XXXXXX)"
SMOKE_DIR="$(mktemp -d -t pepepow-smoke-XXXXXX)"

smoke_pids=()
cleanup() {
  for pid in "${smoke_pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$STAGING_DIR" "$SMOKE_DIR"
}
trap cleanup EXIT

build_pkg() {
  local dir="$1"
  echo "[build] ${dir}"
  (cd "$ROOT_DIR/$dir" && npm ci && npm run build && npm prune --omit=dev)
}

build_web() {
  echo "[build] apps/web"
  (cd "$ROOT_DIR/apps/web" && npm ci && npm run build)
}

build_pkg "packages/wallet-core"
build_pkg "services/wallet-api"
build_web
if [[ -d "$ROOT_DIR/pepew-api/pepew-api" ]]; then
  build_pkg "pepew-api/pepew-api"
fi

DEST="${STAGING_DIR}/${RELEASE_NAME}"
mkdir -p "$DEST"

cp -a "$ROOT_DIR/package.json" "$DEST/"
if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
  cp -a "$ROOT_DIR/package-lock.json" "$DEST/"
fi
cp -a "$ROOT_DIR/.env.example" "$DEST/"
cp -a "$ROOT_DIR/systemd" "$DEST/"
cp -a "$ROOT_DIR/scripts" "$DEST/"

mkdir -p "$DEST/packages/wallet-core"
cp -a "$ROOT_DIR/packages/wallet-core/package.json" "$DEST/packages/wallet-core/"
cp -a "$ROOT_DIR/packages/wallet-core/package-lock.json" "$DEST/packages/wallet-core/"
cp -a "$ROOT_DIR/packages/wallet-core/dist" "$DEST/packages/wallet-core/"
cp -a "$ROOT_DIR/packages/wallet-core/node_modules" "$DEST/packages/wallet-core/"

mkdir -p "$DEST/services/wallet-api"
cp -a "$ROOT_DIR/services/wallet-api/package.json" "$DEST/services/wallet-api/"
cp -a "$ROOT_DIR/services/wallet-api/package-lock.json" "$DEST/services/wallet-api/"
cp -a "$ROOT_DIR/services/wallet-api/dist" "$DEST/services/wallet-api/"
cp -a "$ROOT_DIR/services/wallet-api/node_modules" "$DEST/services/wallet-api/"

mkdir -p "$DEST/apps/web"
cp -a "$ROOT_DIR/apps/web/package.json" "$DEST/apps/web/"
cp -a "$ROOT_DIR/apps/web/package-lock.json" "$DEST/apps/web/"
cp -a "$ROOT_DIR/apps/web/dist" "$DEST/apps/web/"

if [[ -d "$ROOT_DIR/pepew-api/pepew-api" ]]; then
  mkdir -p "$DEST/pepew-api/pepew-api"
  cp -a "$ROOT_DIR/pepew-api/pepew-api/package.json" "$DEST/pepew-api/pepew-api/"
  cp -a "$ROOT_DIR/pepew-api/pepew-api/package-lock.json" "$DEST/pepew-api/pepew-api/"
  cp -a "$ROOT_DIR/pepew-api/pepew-api/dist" "$DEST/pepew-api/pepew-api/"
  cp -a "$ROOT_DIR/pepew-api/pepew-api/node_modules" "$DEST/pepew-api/pepew-api/"
  if [[ -f "$ROOT_DIR/pepew-api/pepew-api/.env.example" ]]; then
    cp -a "$ROOT_DIR/pepew-api/pepew-api/.env.example" "$DEST/pepew-api/pepew-api/"
  fi
fi

tar -czf "$TARBALL_PATH" -C "$STAGING_DIR" "$RELEASE_NAME"

get_free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi
  if command -v python >/dev/null 2>&1; then
    python - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi
  node - <<'NODE'
const net = require("net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(port);
  server.close();
});
NODE
}

smoke_root="$SMOKE_DIR/$RELEASE_NAME"
tar -xzf "$TARBALL_PATH" -C "$SMOKE_DIR"

wallet_port="$(get_free_port)"
pepew_port="$(get_free_port)"

if [[ -d "$smoke_root/pepew-api/pepew-api" ]]; then
  echo "[smoke] pepew-api on :$pepew_port"
  (
    cd "$smoke_root/pepew-api/pepew-api"
    PORT="$pepew_port" RPC_URL="http://127.0.0.1:1" node dist/index.js
  ) &
  smoke_pids+=("$!")
fi

echo "[smoke] wallet-api on :$wallet_port"
(
  cd "$smoke_root/services/wallet-api"
  PORT="$wallet_port" JWT_SECRET="smoke" PEPEW_API_BASE="http://127.0.0.1:${pepew_port}" node dist/server.js
) &
smoke_pids+=("$!")

sleep 1

if ! kill -0 "${smoke_pids[-1]}" >/dev/null 2>&1; then
  echo "wallet-api failed to start" >&2
  exit 1
fi

wallet_status=""
for _ in {1..10}; do
  wallet_status="$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${wallet_port}/api/auth/telegram" -H "Content-Type: application/json" -d '{}' || true)"
  if [[ "$wallet_status" != "000" ]]; then
    break
  fi
  sleep 0.5
done
if [[ "$wallet_status" != "400" ]]; then
  echo "wallet-api smoke check failed (status ${wallet_status})" >&2
  exit 1
fi

if [[ -d "$smoke_root/pepew-api/pepew-api" ]]; then
  if ! kill -0 "${smoke_pids[0]}" >/dev/null 2>&1; then
    echo "pepew-api failed to start" >&2
    exit 1
  fi
  pepew_status=""
  for _ in {1..10}; do
    pepew_status="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${pepew_port}/health" || true)"
    if [[ "$pepew_status" != "000" ]]; then
      break
    fi
    sleep 0.5
  done
  if [[ "$pepew_status" != "200" && "$pepew_status" != "500" ]]; then
    echo "pepew-api smoke check failed (status ${pepew_status})" >&2
    exit 1
  fi
fi

echo "Release tarball: ${TARBALL_PATH}"
