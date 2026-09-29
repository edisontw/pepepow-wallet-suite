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
- Wallet env keys against `.env.example`;
- PEPEW Light API `/api/status`;
- Telegram `getMe` when configured;
- wallet-core and Web build artifacts.

It does **not** require the historical `/opt/.../{releases,shared,current}` layout, does not test Wallet `CORE_RPC_URL`, and does not inspect `pepew-api :9193`/Redis because those are separate from the Wallet runtime boundary.

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
