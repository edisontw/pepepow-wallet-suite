# Runtime Runbook

## Services and ports
- `pepew-api` (Fastify) listens on `:9193`
- `pepepow-wallet-api` (Express + Telegram bot) listens on `:9194`
- Web UI is static content served by nginx from `/srv/wallet`

Systemd units:
- `systemd/pepew-api.service`
- `systemd/pepepow-wallet-api.service`

## Runtime dependencies
Required:
- Node.js 18+ (recommend 20 LTS)
- `pepepowd` RPC reachable for both services
  - `pepew-api` uses `RPC_URL` + `RPC_USER` + `RPC_PASS`
  - `pepepow-wallet-api` uses `CORE_RPC_URL` and optionally `CORE_RPC_USER` + `CORE_RPC_PASS` (or `http://user:pass@host:port`)
  - `CORE_RPC_TIMEOUT_MS` controls wallet RPC timeout (default `10000`)
  - Ensure `rpcbind`, `rpcallowip`, `rpcuser`, `rpcpassword` are set in `pepepowd.conf`
- nginx for public routing

Optional but expected in production:
- Redis for `pepew-api` cache (`REDIS_URL`)
  - Install: `sudo apt-get install redis-server`
- ZMQ publisher from `pepepowd` for fast height updates (`ZMQ_BLOCK`)
  - Example: `-zmqpubrawblock=tcp://127.0.0.1:28332`
- Telegram Bot API for the Mini App bot (`BOT_TOKEN`, `BOT_SECRET_TOKEN`)
- CoinMarketCap API for `/api/price` (`CMC_API_KEY`)

Not used:
- MongoDB (no Mongo client or config in this repo)

## Nginx reverse proxy considerations
- `api.pepepow.net` is path-split, not single-upstream
- Route root `/health`, `/healthz`, `/readyz`, `/docs`, and selected public chain-read `/v1/*` paths to `http://127.0.0.1:9193`
- Route `/wallet/*`, `/api/*`, `/tg/*`, and wallet compatibility `/v1/*` paths to `http://127.0.0.1:9194`
- Keep `POST /v1/history` on `wallet-api` for public compatibility
- Preserve `Host`/`X-Forwarded-*` headers and sane proxy timeouts
- Allow `/.well-known/acme-challenge/` for certbot
- Pass through `/healthz` and `/readyz` to `pepew-api`
- Serve the web UI from `/srv/wallet`

See `docs/nginx.md` and `ops/nginx/` for reference configs.

## Health endpoints
`/healthz` is liveness-only. `/readyz` validates dependencies and returns `503` with an actionable error when not ready.

Local:
- `GET http://127.0.0.1:9193/healthz`
- `GET http://127.0.0.1:9193/readyz`
- `GET http://127.0.0.1:9194/healthz`
- `GET http://127.0.0.1:9194/readyz`

Via nginx:
- `GET https://api.pepepow.net/healthz`
- `GET https://api.pepepow.net/readyz`
- `GET https://api.pepepow.net/docs`
- `GET https://api.pepepow.net/v1/chain/height`
- `GET https://api.pepepow.net/wallet/healthz`
- `GET https://api.pepepow.net/wallet/readyz`

Expected JSON shapes:
- `GET /healthz`
  - `{ "ok": true, "service": "pepew-api", "uptimeSec": 123 }`
- `GET /wallet/healthz`
  - `pepepow-wallet-api` returns `{ "ok": true, "service": "wallet-api", "uptimeSec": 123 }`
- `GET /readyz` (healthy)
  - `pepew-api`: `{ "ok": true, "service": "pepew-api", "uptimeSec": 123, "deps": { "rpc": { "ok": true, "height": 123 }, "redis": { "ok": true, "detail": "PONG" } } }`
  - `GET /wallet/readyz` on the public host returns wallet readiness from `wallet-api`
- `GET /readyz` (unhealthy, `503`)
  - `pepew-api` returns `{ "ok": false, "service": "pepew-api", "deps": { ... }, "error": "rpc: ..." }`
- `GET /wallet/readyz` (unhealthy, `503`)
  - `wallet-api` returns `{ "ok": false, "service": "wallet-api", "deps": { ... }, "error": "core-rpc: ..." }`

## Quick verification
Systemd:
```bash
sudo systemctl daemon-reload
sudo systemctl restart pepew-api pepepow-wallet-api
systemctl is-active pepew-api pepepow-wallet-api
systemctl status pepew-api pepepow-wallet-api --no-pager
journalctl -u pepew-api -u pepepow-wallet-api -n 200 --no-pager
```

Health (local):
```bash
curl -sS http://127.0.0.1:9193/readyz | jq .
curl -sS http://127.0.0.1:9194/readyz | jq .
```

Health (via nginx):
```bash
curl -fsS https://api.pepepow.net/readyz | jq .
curl -fsS https://api.pepepow.net/v1/chain/height | jq .
curl -fsS https://api.pepepow.net/wallet/readyz | jq .
```

Business function:
```bash
curl -sS http://127.0.0.1:9193/v1/chain/height
```
Expected JSON:
```json
{ "height": 123 }
```

Optional wallet API verification (depends on `PEPEW_API_BASE`):
```bash
curl -sS http://127.0.0.1:9194/wallet/fee/estimate
```
Expected JSON:
```json
{ "feerate": 0.0001, "source": "fallback" }
```

## Common failures and fixes
- `RPC connection refused` in logs or `/readyz`
  - Ensure `pepepowd` is running and RPC is bound to the expected interface/port.
  - Check `RPC_URL` or `CORE_RPC_URL` and firewall rules.
- `RPC auth failed (401/403)`
  - Verify `RPC_USER`/`RPC_PASS` match `pepepowd` settings.
  - For wallet API, ensure `CORE_RPC_URL` includes the correct user/pass.
- `RPC timeout` or `host not found`
  - Validate DNS, firewall, and that `pepepowd` is reachable from the service host.
- Redis errors (`Redis connection error` or `redis ping failed`)
  - Confirm `REDIS_URL` and that Redis is running and reachable.
- ZMQ start failed
  - Confirm `pepepowd` has `-zmqpubrawblock=<tcp://host:port>` and matches `ZMQ_BLOCK`.
- `PEPEW_API_BASE not set` or upstream readiness fails
  - Set `PEPEW_API_BASE` to the `pepew-api` base host (usually `https://api.pepepow.net`) and ensure the upstream API is reachable.
- Telegram webhook returns `403`
  - Make sure `BOT_SECRET_TOKEN` matches the Telegram webhook secret.
- Telegram bot failures (`getMe`)
  - Check outbound HTTPS to `api.telegram.org:443` and verify `BOT_TOKEN` format.
- `/api/price` fails
  - Set a valid `CMC_API_KEY` and check CoinMarketCap API limits.

## Notes
- Env file location:
  - `/etc/pepepow/pepew-api.env`
  - `/etc/pepepow/pepepow-wallet-api.env`
- When deploying new releases, run `systemctl daemon-reload` after updating unit files.
- Install/update units from the repo:
  - `sudo cp /opt/pepepow-wallet-suite/current/systemd/pepew-api.service /etc/systemd/system/pepew-api.service`
  - `sudo cp /opt/pepepow-wallet-suite/current/systemd/pepepow-wallet-api.service /etc/systemd/system/pepepow-wallet-api.service`
