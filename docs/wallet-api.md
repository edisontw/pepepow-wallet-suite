# wallet-api

`wallet-api` is the **wallet control plane**. It authenticates Telegram users, issues short-lived JWTs, proxies read calls to `pepew-api`, and broadcasts raw transactions to the core node. It is **not** a wallet and **not** a custodian.

## Positioning and Non-Goals

**What it is:**
- Telegram identity verification (WebApp `initData`).
- JWT issuance and rotation.
- Minimal, wallet-specific state (Telegram user <-> default address, payment requests).
- Read proxies to `pepew-api`.
- Raw transaction broadcast to core RPC.

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
| POST | `/v1/history` | Batch history proxy (addresses[]) | No |
| GET | `/v1/price` | PEPEW price (CoinMarketCap) | No |

`POST /v1/history` intentionally remains on `wallet-api` on the public host for compatibility with the existing web wallet flow. It should not be reassigned to the public `pepew-api` route set.

## /wallet and /api Endpoints (Read/Broadcast)

| Method | Path | Purpose | JWT Required |
| --- | --- | --- | --- |
| GET | `/healthz` | Liveness | No |
| GET | `/readyz` | Dependency readiness | No |
| GET | `/healthz/rpc` | Core RPC health | No |
| GET | `/wallet/healthz` | Liveness | No |
| GET | `/wallet/readyz` | Dependency readiness | No |
| GET | `/wallet/healthz/rpc` | Core RPC health | No |
| GET | `/wallet/balance?address=` | Balance proxy to `pepew-api` | No |
| GET | `/wallet/utxos?address=` | UTXO proxy to `pepew-api` | No |
| GET | `/wallet/history?address=` | History proxy to `pepew-api` | No |
| GET | `/wallet/fee/estimate` | Fee estimate via core RPC | No |
| POST | `/wallet/tx/broadcast` | Broadcast raw tx to core RPC | No |
| POST | `/wallet/tx/send` | Alias of `/wallet/tx/broadcast` | No |
| POST | `/api/tx/send` | Legacy alias of `/wallet/tx/broadcast` | No |
| GET | `/wallet/tx/raw` | Raw tx lookup (proxy + RPC fallback) | No |
| GET | `/v1/tx/raw/:txid` | Raw tx lookup (v1 path compatibility) | No |
| POST | `/wallet/tx/raw/batch` | Batch raw tx lookup (cache + proxy/RPC fallback) | No |
| GET | `/api/tx/raw` | Alias of `/wallet/tx/raw` | No |
| POST | `/api/tx/raw/batch` | Alias of `/wallet/tx/raw/batch` | No |
| GET | `/wallet/price` | Alias of `/v1/price` | No |
| GET | `/api/price` | Alias of `/v1/price` | No |
| POST | `/api/paylink/create` | Create JWT-signed payment link | No |
| GET | `/api/paylink/verify` | Verify payment link token | No |
| POST | `/tg/webhook` | Telegram bot webhook | No (verified by secret token header) |

### RawTx Hot Cache and Batch Controls

- `RAW_TX_CACHE_TTL_MS` (default `20000`)
- `RAW_TX_CACHE_MAX` (default `2000`)
- `RAW_TX_BATCH_MAX` (default `50`, hard-capped at `50`)
- `RAW_TX_BATCH_CONCURRENCY` (default `6`, clamped to `1..10`)

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
