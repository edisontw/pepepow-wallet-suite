# wallet-api

> **Migration status:** M6 is complete. `wallet-api` is the Telegram/product control plane only; PEPEW Light API handles Wallet chain reads and signed broadcast. Legacy Wallet chain proxy/RPC endpoints are retired and must not be reintroduced. See `docs/LIGHT_API_MIGRATION.md`.
>
> **M4:** Mini App signed broadcast moved to PEPEW Light API. The legacy Wallet API broadcast aliases remained only as rollback compatibility and are removed by M6c; new client code must not call them.
>
> **M6a PRODUCTION ACCEPTED (2026-09-28):** `GET /wallet/balance`, `GET /wallet/utxos`, `GET /wallet/history`, and wallet-api `POST /v1/history` are retired and return 404.
>
> **M6b PRODUCTION ACCEPTED (2026-09-29):** Wallet API raw-tx compatibility routes/cache/RPC fallback are retired in production and return 404.
>
> **M6c PRODUCTION ACCEPTED (2026-09-29):** Wallet API direct-broadcast routes and direct `sendrawtransaction` implementation are retired in production and return 404.
>
> **M6d PRODUCTION ACCEPTED (2026-09-29):** Wallet API no longer depends on legacy `pepew-api` or direct node RPC for readiness. `/readyz` checks PEPEW Light `/api/status` plus Telegram; RPC health endpoints are retired.
>
> **M6e PRODUCTION ACCEPTED (2026-09-29):** Wallet production env, deployment tooling, doctor checks, systemd guidance, webroot, and Nginx retired-route handling are aligned with the current production runtime. Legacy Wallet chain env keys are removed; Wallet doctor is isolated from `pepew-api :9193`.
>
> **M6f PRODUCTION ACCEPTED (2026-09-29):** final isolation passed. Wallet API/Web/env/systemd/deploy/doctor/Nginx boundaries are isolated from legacy Wallet chain dependencies; the separate `pepew-api :9193` service remains available only for its own legacy consumers.

`wallet-api` is the **Wallet control plane**. It authenticates Telegram users and serves product/control-plane state; chain readiness is aligned to PEPEW Light API rather than direct legacy chain infrastructure. It is **not** a wallet and **not** a custodian.

## Positioning and Non-Goals

**What it is:**
- Telegram identity verification (WebApp `initData`).
- JWT issuance and rotation.
- Minimal, wallet-specific state (Telegram user <-> default address, payment requests).

**What it is NOT:**
- A key store (no mnemonics, no private keys).
- A signer (no transaction signing).
- A blockchain indexer.
- A public data API for general chain queries.

## Service
- Default port: `:9194`
- Process: `pepepow-wallet-api.service`
- DB: SQLite at `services/wallet-api/wallet.db`

## Auth Model

- **Telegram WebApp auth**: `POST /auth/telegram`
  - Validates `initData` using bot token.
  - Issues JWT (`exp = 30m`).
- **JWT usage**: for `/v1/*` routes that require Telegram identity.
- **Bot JWT**: Bot uses `JWT_SECRET` to sign short-lived tokens for bot-driven queries.

## v1 Endpoints (Wallet Domain)

| Method | Path | Purpose | JWT Required |
| --- | --- | --- | --- |
| POST | `/auth/telegram` | Verify Telegram `initData` and issue JWT | No |
| POST | `/api/auth/telegram` | Alias of `/auth/telegram` | No |
| GET | `/v1/whoami` | Return Telegram user info from JWT | Yes |
| POST | `/v1/profile/upsert` | Upsert Telegram username; rotates JWT | Yes |
| GET | `/v1/address/default` | Get default address for Telegram user | Yes |
| POST | `/v1/address/default` | Set default address for Telegram user | Yes |
| GET | `/v1/resolve` | Resolve `@username` or `toTgUserId` -> default address | Yes |
| POST | `/v1/requests` | Create payment request | Yes |
| POST | `/v1/requests/:id/claim` | Claim payment request and set default address | Yes |
| GET | `/v1/requests/:id` | Get payment request status | Yes |
| GET | `/v1/price` | PEPEW price (CoinMarketCap) | No |

## /wallet and /api Endpoints (Control/Health)

| Method | Path | Purpose | JWT Required |
| --- | --- | --- | --- |
| GET | `/healthz` | Liveness | No |
| GET | `/readyz` | PEPEW Light + Telegram dependency readiness | No |
| GET | `/wallet/healthz` | Liveness | No |
| GET | `/wallet/readyz` | Alias of Wallet readiness | No |
| GET | `/wallet/price` | Alias of `/v1/price` | No |
| GET | `/api/price` | Alias of `/v1/price` | No |
| POST | `/api/paylink/create` | Create JWT-signed payment link | No |
| GET | `/api/paylink/verify` | Verify payment link token | No |
| POST | `/tg/webhook` | Telegram bot webhook | No (verified by secret token header) |

## Service boundary comparison

| Dimension | wallet-api | PEPEW Light API | legacy pepew-api |
| --- | --- | --- | --- |
| Purpose | Telegram/product control plane | Wallet blockchain data plane | Separate legacy/public chain API |
| Wallet dependency | Required for identity/product features | Required for Wallet chain access | None |
| Auth | JWT / Telegram identity | Public Wallet query/broadcast contract | Service-specific/public compatibility |
| Writes | Product/control-plane state only | Already-signed raw transaction broadcast | Legacy compatibility surface |
| Wallet secrets | Forbidden | Forbidden | Forbidden |
| Direct Wallet signing | Never | Never | Never |

## Why wallet-api Does NOT Provide Chain Indexing

- Wallet chain indexing/query responsibility belongs to PEPEW Light API backed by ElectrumX.
- Keeping `wallet-api` focused on product/control-plane state reduces attack surface.
- Avoids duplicated chain state and inconsistent indexing logic.
- Keeps Telegram identity/payment metadata separate from blockchain data-plane responsibilities.

## Security Notes

### JWT Lifecycle
- Issued via `POST /auth/telegram` after `initData` verification.
- Expires in 30 minutes.
- Rotated on `/v1/profile/upsert` to include updated username.
- Stored client-side (localStorage) and sent as `Authorization: Bearer <token>`.

### IP / Origin Restrictions
- CORS allowlist is configured via `CORS_ORIGINS`.
- Nginx should enforce host and path routing (`/wallet/*` -> wallet-api).
- `wallet-api` trusts a single proxy hop (`trust proxy = 1`).

### Rate Limiting (Conceptual)
- Wallet API applies limits to auth and product/control-plane reads/actions.
- IP-based limits may be combined with JWT-subject limits.
- Signed blockchain broadcast is not a Wallet API responsibility; PEPEW Light API owns that chain-facing rate-limit boundary.

For public legacy pepew-api limits, see `docs/nginx-rate-limit-pepew-api.md`. For Wallet security principles, see `docs/security.md`.

### Telegram Webhook Secret
- `POST /tg/webhook` validates `x-telegram-bot-api-secret-token` when `BOT_SECRET_TOKEN` is set.
