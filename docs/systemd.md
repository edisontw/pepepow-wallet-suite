# Systemd Deployment

## Current Wallet API production runtime

GitHub `main` is the development source of truth. The verified Wallet API production checkout is:

```text
/home/ubuntu/pepepow-wallet-suite
```

Wallet API runtime:

```text
service:          pepepow-wallet-api.service
WorkingDirectory: /home/ubuntu/pepepow-wallet-suite/services/wallet-api
EnvironmentFile:  /etc/pepepow/pepepow-wallet-api.env
port:             9194
```

Before replacing a production unit, inspect the live definition:

```bash
sudo systemctl cat pepepow-wallet-api.service
sudo systemctl show pepepow-wallet-api.service \
  -p ExecStart -p WorkingDirectory -p EnvironmentFiles
```

Do not assume the historical `/opt/pepepow-wallet-suite/current` release/symlink layout is active.

## Wallet API environment

Create or maintain:

```bash
sudo install -d /etc/pepepow
sudo nano /etc/pepepow/pepepow-wallet-api.env
```

Minimum relevant shape:

```bash
PORT=9194
NODE_ENV=production
PEPEW_LIGHT_API_BASE=https://light.pepepow.net
JWT_SECRET=change_this_secret
CORS_ORIGINS=https://wallet.pepepow.net,https://t.me
BOT_TOKEN=
BOT_SECRET_TOKEN=
CMC_API_KEY=
CMC_SYMBOL=PEPEW
CMC_CONVERT=USD
WALLET_BASE_URL=https://wallet.pepepow.net
```

After M6d, Wallet API does not require `PEPEW_API_BASE`, `CORE_RPC_URL`, `CORE_RPC_USER`, `CORE_RPC_PASS`, or `CORE_RPC_TIMEOUT*`.

## Install/update Wallet API unit

The checked-in Wallet API unit matches the current production checkout convention:

```bash
cd /home/ubuntu/pepepow-wallet-suite
sudo cp systemd/pepepow-wallet-api.service /etc/systemd/system/pepepow-wallet-api.service
sudo systemctl daemon-reload
sudo systemctl restart pepepow-wallet-api.service
sudo systemctl status pepepow-wallet-api.service --no-pager
```

If the installed Node version/path changes, update `ExecStart` before copying the unit.

## Validation

```bash
curl -fsS http://127.0.0.1:9194/healthz
curl -fsS http://127.0.0.1:9194/readyz
journalctl -u pepepow-wallet-api.service -n 100 --no-pager
```

Wallet `/readyz` should report PEPEW Light API and Telegram dependencies, not `pepewApi` or `coreRpc`.

## pepew-api

`pepew-api :9193` is a separate legacy service/security surface that may still serve other consumers. M6 Wallet cleanup does not remove it or require restarting it when deploying Wallet API changes.
