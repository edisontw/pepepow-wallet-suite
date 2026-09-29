# PEPEPOW Wallet Suite Doctor

Use `scripts/doctor.sh` to validate the current non-Docker Wallet checkout and its runtime dependencies.

## Default source checkout

The script defaults to the repository that contains it. In production this is currently:

```text
/home/ubuntu/pepepow-wallet-suite
```

Override only when intentionally testing another checkout:

```bash
CODE_ROOT=/path/to/pepepow-wallet-suite bash scripts/doctor.sh
```

## What it checks

- host/toolchain basics;
- Git source checkout and working-tree state;
- wallet-api build output and systemd unit;
- optional legacy `pepew-api :9193` presence separately;
- Wallet env keys against `.env.example`;
- PEPEW Light API `/api/status`;
- Telegram `getMe` when configured;
- optional Redis connectivity for the separate legacy `pepew-api`;
- wallet-core and Web build artifacts.

It does **not** require the historical `/opt/.../{releases,shared,current}` layout and does not test Wallet `CORE_RPC_URL`, because direct Wallet RPC dependency was retired in M6d.

## Run

```bash
cd /home/ubuntu/pepepow-wallet-suite
bash scripts/doctor.sh
```

The script does not print secrets. Exit codes remain:

- `0`: healthy
- `10`: build-time problem
- `20`: deploy/systemd problem
- `30`: runtime/connectivity problem
- `40`: config problem
