# Runtime Runbook

## Current production layout

GitHub `main` is the development source of truth.

```text
Repository:      /home/ubuntu/pepepow-wallet-suite
Wallet API:      :9194
pepew-api:       :9193 (legacy/separate; may have other consumers)
Wallet env:      /etc/pepepow/pepepow-wallet-api.env
pepew-api env:   /etc/pepepow/pepew-api.env
Web root:        /var/www/pepepow-wallet/
```

Do not assume the historical `/opt/.../current` symlink deployment is active.

## Wallet API dependencies

Wallet API target dependencies are:

- PEPEW Light API, configured by `PEPEW_LIGHT_API_BASE`, for Bot chain reads and Wallet readiness;
- Telegram Bot API for Telegram identity/bot operation when enabled;
- CoinMarketCap only for the optional price endpoint;
- local SQLite/product state used by Wallet API.

Wallet API no longer depends on `pepew-api :9193` or direct `pepepowd` RPC for balance, history, UTXO, raw transaction lookup, broadcast, fee calculation, or readiness.

`pepew-api :9193` may still use its own RPC/Redis/ZMQ dependencies. Those are outside the Wallet API security boundary.

## Health/readiness

Local Wallet API:

```bash
curl -fsS http://127.0.0.1:9194/healthz
curl -fsS http://127.0.0.1:9194/readyz
```

Expected Wallet readiness shape:

```json
{
  "ok": true,
  "service": "wallet-api",
  "deps": {
    "pepewLight": { "ok": true },
    "telegram": { "ok": true }
  }
}
```

The retired Wallet RPC diagnostics return 404:

```text
/healthz/rpc
/wallet/healthz/rpc
```

Public host routing remains path-split. Root `/healthz` and `/readyz` on `api.pepepow.net` may still belong to `pepew-api :9193`; Wallet readiness is available through the wallet-owned route.

## Standard Wallet deployment

```bash
cd /home/ubuntu/pepepow-wallet-suite
git fetch origin main
git pull --ff-only origin main
bash scripts/deploy.sh
```

The canonical Wallet deploy helper builds wallet-core, wallet-api and Web Wallet/Mini App, publishes Web assets to `/var/www/pepepow-wallet/`, restarts only `pepepow-wallet-api.service`, validates Wallet health/readiness, and reloads Nginx after a successful config test.

It does not build or restart `pepew-api`.

## Troubleshooting

Wallet readiness failure:
- check `PEPEW_LIGHT_API_BASE`;
- check `https://light.pepepow.net/api/status`;
- check outbound HTTPS and Telegram `getMe` when the bot is enabled.

Wallet price failure:
- check `CMC_API_KEY` and provider limits.

Telegram webhook/auth failure:
- check `BOT_TOKEN`, `BOT_SECRET_TOKEN`, Telegram outbound connectivity, and Nginx routing.

For legacy `pepew-api :9193` RPC/Redis/ZMQ issues, troubleshoot that service separately rather than adding the dependency back to Wallet API.
