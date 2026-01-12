# Deployment Layout (No-Docker, Ubuntu)

This project is deployed as immutable releases under `/opt/pepepow-wallet-suite`, with a `current` symlink and a shared config/data directory. The goal is safe, fast deploys and easy rollbacks without Docker.

## Directory Layout

```text
/opt/pepepow-wallet-suite/
  releases/
    20260112100000/        # Release extracted from tarball
    20260110090000/
  shared/
    logs/
    data/
  current -> releases/20260112100000
```

- `releases/`: Contains specific versions of the software. Each deploy creates a new directory here.
- `current`: A symlink pointing to the active release. Switched atomically.
- `shared/`: Persistent data and logs that survive across releases.
- `EnvironmentFile`: Production secrets live in `/etc/pepepow/*.env`.

## Systemd Templates

Configuration templates live in `systemd/*.example.service` in the repository. They expect:
- `WorkingDirectory` per service:
  - `pepew-api`: `/opt/pepepow-wallet-suite/current`
  - `pepepow-wallet-api`: `/opt/pepepow-wallet-suite/current/services/wallet-api`
- `EnvironmentFile`:
  - `/etc/pepepow/pepew-api.env`
  - `/etc/pepepow/pepepow-wallet-api.env`

### Installation

```bash
sudo cp systemd/*.example.service /etc/systemd/system/pepepow-wallet-api.service
# Edit the file to match your paths
sudo systemctl daemon-reload
sudo systemctl enable --now pepepow-wallet-api.service
```

## Nginx Configuration

Templates live in `nginx/*.example.conf`. They handle:
- Static file serving for the Web Wallet.
- Reverse proxying for API services.
- TLS termination and security headers.

## Deployment Scripts

- `scripts/pack_release.sh`: Builds and packages the app into a tarball.
- `scripts/deploy_release.sh`: Extracts the tarball on the server, updates the symlink, and restarts services.
- `scripts/rollback.sh`: Reverts to the previous release.

## Smoke Testing

The deployment script includes a smoke test phase. Set `SMOKE_URL` or `SMOKE_PORT` to verify service health before completing the deploy.
