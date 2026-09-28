# wallet-api

> **Migration status:** this document describes the current legacy-compatible runtime. The approved target is for `wallet-api` to become the Telegram/product control plane only, while PEPEW Light API handles Wallet chain reads and signed broadcast. Do not add new consumers of the legacy chain proxy/RPC endpoints. See `docs/LIGHT_API_MIGRATION.md`.
>
> **M4:** Mini App signed broadcast has moved to PEPEW Light API. `/wallet/tx/broadcast` and aliases remain only as rollback compatibility until M6; new client code must not call them.
>
> **M6a PRODUCTION ACCEPTED (2026-09-28):** `GET /wallet/balance`, `GET /wallet/utxos`, `GET /wallet/history`, and wallet-api `POST /v1/history` are retired and return 404.
>
> **M6b:** Wallet API raw-tx compatibility routes/cache/RPC fallback are removed in source and pending production acceptance. Direct-broadcast compatibility remains for a later M6 slice.

`wallet-api` is the **wallet control plane**. In the current transitional source it still authenticates Telegram users and issues short-lived JWTs; direct broadcast plus readiness/diagnostic paths are the remaining legacy chain dependencies. These are scheduled for later M6 removal. It is **not** a wallet and **not** a custodian.

## Positioning and Non-Goals

**What it is:**
- Telegram identity verification (WebApp `initData`).
- JWT issuance and rotation.
- Minimal, wallet-specific state (Telegram user <-> default address, payment requests).
- Transitional raw transaction broadcast to core RPC (scheduled for removal after Light API broadcast cutover).

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

## /wallet and /api Endpoints (Read/Broadcast)

| Method | Path | Purpose | JWT Required |
| --- | --- | --- | --- |
| GET | `/healthz` | Liveness | No |
| GET | `/readyz` | Dependency readiness | No |
| GET | `/healthz/rpc` | Core RPC health | No |
| GET | `/wallet/healthz` | Liveness | No |
| GET | `/wallet/readyz` | Dependency readiness | No |
| GET | `/wallet/healthz/rpc` | Core RPC health | No |
| POST | `/wallet/tx/broadcast` | Broadcast raw tx to core RPC | No |
| POST | `/wallet/tx/send` | Alias of `/wallet/tx/broadcast` | No |
| POST | `/api/tx/send` | Legacy alias of `/wallet/tx/broadcast` | No |
| GET | `/wallet/price` | Alias of `/v1/price` | No |
| GET | `/api/price` | Alias of `/v1/price` | No |
| POST | `/api/paylink/create` | Create JWT-signed payment link | No |
| GET | `/api/paylink/verify` | Verify payment link token | No |
| POST | `/tg/webhook` | Telegram bot webhook | No (verified by secret token header) |

## pepew-api vs wallet-api (Quick Comparison)

| Dimension | wallet-api | pepew-api |
| --- | --- | --- |
| Purpose | Wallet control plane | Chain data indexer / proxy |
| Auth | JWT (Telegram identity) | No auth (public) |
| Writes | Broadcast raw tx only | Read-only in wallet usage |
| Data Store | Minimal Telegram metadata (SQLite) | Cache/index data (Redis, node) |
| Threat Surface | Auth abuse, broadcast spam | High-volume scraping / DoS |

## Why wallet-api Does NOT Provide a Balance Index

- Indexing belongs to `pepew-api`, which is built for read-heavy chain queries.
- Keeping `wallet-api` stateless and minimal reduces attack surface.
- Avoids duplicated chain state and inconsistent indexing logic.
- Keeps the wallet control plane focused on auth, broadcast, and user bindings.

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
- Separate limiters for auth, read, and tx flows.
- IP-based limits with optional JWT-subject limits.
- Tx endpoints are intentionally stricter than read endpoints.

For production-level limits, see `docs/nginx-rate-limit-pepew-api.md` and `docs/security.md`.

### Telegram Webhook Secret
- `POST /tg/webhook` validates `x-telegram-bot-api-secret-token` when `BOT_SECRET_TOKEN` is set.
