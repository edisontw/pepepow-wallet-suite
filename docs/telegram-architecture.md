# Telegram Architecture: Bot, Mini App, and Wallet Control Plane

> Current production Telegram/Wallet architecture.
>
> The PEPEW Light migration M0-M6 is complete. Wallet chain access uses PEPEW Light API; Wallet API remains the Telegram/product control plane.

## Roles

### Telegram Bot

Command and navigation surface:

- `/start`
- `/balance`
- `/deposit`
- `/send`
- `/history`

The bot never holds keys, derives private keys, builds transactions, or signs.

### Telegram Mini App

The wallet UI inside Telegram.

- Shares wallet behavior with the Web Wallet.
- Handles mnemonic/private-key material only on the client.
- Uses wallet-core for derivation and transaction construction/signing.
- Uses wallet-api for Telegram identity/product functions.
- Uses PEPEW Light API for blockchain chain access.

### wallet-api :9194

Telegram/product control plane.

Responsibilities:

- verify Telegram WebApp `initData`;
- issue short-lived JWT;
- store minimal Telegram metadata;
- default public address binding;
- resolve Telegram user/username to public address;
- payment request / claim flows;
- Telegram webhook.

Non-responsibilities:

- balance/UTXO/history proxy;
- raw transaction lookup for signing;
- direct node broadcast;
- blockchain indexing.

### PEPEW Light API

Blockchain data plane:

```text
GET  /api/wallet/address/{address}
GET  /api/wallet/history/{address}
GET  /api/wallet/utxo/{address}
GET  /api/wallet/tx/{txid}
POST /api/wallet/broadcast
```

Backed by private ElectrumX.

## Mini App authentication

1. Telegram WebApp provides `initData`.
2. Mini App calls `POST /auth/telegram` on wallet-api.
3. wallet-api verifies `initData` with the Telegram bot token.
4. wallet-api issues a short-lived JWT.
5. The JWT is used only for authenticated Telegram/product routes such as `/v1/*`.

Blockchain reads do not require sending the mnemonic/private key or turning the chain API into an identity service.

## Telegram initData verification

Implementation remains in `services/wallet-api/src/server.ts`.

Required validation:

1. Parse `initData`.
2. Remove `hash`.
3. Sort key/value pairs and join with newline.
4. Derive Telegram WebApp HMAC secret from the bot token.
5. Compute and timing-safely compare the expected hash.
6. Validate `auth_date` age and future timestamps.
7. Parse Telegram user data only after verification.

## Bot command flows

### /start

```text
Bot
 -> onboarding message
 -> Mini App WebApp button
```

### /deposit

```text
Bot
 -> short-lived bot JWT
 -> wallet-api GET /v1/address/default
 -> display the user's bound public receive address / open Mini App
```

### /balance

Current production flow:

```text
Bot
 -> wallet-api GET /v1/address/default
 -> obtain public PEPEW address
 -> PEPEW Light API GET /api/wallet/address/{address}
 -> format balance
```

The retired `wallet-api /wallet/balance` proxy must not be reintroduced.

### /history

Current after M3:

```text
Bot
 -> wallet-api GET /v1/address/default
 -> PEPEW Light API GET /api/wallet/history/{address}?limit=10
 -> format recent transactions
```

The retired `wallet-api /wallet/history` proxy must not be reintroduced.

### /send

```text
Bot
 -> open Mini App
 -> client performs wallet send flow
```

The chat bot itself must never sign.

## Mini App chain flow

### Balance / history

```text
Mini App
 -> dedicated Light API client
 -> PEPEW Light API
 -> ElectrumX
```

### Send

```text
Mini App
 -> refresh UTXO
 -> exclude recent-spent outpoints
 -> local UTXO selection
 -> fetch previous tx/raw data from PEPEW Light API when needed
 -> build locally
 -> sign locally
 -> POST /api/wallet/broadcast with { raw_tx }
 -> reconcile UTXO/history
```

Only the signed raw transaction may be submitted.

## Fee policy

M5 uses a deterministic client-side transaction-size policy. The Mini App computes fee locally from selected input/output count with a 0.0001 PEPEW minimum and 0.0001 PEPEW/kB rate.

The Mini App no longer calls `wallet-api /wallet/fee/estimate`, and fee calculation does not require Wallet API direct RPC.

## Telegram database

wallet-api may store minimal product metadata in SQLite/PostgreSQL.

Allowed:

- Telegram user id;
- Telegram username;
- public wallet address;
- label / default flag;
- payment request metadata;
- timestamps required for product state.

Forbidden:

- mnemonic / seed;
- private key / WIF / xprv;
- transaction signing material;
- server-side wallet state that can control funds.

## Debugging

`/mini?debug=1` may expose non-secret Telegram environment diagnostics such as:

- whether Telegram WebApp context exists;
- initData length;
- verified/unsafe user id for debugging display;
- platform identifier.

Never log or display recovery material.

## Migration status and compatibility boundary

M6a-M6f are production accepted.

Retired Wallet paths include balance/UTXO/history proxies, raw-tx compatibility, direct Wallet broadcast aliases, fee estimation, direct RPC readiness, and legacy chain env dependencies.

Rules:

- no new feature may adopt a retired Wallet chain path;
- Bot chain reads use PEPEW Light API;
- Mini App/Web Wallet chain reads and signed broadcast use PEPEW Light API;
- wallet-api remains limited to Telegram/product control-plane responsibilities;
- `pepew-api :9193` is a separate legacy service, not a Wallet dependency.

## Production acceptance

The accepted production boundary requires:

- blocking Wallet Suite access to local pepepowd RPC does not break Bot balance/history;
- Mini App balance/history/UTXO/tx lookup continue through PEPEW Light API;
- a correctly signed transaction can be broadcast through PEPEW Light API;
- Telegram identity and payment-request functions continue through wallet-api;
- no secret material appears in backend DB, logs, requests, or responses.
