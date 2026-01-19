# Telegram Architecture (Bot, Mini App, Web Wallet)

This document is for developers and AI agents. It describes how the Telegram Bot, Telegram Mini App, and Web Wallet interact with `wallet-api` and how Telegram identity is validated.

## Roles and Responsibilities

### Telegram Bot
- Entry point and command surface (`/start`, `/balance`, `/deposit`, `/send`, `/history`).
- Sends users to the Mini App via WebApp buttons.
- Uses short-lived JWTs to call `wallet-api` for Telegram-linked data (default address lookup).
- Never signs transactions and never holds keys.

### Telegram Mini App
- The wallet UI inside Telegram. Shares the same frontend codebase as the Web Wallet.
- Uses Telegram WebApp `initData` to authenticate via `wallet-api` and obtain a JWT.
- All key generation and signing happens locally in the browser.

### Web Wallet
- Same UI as Mini App, used outside Telegram (e.g., `https://wallet.pepepow.net`).
- Uses public `wallet-api` read endpoints (`/wallet/*`) for balance/UTXO/history/fees.
- Does not have Telegram identity unless opened via Telegram WebApp.

## Data Flow Overview

### Mini App Authentication and Session
1. Telegram WebApp provides `initData` to the Mini App.
2. Mini App calls `POST /auth/telegram` on `wallet-api` with `{ initData }`.
3. `wallet-api` verifies `initData` and issues a JWT (30m expiration).
4. Mini App stores JWT in local storage and uses it for `/v1/*` endpoints.

### Bot Command Flow
1. User runs a command in the bot (e.g., `/balance`).
2. Bot creates a short-lived JWT (subject = Telegram user id) using `JWT_SECRET`.
3. Bot calls `wallet-api` to fetch default address (`GET /v1/address/default`).
4. Bot calls `wallet-api` read endpoints (`/wallet/balance`, `/wallet/history`) to return results.

### Read Queries
- `wallet-api` proxies read requests to `pepew-api`:
  - `/wallet/balance` -> `/v1/addr/:address/balance`
  - `/wallet/utxos` -> `/v1/addr/:address/utxos`
  - `/wallet/history` -> `/v1/addr/:address/txs`

### Write / Broadcast
- The client builds and signs transactions locally.
- `wallet-api` broadcasts raw transactions directly to the core node (`sendrawtransaction`).

## Telegram WebApp initData Verification

Implementation lives in `services/wallet-api/src/server.ts` and uses `TELEGRAM_BOT_TOKEN` (or `BOT_TOKEN` fallback) as the validation secret.

Steps:
1. Parse `initData` as URL query string.
2. Extract `hash`, remove it from the parameter set.
3. Create `dataCheckString` by sorting key/value pairs and joining with `\n`.
4. Compute secret: `HMAC_SHA256("WebAppData", botToken)`.
5. Compute `computedHash = HMAC_SHA256(dataCheckString, secret)`.
6. Compare hashes with a timing-safe comparison.
7. Validate `auth_date` is not in the future and within `TELEGRAM_INITDATA_MAX_AGE_SEC` (default 86400 seconds).
8. Parse `user` JSON if present and read `user.id`.

If valid, `wallet-api` issues a JWT:
- `sub` = Telegram user id
- payload: `{ telegramUserId, username }`
- expiry: 30 minutes

## `/mini?debug=1`

The Mini App route supports a debug view for Telegram context.

Example: `https://wallet.pepepow.net/mini?debug=1`

Debug info displayed:
- `hasTelegram`: whether Telegram WebApp is detected
- `initDataLen`: length of `initData`
- `userId`: Telegram user id (from `initDataUnsafe`)
- `platform`: Telegram platform identifier

If Telegram WebApp is present but `initData` is missing, the page shows a warning to test inside the Telegram mobile app.

## Telegram Database (wallet-api)

`wallet-api` stores minimal Telegram-related metadata in SQLite.

- **DB type**: SQLite (better-sqlite3)
- **Path**: `services/wallet-api/wallet.db` (auto-created next to the service)

### Tables
- `user`
  - `tg_user_id`, `tg_username`, timestamps
- `user_address`
  - Telegram user id -> address mapping
  - `address`, `label`, `is_default`, timestamps
- `payment_request`
  - Request id, from/to user, amount/memo, status, claim address, expiry

### Allowed Data
- Telegram user id and username
- Wallet address and optional label
- Payment request metadata (amount, memo, status, timestamps)

### Strictly Forbidden Data
- Mnemonic phrase or seed
- Private keys or xprv/extended keys
- Raw signed transactions or PSBTs
- Any client-side wallet state beyond public addresses

## Why the Telegram Bot Cannot Be the Wallet

- Bots cannot securely store or derive private keys.
- Bots cannot perform local signing and must never handle mnemonics.
- Telegram chat is not a secure key storage channel.
- The bot is a UI and routing layer; the wallet lives entirely in the client.

The Bot must remain stateless regarding secret material. All signing stays on the user device.
