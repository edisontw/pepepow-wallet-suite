# Systemd Deployment (No Docker)

## Runtime entrypoints
- `pepew-api`: `node /opt/pepepow-wallet-suite/current/pepew-api/pepew-api/dist/index.js` (port `9193`)
- `pepepow-wallet-api`: `node /opt/pepepow-wallet-suite/current/services/wallet-api/dist/server.js` (port `9194`)

## Install systemd units
1. Copy units:
   ```bash
   sudo cp /opt/pepepow-wallet-suite/current/systemd/*.service /etc/systemd/system/
   ```
2. If the repo lives somewhere else, update `WorkingDirectory` and `ExecStart` in the unit files.
3. Reload and enable:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now pepew-api.service pepepow-wallet-api.service
   ```

## Environment files
Create per-service env files under `/etc/pepepow`:
```bash
sudo install -d /etc/pepepow
sudo nano /etc/pepepow/pepew-api.env
sudo nano /etc/pepepow/pepepow-wallet-api.env
```

`/etc/pepepow/pepew-api.env`:
```bash
RPC_URL=http://127.0.0.1:8093
RPC_USER=change_this_user
RPC_PASS=change_this_password
API_KEY=change_this_api_key

PORT=9193
RATE_MAX=60
RATE_TIME_WINDOW=60000
REDIS_URL=
ZMQ_BLOCK=tcp://127.0.0.1:28332
```

`/etc/pepepow/pepepow-wallet-api.env`:
```bash
PEPEW_API_BASE=http://127.0.0.1:9193
CORE_RPC_URL=http://user:pass@127.0.0.1:8093
CORE_RPC_USER=
CORE_RPC_PASS=
CORE_RPC_TIMEOUT_MS=10000
JWT_SECRET=change_this_secret
PORT=9194
WALLET_API_VERSION=2024.03.29

CORS_ORIGINS=https://wallet.example.com,https://mini.example.com
BOT_TOKEN=
BOT_SECRET_TOKEN=
CMC_API_KEY=
CMC_SYMBOL=PEPEW
CMC_CONVERT=USD
WALLET_BASE_URL=https://wallet.pepepow.net
```

Notes:
- `PEPEW_API_BASE` can point to an internal `pepew-api` instance or a public upstream.
- `CORE_RPC_URL` supports inline credentials (`http://user:pass@host:port`).
- `JWT_SECRET` should be set to a strong value in production.
- Set `PORT` in `/etc/pepepow/pepepow-wallet-api.env` to avoid clashing with `pepew-api`.

## Deploy script
Build and copy runtime bundles into `/opt/pepepow-wallet-suite`, then restart services:
```bash
bash scripts/deploy.sh
```

To deploy to a different path:
```bash
bash scripts/deploy.sh /opt/pepepow-wallet-suite
```

## Restart and logs
Restart services:
```bash
sudo systemctl restart pepew-api.service pepepow-wallet-api.service
```

Tail logs:
```bash
bash scripts/logs.sh
```

Manual logs:
```bash
journalctl -u pepew-api -u pepepow-wallet-api -f --no-pager
```
