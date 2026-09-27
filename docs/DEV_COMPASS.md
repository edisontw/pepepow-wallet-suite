# PEPEPOW Wallet Suite Development Compass

> Working guide for Wallet + Telegram development. Security rules in this file are non-negotiable.
>
> Migration status: **M1 COMPLETE — the typed PEPEW Light API client adapter exists, but production Wallet read call sites remain on legacy paths until M2.**

## 1. Core design principles

### Non-custodial wallet

- Mnemonic phrases and private keys exist only on the client.
- Mini App / Web Wallet may keep recovery material only in approved client-side storage.
- Backend services must never store mnemonics, private keys, WIF, xprv, seeds, or signing material.
- Transaction construction and signing remain client-side.
- Backend services may receive only public wallet data and already-signed raw transactions.

### Trade isolation

The Trade subsystem is a separate security domain.

- Trade services must not access wallet mnemonics, private keys, wallet signing code, or wallet chain RPC.
- Wallet migration must not modify Trade strategy semantics or exchange credentials.

## 2. Approved target architecture

```text
Telegram Bot
   |-- Telegram UX / commands
   |-- wallet-api :9194 -> Telegram identity / default address / payment requests
   '-- PEPEW Light API -> balance / history

Telegram Mini App / Web Wallet
   |-- wallet-core -> derive / UTXO selection / build / sign locally
   |-- wallet-api :9194 -> Telegram product/control-plane features only
   '-- PEPEW Light API -> address / history / UTXO / tx / signed broadcast
                              |
                              v
                    pepepow-electrumx-service
                              |
                           ElectrumX
                              |
                           pepepowd
```

The PEPEW Light API is the approved Wallet **chain-access data plane**.

Production wallet API contract:

```text
GET  https://light.pepepow.net/api/wallet/address/{address}
GET  https://light.pepepow.net/api/wallet/history/{address}
GET  https://light.pepepow.net/api/wallet/utxo/{address}
GET  https://light.pepepow.net/api/wallet/tx/{txid}
POST https://light.pepepow.net/api/wallet/broadcast
```

Direct browser-to-ElectrumX and direct browser-to-pepepowd access are forbidden.

## 3. Component responsibilities

### Telegram Bot

The bot is an entry point and command surface only.

- `/start`: onboarding / open Mini App.
- `/deposit`: obtain the Telegram user's bound/default public address through wallet-api.
- `/balance`: resolve default address through wallet-api, then query PEPEW Light API.
- `/history`: resolve default address through wallet-api, then query PEPEW Light API.
- `/send`: open the Mini App.

The bot must not contain key derivation, transaction construction, or signing logic.

### Telegram Mini App / Web Wallet

This is the wallet.

Responsibilities:

- create/import mnemonic locally;
- derive addresses with `m/44'/5'/0'/0/x`;
- select UTXOs locally;
- build and sign transactions locally;
- submit only signed raw transaction hex;
- handle recent-spent outpoints and stale-indexer retries;
- display balance, history, receive QR, and send state.

Prefer reusing the proven Light Wallet behavior and API client rather than creating parallel wallet logic.

### wallet-core

Shared client-side wallet primitives:

```text
packages/wallet-core/
  address.ts
  derive.ts
  mnemonic.ts
  network.ts
  txbuilder.ts
```

Do not add backend service behavior here.

PEPEPOW network parameters:

```text
P2PKH version = 0x37
P2SH version  = 0x10
WIF version   = 0xCC
HD path       = m/44'/5'/0'/0/x
display unit  = PEPEW
atomic unit   = 8 decimals
```

### wallet-api :9194

Target role: **Telegram/product control plane**, not blockchain data plane.

Keep:

- Telegram WebApp `initData` verification;
- short-lived JWT;
- Telegram profile;
- default public address binding;
- username/user resolution;
- payment requests / claims;
- Telegram webhook;
- product-specific public metadata.

Do not add new balance indexes, UTXO indexes, raw transaction caches, or new direct node RPC dependencies.

### PEPEW Light API

Repository: `edisontw/pepepow-electrumx-service`.

Authoritative Wallet chain gateway for:

- address summary / balance;
- history / mempool state;
- UTXO lookup;
- transaction lookup / raw previous transaction data;
- signed raw transaction broadcast.

ElectrumX and pepepowd remain private behind the gateway.

## 4. Migration rule: no big-bang rewrite

The existing Wallet Suite still contains legacy `wallet-api -> pepew-api -> pepepowd` and direct RPC code. Remove it incrementally according to:

`docs/LIGHT_API_MIGRATION.md`

Until the relevant milestone is complete:

- do not remove an endpoint still required by production;
- do not create new consumers of a legacy endpoint;
- preserve rollback capability;
- compare the same address/tx against the current and Light API paths before cutover.

## 5. Fee-estimation exception

Fee estimation is the only planned temporary chain/RPC dependency after read migration begins.

Current legacy path may remain temporarily:

```text
GET /wallet/fee/estimate
  -> wallet-api
  -> pepepowd estimatesmartfee / fallback
```

Do not silently replace this with a fixed fee during migration.

M5 must explicitly choose and document either:

1. a PEPEW Light fee-policy endpoint; or
2. a reviewed client-side transaction-size x fee-rate policy.

Only after M5 passes may `CORE_RPC_URL` stop being a Wallet API requirement.

## 6. Light API client rules

Use a dedicated client layer. UI components must not scatter raw Light API URLs.

Required behavior:

- request timeout;
- safe error mapping;
- HTTP 429 backoff;
- bounded retry;
- avoid aggressive `fresh=1`;
- refresh UTXOs immediately before building a send;
- never retry broadcast blindly without reconciling tx/UTXO state.

For a send, use this model:

```text
fresh UTXO
 -> exclude recently spent outpoints
 -> select inputs
 -> fetch previous raw tx as needed
 -> build locally
 -> sign locally
 -> POST signed raw_tx only
 -> record spent outpoints
 -> refresh/reconcile
```

## 7. Database policy

Forbidden:

- mnemonic / seed;
- private key / WIF / xprv;
- signing material;
- persisted raw signed transaction as wallet state.

Allowed when required for product behavior:

- Telegram user id / username;
- public address bindings;
- labels;
- payment-request metadata;
- short-lived operational caches that do not create long-term address/IP identity tracking.

## 8. Runtime / DevOps

Current Wallet Suite ports remain:

- `pepew-api`: `:9193` — legacy Wallet dependency during migration; may continue serving other consumers.
- `wallet-api`: `:9194`.
- `trade-api`: `:9195`.
- PEPEW Light API: public `https://light.pepepow.net/api/*`, backed by private ElectrumX.

Required service checks:

- `/healthz`
- `/readyz`

Nginx, systemd, env separation, and existing production security controls remain in force.

## 9. Definition of migration success

After M6:

- Telegram Mini App chain reads do not depend on `pepew-api :9193`;
- Telegram Bot balance/history do not depend on `wallet-api` chain proxy routes;
- signed broadcast uses PEPEW Light API;
- wallet-api has no Wallet direct pepepowd RPC dependency;
- wallet-api contains no read proxy/raw-tx cache implementation;
- mnemonic/private keys remain client-only;
- Web Wallet and Telegram Wallet use the same chain contract and compatible wallet-core behavior.

A final acceptance test must demonstrate that blocking Wallet Suite access to local pepepowd RPC does not break Telegram balance/history/UTXO/tx lookup or signed send.
