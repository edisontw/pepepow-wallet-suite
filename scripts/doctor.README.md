# PEPEPOW Wallet Suite Doctor (No-Docker v4.1.1)

Use this toolkit to validate an Ubuntu host running the non-Docker release layout (`/opt/pepepow-wallet-suite/{releases,shared,current}`).

## Runnable components
- wallet-api (Node, default port 9194) – systemd unit: `pepepow-wallet-api.service`
- Web static files served from `/srv/wallet` (built by `apps/web`)
- Optional original `pepew-api` (Node, default port 9193) if you deploy it separately

## Run
```bash
bash scripts/doctor.sh             # assumes /opt/pepepow-wallet-suite as APP_ROOT
# or override paths
APP_ROOT=/opt/pepepow-wallet-suite CODE_ROOT=/opt/pepepow-wallet-suite/current bash scripts/doctor.sh
```

The script uses safe flags (`set -euo pipefail`), avoids printing secrets, and masks credentials in URLs.

## What it checks
- Host: OS/kernel, CPU/RAM, disk, ulimit, timezone
- Toolchain: Node (>=18), npm, python3, g++, make, openssl, curl
- Layout: existence of `/shared`, `/current` with `current` as a symlink (missing `/releases` is a warning)
- Builds: wallet-core, wallet-api, web dist, optional pepew-api dist
- Services: systemd presence/enablement for wallet-api, port conflicts (9194, 9193 if present)
- Config: compares `/etc/pepepow/*.env` against `.env.example` (falls back to `/shared/.env`), lists missing keys (no values shown)
- Connectivity (if variables exist): Core RPC JSON-RPC, Redis, Telegram getMe
- Dependency sanity: `node` imports for key modules used by API/core

## Exit codes
- `0` healthy
- `10` build-time problems
- `20` deploy-time problems
- `30` runtime problems
- `40` missing/invalid config

The summary block at the end shows counts per category and next actions to take. Save reports with:
```bash
scripts/doctor.sh | tee logs/doctor_report.txt
```
