# Architecture: PEPEPOW Wallet Suite

> Status: **current production Wallet architecture**.
>
> The PEPEW Light migration M0-M6 is complete and production accepted. Wallet API is the Telegram/product control plane; PEPEW Light API is the Wallet blockchain data plane. The separate `pepew-api :9193` service is legacy infrastructure for other consumers only.

## Core principles

The Wallet Suite is non-custodial.

- Mnemonic phrases and private keys stay on the client.
- Transaction construction and signing happen on the client.
- Backend services never derive keys or sign transactions.
- Only public addresses, txids, read options, product metadata, and already-signed raw transactions may cross the wallet API boundary.
- Telegram identity/product functions and blockchain chain-access functions are separate domains.

## Current production architecture

```mermaid
graph TD
    User([User]) <--> Client[Web Wallet / Telegram Mini App]
    TG([Telegram Bot]) --> Control[wallet-api :9194]

    Client -- "Telegram auth / bindings / requests" --> Control
    Client -- "address / history / UTXO / tx / signed rawTx" --> Light[PEPEW Light API]
    TG -- "default public address" --> Control
    TG -- "balance / history" --> Light

    Light --> EX[ElectrumX]
    EX --> Node[(pepepowd)]

    Client -- "Build + sign locally" --> Client
```

### Security boundary

```text
CLIENT SECRET DOMAIN
- mnemonic
- private keys
- WIF / seed / xprv
- transaction signing

PUBLIC/CONTROL DATA
- Telegram identity
- public wallet address
- payment-request metadata

CHAIN DATA PLANE
- PEPEW Light API
- ElectrumX
- pepepowd
```

ElectrumX and pepepowd must not be exposed directly to browser clients.

## Components

### Web Wallet / Telegram Mini App

Single non-custodial wallet client.

Responsibilities:

- create/import mnemonic;
- derive PEPEPOW addresses;
- UTXO selection;
- fetch previous transaction material needed to construct P2PKH spends;
- construct and sign transactions locally;
- submit signed raw transaction only;
- balance/history/receive/send UI;
- stale-UTXO and recent-spent reconciliation.

The Light Wallet repository remains a supported standalone/backup wallet and a reference implementation for Light API integration and send resilience.

### Public Wallet roles

The two public wallet surfaces intentionally coexist:

| Surface | Role |
| --- | --- |
| `https://wallet.pepepow.net` | Integrated Wallet: Web Wallet, Telegram Mini App/Bot UX, PepewPay/payment handoff, and future platform integrations |
| `https://light.pepepow.net/wallet/` | Standalone PEPEW Light Wallet and backup wallet interface |

Both are non-custodial clients and both use PEPEW Light API for chain access. They are separate browser origins; mnemonic/private-key material must never be copied between them by a backend migration service.

Payment and messaging integrations should use `wallet.pepepow.net` as the primary payer handoff. The standalone Light Wallet remains supported and does not need Telegram identity or Payment Platform control-plane features.

Core transaction rules that affect interoperability should remain compatible across both wallets, including 8-decimal amount parsing, dust handling, signed-only broadcast, and safe uncertain-broadcast reconciliation.

### wallet-core

Client-side wallet primitives only.

Canonical PEPEPOW parameters:

```text
P2PKH  0x37
P2SH   0x10
WIF    0xCC
HD     m/44'/5'/0'/0/x
PEPEW  8 decimal places
```

### wallet-api :9194

Role: authenticated **control plane** for Telegram/product features.

Responsibilities:

- verify Telegram WebApp `initData`;
- issue short-lived JWTs;
- Telegram user/profile metadata;
- default public address binding;
- username / user-id resolution;
- payment request and claim flows;
- Telegram bot webhook;
- other product-specific state that does not require wallet secrets.

wallet-api does **not**:

- index chain data;
- proxy balance/UTXO/history;
- look up raw transactions for wallet signing;
- broadcast by direct pepepowd RPC;
- hold a raw-tx hot cache;
- sign transactions.

### PEPEW Light API

Implemented by `edisontw/pepepow-electrumx-service`.

