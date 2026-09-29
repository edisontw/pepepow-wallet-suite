# PEPEPOW (PEPEW) Wallet Suite

Non-custodial PEPEPOW wallet, Telegram integration, and an isolated centralized-exchange Trade subsystem.

> **Production status:** PEPEW Light API migration M6 is complete. M6a-M6f were production accepted on 2026-09-29.

## Security model

The Wallet subsystem is non-custodial.

- Mnemonics, seeds, WIFs, xprvs, and private keys stay client-side only.
- Address derivation, UTXO selection, transaction construction, and signing are client-side.
- Wallet backend services never store recovery material and never sign blockchain transactions.
- Only public wallet data, product metadata, and an already-signed raw transaction may cross the network boundary.
- Trade is a separate security domain. Trade may use CEX API keys, but must never access wallet keys, wallet-core signing, or pepepowd RPC.

## Current Wallet architecture

```text
Telegram Bot
  ├─ wallet-api :9194
  │    └─ Telegram identity / default address / payment metadata
  └─ PEPEW Light API
       └─ balance / history

Telegram Mini App / Web Wallet
  ├─ wallet-core → derive / select / build / sign locally
  ├─ wallet-api :9194 → Telegram/product control plane
  └─ PEPEW Light API
       └─ address / history / UTXO / tx / signed raw-tx broadcast
              │
              v
     pepepow-electrumx-service
              │
           ElectrumX
              │
           pepepowd
```

Wallet API no longer depends on `pepew-api :9193` or direct `pepepowd` RPC for Wallet chain reads, raw transaction lookup, broadcast, fee calculation, or readiness.

The separate `pepew-api :9193` service may remain for other legacy consumers. Do not add new Wallet dependencies on it.

## PEPEW Light API contract

Base URL:

```text
https://light.pepepow.net
```

Wallet endpoints:

```text
GET  /api/wallet/address/{address}
GET  /api/wallet/history/{address}
GET  /api/wallet/utxo/{address}
GET  /api/wallet/tx/{txid}
POST /api/wallet/broadcast
```

Broadcast accepts an already-signed transaction only:

```json
{"raw_tx":"<signed hex>"}
```

Do not blindly retry an uncertain broadcast POST.

## Repository structure

- `apps/web` — React/Vite Web Wallet and Telegram Mini App.
- `packages/wallet-core` — client-side PEPEW derivation, transaction construction, signing, and fee helpers.
- `services/wallet-api` — Telegram/product control plane on `:9194`.
- `pepew-api/pepew-api` — separate legacy/public chain API on `:9193`; not part of the Wallet target dependency graph.
- `services/trade-api` — isolated CEX strategy backend.
- `services/trade-bot` — Telegram control surface for Trade.
- `docs` — architecture, security, migration history, deployment, and operator runbooks.

## Wallet development

Requirements:

- Node.js 20 LTS or newer
- npm

Install/build the Wallet components:

```bash
npm --prefix packages/wallet-core ci
npm --prefix services/wallet-api ci
npm --prefix apps/web ci

npm --prefix packages/wallet-core run build
npm --prefix services/wallet-api run build
npm --prefix apps/web run build
```

Key Wallet boundary tests:

```bash
npm --prefix services/wallet-api run test:m6f-final-isolation
npm --prefix apps/web run test:m2-light-reads
npm --prefix apps/web run test:m4-light-broadcast
npm --prefix apps/web run test:m5-client-fee
```

## Production conventions

GitHub `main` is the development source of truth.

Current Wallet production conventions:

```text
Repository:      /home/ubuntu/pepepow-wallet-suite
Wallet API:      :9194
Environment:     /etc/pepepow/pepepow-wallet-api.env
Web root:        /var/www/pepepow-wallet/
Light API:       https://light.pepepow.net
```

Before production changes, inspect the actual systemd and Nginx runtime. Do not assume the historical `/opt/.../current` release/symlink deployment is active.

See [Runtime Runbook](docs/runtime.md) and [Deployment Layout](docs/deploy_layout.md).

## Documentation

Start here:

1. [Development Compass](docs/DEV_COMPASS.md) — engineering guardrails and current status.
2. [Architecture](docs/architecture.md) — current Wallet/Telegram architecture.
3. [Telegram Architecture](docs/telegram-architecture.md) — Bot and Mini App flows.
4. [wallet-api](docs/wallet-api.md) — current control-plane endpoints.
5. [Environment Rules](docs/ENV_RULES.md) — runtime/build-time variables and secrets policy.
6. [Runtime Runbook](docs/runtime.md) — production checks and troubleshooting.
7. [PEPEW Light API Migration](docs/LIGHT_API_MIGRATION.md) — completed M0-M6 migration history and acceptance evidence.
8. [Security](docs/security.md) — non-custodial guarantees.

Trade references:

- [Trade Architecture](docs/TRADE_ARCHITECTURE.md)
- [Trade Strategy Specifications](docs/TRADE_STRATEGIES_SPEC.md)
- [Trade API](docs/trade-api.md)
- [Trade Bot](docs/trade-bot.md)

## Architecture guardrails

- Never move mnemonic/private-key handling or signing into the backend.
- Do not add Wallet chain dependencies on retired Wallet API proxies or direct node RPC.
- New Wallet chain access goes through PEPEW Light API.
- Keep Trade isolated from wallet-core, wallet secrets, and pepepowd RPC.
- Preserve integer atomic units internally: `1 PEPEW = 100000000 atomic`.
- PEPEW HD path: `m/44'/5'/0'/0/x`.
