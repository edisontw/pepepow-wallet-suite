# Non-Docker Wallet Deployment

The active Wallet production convention is a Git checkout rather than the historical `/opt/.../current` release symlink layout.

## Production paths

```text
source:   /home/ubuntu/pepepow-wallet-suite
env:      /etc/pepepow/pepepow-wallet-api.env
webroot:  /var/www/pepepow-wallet/
service:  pepepow-wallet-api.service
```

## Deploy

```bash
cd /home/ubuntu/pepepow-wallet-suite
git fetch origin main
git pull --ff-only origin main
bash scripts/deploy.sh
```

`infra/nodocker/deploy.sh` is a thin wrapper around the same canonical deploy helper.

Wallet deployment does not build or restart `pepew-api :9193`.

## Nginx

Repository templates:
- `ops/nginx/api.conf`
- `ops/nginx/wallet.conf`

Inspect the live Nginx configuration before replacing it. Validate with:

```bash
sudo nginx -t
sudo nginx -T
```

The Wallet SPA webroot is `/var/www/pepepow-wallet/`.