Approved wallet chain contract:

```text
GET  /api/wallet/address/{address}
GET  /api/wallet/history/{address}
GET  /api/wallet/utxo/{address}
GET  /api/wallet/tx/{txid}
POST /api/wallet/broadcast
```

Responsibilities:

- validate public wallet query inputs;
- provide ElectrumX-backed balance/history/UTXO/tx data;
- accept only an already-signed raw transaction for broadcast;
- enforce safe errors, request-size limits, and rate limits.

It must not receive or process mnemonic/private-key/signing requests.

### ElectrumX

Private indexed chain interface used by PEPEW Light API.

### pepepowd

Canonical blockchain authority.

PEPEW Light API / ElectrumX may ultimately communicate with pepepowd, but Wallet Suite product services must not create parallel direct-RPC chain access after migration.

## Telegram data flows

### Mini App authentication

```text
Telegram WebApp initData
 -> wallet-api /auth/telegram
 -> verified Telegram identity
 -> short-lived JWT
```

JWT is for Telegram/product endpoints. Public Light API chain reads do not become custodial or identity-dependent.

### Bot balance/history

```text
Telegram command
 -> wallet-api: resolve user's default public address
 -> PEPEW Light API: address/history query
 -> Bot formats response
```

### Client send

```text
derive sender locally
 -> Light API fresh UTXO
 -> local coin selection
 -> Light API previous tx/raw data if required
 -> local transaction build
 -> local signing
 -> Light API POST /api/wallet/broadcast
 -> refresh/reconcile wallet state
```

## Runtime dependencies and legacy isolation

Wallet API readiness checks only the dependencies it actually uses:

```text
wallet-api -> PEPEW Light API /api/status
wallet-api -> Telegram Bot API getMe
```

Wallet API no longer depends on `pepew-api :9193`, Redis, or direct `pepepowd` RPC. The separate `pepew-api :9193` service may continue serving its own legacy/public consumers, but new Wallet code must not depend on it.

### Fee policy

The Mini App/Web Wallet uses a deterministic client-side P2PKH size policy with a 0.0001 PEPEW minimum and 0.0001 PEPEW/kB rate. Fee calculation is local and does not require Wallet API or direct RPC.

## Repository boundaries

| Repository | Responsibility |
| --- | --- |
| `pepepow-wallet-suite` | Telegram Bot, Mini App/product UX, wallet-api control plane, shared client wallet logic |
| `pepepow-light-wallet` | Supported standalone/backup Light Wallet plus reference Light API/send behavior |
| `pepepow-electrumx-service` | PEPEW Light API gateway, cache, validation, wallet read/broadcast contract |
| `electrumx-pepepow` | PEPEPOW ElectrumX chain support |
| `pepepowd` | Blockchain consensus/node authority |

## Backend storage policy

Forbidden:

- private keys;
- mnemonic / recovery phrase;
- seed / xprv / WIF;
- data capable of reconstructing keys.

Allowed when needed:

- Telegram user metadata;
- bound public addresses;
- labels;
- payment request metadata;
- bounded operational caches.

Avoid long-term identity/address/IP correlation not required for product operation.

## Change discipline

The migration history and acceptance evidence remain in `docs/LIGHT_API_MIGRATION.md`.

For new changes:

1. preserve non-custodial boundaries;
2. keep Wallet chain access on PEPEW Light API;
3. make the smallest coherent change;
4. test invalid address, timeout, 429, upstream failure, stale UTXO, and uncertain broadcast behavior where applicable;
5. verify no mnemonic/private key crosses a network boundary;
6. update docs when runtime behavior changes.

## Production acceptance state

The final architecture was production accepted on 2026-09-29:

- Telegram Bot balance/history use PEPEW Light API;
- Mini App balance/history/UTXO/tx lookup use PEPEW Light API;
- signed transaction broadcast uses PEPEW Light API;
- fee calculation is client-side;
- Wallet API has no direct node RPC dependency;
- Wallet API remains the Telegram/product control plane;
- legacy Wallet chain proxy/raw/broadcast endpoints are retired and fail closed.
