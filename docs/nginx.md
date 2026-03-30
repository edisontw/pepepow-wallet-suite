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

For `api.pepepow.net`, the split is intentional:

- root `/health`, `/healthz`, `/readyz`, `/docs`, and selected chain-read `/v1/*` paths belong to `pepew-api`
- `/wallet/*`, `/api/*`, `/tg/*`, and wallet compatibility `/v1/*` paths belong to `wallet-api`
- `POST /v1/history` remains on `wallet-api` for compatibility

Do not simplify this back into a single default upstream for all `/v1/*` traffic.

## Install / enable

Pick one of the following patterns depending on your Nginx layout:

1) `sites-available` + `sites-enabled`

```bash
sudo install -d /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo cp ops/nginx/api.conf /etc/nginx/sites-available/api.pepepow.net
sudo ln -sfn /etc/nginx/sites-available/api.pepepow.net /etc/nginx/sites-enabled/api.pepepow.net
```

2) `conf.d`

```bash
sudo cp ops/nginx/api.conf /etc/nginx/conf.d/api.pepepow.net.conf
```

Then validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

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
