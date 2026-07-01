# Nginx

## Overview

Nginx vhosts live in `ops/nginx/` and proxy to local services:

- `api.pepepow.net` is a path-split host
- public chain-read routes go to `http://127.0.0.1:9193` (`pepew-api`)
- wallet-domain routes go to `http://127.0.0.1:9194` (`wallet-api`)

Each vhost includes:

- HTTP -> HTTPS redirect
- HSTS header
- `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`
- sane proxy timeouts
- `/healthz` and `/readyz` passthrough
- optional rate-limit zones via an `http {}` include

For `api.pepepow.net`, the split is intentional:

- root `/health`, `/healthz`, `/readyz`, `/docs`, and selected chain-read `/v1/*` paths belong to `pepew-api`
- `/wallet/*`, `/api/*`, `/tg/*`, and wallet compatibility `/v1/*` paths belong to `wallet-api`
- `POST /v1/history` remains on `wallet-api` for compatibility

Do not simplify this back into a single default upstream for all `/v1/*` traffic.

## Install / enable

Pick one of the following patterns depending on your Nginx layout:

1) Install the shared `http {}` include first:

```bash
sudo cp ops/nginx/pepepow-rate-limit.conf /etc/nginx/conf.d/pepepow-rate-limit.conf
```

2) `sites-available` + `sites-enabled`

```bash
sudo install -d /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo cp ops/nginx/api.conf /etc/nginx/sites-available/pepepow-api
sudo cp ops/nginx/api.conf /etc/nginx/sites-enabled/pepepow-api
```

3) `conf.d`

```bash
sudo cp ops/nginx/pepepow-rate-limit.conf /etc/nginx/conf.d/pepepow-rate-limit.conf
sudo cp ops/nginx/api.conf /etc/nginx/conf.d/api.pepepow.net.conf
```

Then validate and reload:

```bash
sudo nginx -t
sudo nginx -T | rg 'pepepow_api_timing|limit_req_zone|wallet_tx_ip|pepew_api_heavy'
sudo systemctl reload nginx
```

## Conservative hardening defaults

The production `api.pepepow.net` vhost is intended to use these shared zones:

- `pepew_api_light`: `8r/s`
- `pepew_api_heavy`: `2r/s`
- `wallet_auth_ip`: `6r/m`
- `wallet_resolve_ip`: `20r/m`
- `wallet_request_ip`: `15r/m`
- `wallet_tx_ip`: `6r/m`, with `burst=12` on transaction broadcast paths
- `api_per_ip_conn`: `20` concurrent connections per IP at the server block

Wallet transaction broadcasts are user-initiated and may happen in short bursts when users test small sends or retry after pending UTXO/indexer updates. The `wallet_tx_ip` limit should allow normal short bursts while still blocking sustained automated sends.

Heavy public read paths:

- `GET /v1/addr/:address/balance`
- `GET /v1/addr/:address/utxos`
- `GET /v1/addr/:address/txs`
- `GET /v1/mempool/info`
- `GET /v1/tx/:txid`

Sensitive wallet paths:

- `POST /auth/telegram`
- `POST /api/auth/telegram`
- `GET /v1/resolve`
- `POST /v1/requests`
- `POST /v1/requests/:id/claim`
- `POST /wallet/tx/broadcast`
- `POST /wallet/tx/send`
- `POST /api/tx/send`
- `POST /v1/tx/broadcast`

## Certbot notes

The vhosts include `/.well-known/acme-challenge/` with `root /var/www/certbot` for webroot-based issuance.

```bash
sudo install -d /var/www/certbot
sudo certbot certonly --webroot \
  -w /var/www/certbot \
  -d api.pepepow.net
```

If you prefer `--nginx`, certbot may add or update TLS directives. Keep the HSTS header and proxy headers intact.

## Verification

```bash
curl -I http://api.pepepow.net
```

```bash
curl -fsS https://api.pepepow.net/healthz
curl -fsS https://api.pepepow.net/readyz
curl -fsS https://api.pepepow.net/docs
curl -fsS https://api.pepepow.net/v1/chain/height
curl -fsS https://api.pepepow.net/v1/mempool/info
curl -fsS https://api.pepepow.net/wallet/healthz
curl -fsS https://api.pepepow.net/wallet/readyz
curl -fsS https://api.pepepow.net/v1/price
```

Confirm the timing log is active:

```bash
sudo tail -n 20 /var/log/nginx/pepepow-api.access.log
```

Low-load rate-limit confirmation:

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" https://api.pepepow.net/v1/mempool/info
done
```

## Rollback

```bash
sudo rm -f /etc/nginx/conf.d/pepepow-rate-limit.conf
sudo cp /path/to/known-good/pepepow-api /etc/nginx/sites-available/pepepow-api
sudo cp /path/to/known-good/pepepow-api /etc/nginx/sites-enabled/pepepow-api
sudo nginx -t
sudo systemctl reload nginx
```
