# Documentation Map

Use this page to find the right document based on your role.

## For Users (Non-Technical)
- `docs/telegram-user-guide.md` - How to use the Telegram wallet (simple steps).
- `docs/security.md` - Safety rules for protecting your mnemonic and funds.

## For Developers
- `docs/architecture.md` - System overview and component boundaries.
- `docs/telegram-architecture.md` - Telegram Bot/Mini App/Web Wallet flows and DB rules.
- `docs/wallet-api.md` - wallet-api purpose, endpoints, and security model.
- `docs/pepew-api.md` - pepew-api integration overview.

## For Operators / DevOps
- `docs/runtime.md` - Runbook, health checks, and common failures.
- `docs/deploy_layout.md` - Release directory layout.
- `docs/deploy-web.md` - Web UI deployment.
- `docs/systemd.md` - Service unit setup.
- `docs/nginx.md` - Reverse proxy guidance.
- `docs/nginx-hardening-minimal.md` - Baseline Nginx hardening.
- `docs/nginx-rate-limit-pepew-api.md` - Production rate limiting for pepew-api.
- `docs/api-defense-strategy.md` - Security posture for wallet-api vs pepew-api.
- `docs/telegram-troubleshooting.md` - Telegram Mini App and initData troubleshooting.

## For AI Agents / Internal Engineering Only
- `docs/DEV_COMPASS.md` - Repository navigation and guardrails.
- `docs/ENV_RULES.md` - Environment variables and secrets policy.
- `docs/telegram-botfather-setup.md` - BotFather and webhook setup (operator-focused).
- `docs/publishing-to-github.md` - Internal release workflow.

## Cross-References
- `docs/security.md` is authoritative for non-custodial guarantees.
- `docs/runtime.md` is authoritative for on-call troubleshooting.
