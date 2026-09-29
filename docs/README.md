# Documentation Map

Use this page to find the authoritative document for the task at hand.

> **Wallet migration status:** M6 is complete. The production Wallet architecture is Wallet API control plane + PEPEW Light API chain data plane.

## For Users

- `docs/telegram-user-guide.md` — Telegram wallet usage.
- `docs/security.md` — mnemonic/private-key safety and non-custodial guarantees.

## For Wallet Developers

- `docs/DEV_COMPASS.md` — engineering guardrails, repository navigation, and current accepted status.
- `docs/architecture.md` — current production Wallet/Telegram architecture and component boundaries.
- `docs/telegram-architecture.md` — Telegram Bot, Mini App, auth, balance/history, and send flows.
- `docs/wallet-api.md` — current Wallet API control-plane endpoints and security model.
- `docs/ENV_RULES.md` — Wallet runtime/build-time environment variables and secrets policy.
- `docs/LIGHT_API_MIGRATION.md` — completed M0-M6 Light API migration history, tests, and acceptance evidence.
- `docs/pepew-api.md` — separate legacy `pepew-api :9193` service. Do not create new Wallet dependencies on it.

## For Operators / DevOps

- `docs/runtime.md` — current production paths, readiness, deployment, and troubleshooting.
- `docs/deploy_layout.md` — active Git-checkout deployment convention and rollback guidance.
- `docs/deploy-web.md` — static Web Wallet deployment.
- `docs/systemd.md` — Wallet API unit and environment setup.
- `docs/nginx.md` — public path routing, retired-route tombstones, and verification.
- `docs/nginx-hardening-minimal.md` — baseline Nginx hardening.
- `docs/nginx-rate-limit-pepew-api.md` — rate limiting for the separate legacy/public pepew-api surface.
- `docs/api-defense-strategy.md` — API security posture and service boundary considerations.
- `docs/telegram-troubleshooting.md` — Telegram Mini App and initData troubleshooting.

## Trade / DevMM

- `docs/TRADE_ARCHITECTURE.md` — Trade security boundary and architecture.
- `docs/TRADE_STRATEGIES_SPEC.md` — strategy specifications.
- `docs/trade-api.md` — Trade API.
- `docs/trade-bot.md` — Trade Bot.
- `docs/devmm.md` — DevMM operator commands.
- `docs/DEVMM_BUG_FRAMEWORK.md` — DevMM failure taxonomy and regression framework.
- `docs/DEVMM_INCIDENT_TEMPLATE.md` — incident template.
- `scripts/devmm-doctor.sh` — DevMM diagnostic helper.
- `scripts/cleanup-devmm-logs.sh` — DevMM log retention helper.

## Authority rules

- `docs/security.md` is authoritative for non-custodial guarantees.
- `docs/DEV_COMPASS.md` is authoritative for Wallet engineering guardrails and current accepted state.
- `docs/architecture.md` describes the current Wallet target architecture now live in production.
- `docs/wallet-api.md` describes current Wallet API endpoints; retired chain proxy/RPC endpoints must not be reintroduced.
- `docs/runtime.md` is authoritative for current Wallet production runtime conventions.
- `docs/LIGHT_API_MIGRATION.md` is the historical/acceptance record for the completed M0-M6 migration.
