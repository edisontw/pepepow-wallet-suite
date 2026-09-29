# Deployment Layout

## Active production convention

The current Wallet Suite production source checkout is:

```text
/home/ubuntu/pepepow-wallet-suite
```

GitHub `main` is pulled into this checkout and is the development source of truth.

Persistent/runtime locations:

```text
/etc/pepepow/pepepow-wallet-api.env
/var/www/pepepow-wallet/
/etc/systemd/system/pepepow-wallet-api.service
```

The historical immutable-release layout:

```text
/opt/pepepow-wallet-suite/releases/
/opt/pepepow-wallet-suite/current
/opt/pepepow-wallet-suite/shared/
```

is not the active Wallet production convention and must not be assumed by new deployment code.

## Deployment flow

```bash
cd /home/ubuntu/pepepow-wallet-suite
git fetch origin main
git pull --ff-only origin main
bash scripts/deploy.sh
```

Before a production change, inspect the current SHA and live systemd/Nginx configuration. Do not overwrite live configuration based only on an old template.

## Rollback

Rollback should be deliberate:

1. identify the previously accepted Git SHA;
2. restore that code in the production checkout;
3. rebuild wallet-api/Web assets;
4. restart only Wallet API;
5. verify `/healthz`, `/readyz`, Telegram `/balance` and `/history`.

Do not couple Wallet rollback to `pepew-api :9193` unless that separate service was independently changed.
