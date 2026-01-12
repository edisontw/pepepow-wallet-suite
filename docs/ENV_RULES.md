# Environment Rules

This project depends on systemd-managed environment files in production. Do not store secrets in the repo.

## Precedence and layering (wallet-api)
1) Required systemd file: `/etc/pepepow/pepepow-wallet-api.env`
2) Shell environment when running manually

The systemd unit only loads `/etc/pepepow/pepepow-wallet-api.env`. Do not set `Environment=` entries for runtime configuration in the unit.

## Systemd unit location
Canonical unit file in the repo:
- `/opt/pepepow-wallet-suite/current/systemd/pepepow-wallet-api.service`

Install/update:
```bash
sudo cp /opt/pepepow-wallet-suite/current/systemd/pepepow-wallet-api.service /etc/systemd/system/pepepow-wallet-api.service
sudo systemctl daemon-reload
sudo systemctl restart pepepow-wallet-api.service
sudo systemctl status pepepow-wallet-api.service --no-pager
```

## Do not commit
- `/etc/pepepow/*.env`
- `.env`, `.env.*`, `*.local`, or any file that contains secrets

## Naming conventions
- Use `UPPER_SNAKE_CASE`.
- Wallet API variables are prefixed with `WALLET_API_` when they are specific to this service.
- Web (Vite) build-time variables must start with `VITE_`.

## Wallet API required/important variables
Required for production:
- `PORT` (default: `9194`)
- `PEPEW_API_BASE` (pepew-api base URL)
- `CORE_RPC_URL` (RPC URL, may include user/pass)
- `JWT_SECRET` (JWT signing secret)
- `CORS_ORIGINS` (comma-separated)
- `WALLET_BASE_URL` (for paylinks)

Recommended/optional:
- `CORE_RPC_USER`, `CORE_RPC_PASS` (if not embedded in `CORE_RPC_URL`)
- `CORE_RPC_TIMEOUT_MS` (default: `10000`)
- `CMC_API_KEY` (enables `/wallet/price`)
- `CMC_SYMBOL` (default: `PEPEW`)
- `CMC_CONVERT` (default: `USD`)
- `TELEGRAM_BOT_TOKEN` (Telegram initData auth)
- `TELEGRAM_INITDATA_MAX_AGE_SEC` (default: `86400`)
- `BOT_TOKEN`, `BOT_SECRET_TOKEN` (Telegram bot/webhook)
- `FEE_ESTIMATE_TARGET` (default: `6`)
- `FEE_ESTIMATE_FALLBACK` (default: `0.0001`)
- `WALLET_API_DEBUG_RAWTX` (`1` to write raw tx to `/tmp/rawtx.hex`)
- `WALLET_API_VERSION` (release/version string returned by `/healthz`)
- `WALLET_API_GIT_SHA` (optional git commit SHA returned by `/healthz`)

Rate limiting (per IP + per JWT subject):
- `WALLET_API_RATE_LIMIT_READ_WINDOW_MS` (default: `60000`)
- `WALLET_API_RATE_LIMIT_READ_MAX` (default: `120`)
- `WALLET_API_RATE_LIMIT_JWT_READ_MAX` (default: same as read max)
- `WALLET_API_RATE_LIMIT_TX_WINDOW_MS` (default: `600000`)
- `WALLET_API_RATE_LIMIT_TX_MAX` (default: `20`)
- `WALLET_API_RATE_LIMIT_JWT_TX_MAX` (default: same as tx max)
- `WALLET_API_RATE_LIMIT_AUTH_WINDOW_MS` (default: `600000`)
- `WALLET_API_RATE_LIMIT_AUTH_MAX` (default: `60`)

## Web wallet build-time variables
- `VITE_API_BASE` (default: `https://api.pepepow.net`)

These values are baked at build time (Vite). Changing them requires a rebuild.

## Example: `/etc/pepepow/pepepow-wallet-api.env`
```
PORT=9194
NODE_ENV=production
PEPEW_API_BASE=https://api.pepepow.net
CORE_RPC_URL=http://127.0.0.1:8093
JWT_SECRET=replace-with-strong-secret
CORS_ORIGINS=https://wallet.pepepow.net
WALLET_BASE_URL=https://wallet.pepepow.net
WALLET_API_VERSION=2024.03.29
WALLET_API_GIT_SHA=abcdef1234567890

FEE_ESTIMATE_TARGET=6
FEE_ESTIMATE_FALLBACK=0.0001

WALLET_API_RATE_LIMIT_READ_WINDOW_MS=60000
WALLET_API_RATE_LIMIT_READ_MAX=120
WALLET_API_RATE_LIMIT_JWT_READ_MAX=120
WALLET_API_RATE_LIMIT_TX_WINDOW_MS=600000
WALLET_API_RATE_LIMIT_TX_MAX=20
WALLET_API_RATE_LIMIT_JWT_TX_MAX=20
```

## Security principles
- Non-custodial: mnemonic/private keys must never be sent to or stored on the server.
- Do not enable any backend signing or storage of secrets.
- Keep debug flags (like raw tx dumps) off in production unless needed.
