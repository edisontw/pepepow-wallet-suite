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
- M6a retires wallet-api `POST /v1/history`; the explicit Nginx route may remain temporarily pointed at wallet-api so legacy requests fail closed with 404 until the later Nginx cleanup slice

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
- `wallet_tx_ip`: `6r/m`, retained for the separate `pepew-api :9193` `/v1/tx/broadcast` compatibility path
- `api_per_ip_conn`: `20` concurrent connections per IP at the server block

Wallet API direct-broadcast routes are retired in M6c. The `wallet_tx_ip` Nginx zone remains because the separate `pepew-api :9193` `/v1/tx/broadcast` compatibility route is outside M6c scope.

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


### M6b raw-tx tombstone

Keep an explicit `location ^~ /v1/tx/raw/` block that returns `404`. Do not simply delete the block while the broader `/v1/tx/` route still proxies to `pepew-api :9193`, otherwise the retired Wallet raw-tx path can fall through to the legacy chain API.


### M6c direct-broadcast tombstones

Keep exact `404` tombstones for `/wallet/tx/broadcast`, `/wallet/tx/send`, and `/api/tx/send`. These paths must not proxy to wallet-api after M6c. The separate `/v1/tx/broadcast` route on `pepew-api :9193` remains outside this slice.
