# Documentation Map

Use this page to find the right document based on your role.

## For Users (Non-Technical)
- `docs/telegram-user-guide.md` - How to use the Telegram wallet (simple steps).
- `docs/security.md` - Safety rules for protecting your mnemonic and funds.

## For Developers
- `docs/architecture.md` - Approved target Wallet/Telegram architecture and component boundaries.
- `docs/LIGHT_API_MIGRATION.md` - Authoritative staged migration from local wallet chain access to PEPEW Light API / ElectrumX.
- `docs/telegram-architecture.md` - Telegram Bot/Mini App/control-plane flows.
- `docs/wallet-api.md` - Current wallet-api endpoints and security model; legacy chain endpoints remain transitional until migration completes.
- `docs/pepew-api.md` - Legacy pepew-api integration overview; no new Telegram Wallet chain dependencies should be added here.
- `docs/devmm.md` - DevMM bot commands, guards, and operator-facing usage.
- `docs/DEVMM_BUG_FRAMEWORK.md` - DevMM failure taxonomy, guardrails, and regression framework.
- `docs/DEVMM_INCIDENT_TEMPLATE.md` - Incident record template for repeated DevMM bugs.

## For Operators / DevOps
- `docs/runtime.md` - Runbook, health checks, and common failures.
- `docs/deploy_layout.md` - Release directory layout.
- `docs/deploy-web.md` - Web UI deployment.
- `docs/systemd.md` - Service unit setup.
- `docs/nginx.md` - Reverse proxy guidance.
- `docs/nginx-hardening-minimal.md` - Baseline Nginx hardening.
- `docs/nginx-rate-limit-pepew-api.md` - Existing production rate limiting for pepew-api.
- `docs/api-defense-strategy.md` - Security posture for wallet-api vs public chain APIs.
- `docs/telegram-troubleshooting.md` - Telegram Mini App and initData troubleshooting.
- `scripts/devmm-doctor.sh` - One-shot DevMM status + log diagnostics.
- `scripts/cleanup-devmm-logs.sh` - DevMM log retention cleanup helper for cron/systemd timer.

## For AI Agents / Internal Engineering Only
- `docs/DEV_COMPASS.md` - Repository navigation, architecture target, and hard guardrails.
- `docs/LIGHT_API_MIGRATION.md` - Milestone order, validation, rollback, and migration completion criteria.
- `docs/ENV_RULES.md` - Environment variables and secrets policy.
- `docs/telegram-botfather-setup.md` - BotFather and webhook setup (operator-focused).
- `docs/publishing-to-github.md` - Internal release workflow.

## Authority and transition rules
- `docs/security.md` is authoritative for non-custodial guarantees.
- `docs/LIGHT_API_MIGRATION.md` is authoritative for the Light API migration sequence.
- `docs/architecture.md` describes the approved target architecture.
- `docs/wallet-api.md` continues to describe current legacy-compatible runtime endpoints until they are actually removed.
- `docs/runtime.md` is authoritative for on-call troubleshooting.
