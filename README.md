# PEPEPOW (PEPEW) Wallet Suite

Non-custodial PEPEPOW wallet and Telegram integration, plus an isolated centralized-exchange Trade subsystem.

## Security model

The Wallet subsystem is non-custodial.

- Mnemonics and private keys stay on the client.
- Address derivation, transaction construction, and signing are client-side.
- Backend services never store wallet secrets and never sign for users.
- Only public wallet data and already-signed raw transactions may cross the chain API boundary.

Trade is a separate security domain and must not access wallet keys, wallet signing, or wallet chain RPC.

## Wallet architecture direction

The approved target architecture uses the existing PEPEW Light API / ElectrumX stack for Wallet blockchain access:

```text
Telegram Bot
   |-- wallet-api :9194 -> Telegram identity / address binding / payment requests
   '-- PEPEW Light API -> balance / history

Telegram Mini App / Web Wallet
   |-- wallet-core -> derive / select / build / sign locally
   |-- wallet-api :9194 -> Telegram product/control-plane features
   '-- PEPEW Light API -> address / history / UTXO / tx / signed rawTx broadcast
                              |
                              v
                    pepepow-electrumx-service
                              |
                           ElectrumX
                              |
                           pepepowd
```

Migration is staged. Current production code still contains legacy `wallet-api -> pepew-api` proxies and direct core-RPC paths until the relevant milestones are completed.

See:

- [Architecture](docs/architecture.md)
- [Light API Migration Roadmap](docs/LIGHT_API_MIGRATION.md)
- [Development Compass](docs/DEV_COMPASS.md)

## Repository structure

- `apps/web`: React/Vite Web Wallet and Telegram Mini App.
- `services/wallet-api`: Telegram/product control plane; currently also contains transitional legacy chain routes.
- `packages/wallet-core`: client-side PEPEPOW wallet primitives.
- `pepew-api`: legacy/public chain API that may continue serving non-Wallet consumers; no new Telegram Wallet chain dependency should be added.
- `services/trade-api`: centralized-exchange strategy backend.
- `services/trade-bot`: Telegram control surface for Trade.
- `docs`: architecture, migration, security, deployment, and runbooks.

## Development

Requirements:

- Node.js 20 LTS or newer
- npm

Install and build:

```bash
npm install
npm run build
```

Environment rules:

```text
docs/ENV_RULES.md
```

The current production deployment may still require local pepepowd/pepew-api dependencies while the Light API migration is incomplete. Do not remove a runtime dependency until its migration milestone passes acceptance.

## Documentation

Start with:

1. [Development Compass](docs/DEV_COMPASS.md)
2. [Light API Migration Roadmap](docs/LIGHT_API_MIGRATION.md)
3. [Architecture](docs/architecture.md)
4. [Telegram Architecture](docs/telegram-architecture.md)
5. [Security](docs/security.md)
6. [Current wallet-api endpoints](docs/wallet-api.md)
7. [Runtime](docs/runtime.md)

Trade references:

- [Trade Architecture](docs/TRADE_ARCHITECTURE.md)
- [Trade Strategy Specifications](docs/TRADE_STRATEGIES_SPEC.md)
- [Trade API](docs/trade-api.md)
- [Trade Bot](docs/trade-bot.md)

## Migration rule

Do not perform a big-bang replacement. Migrate one coherent layer at a time, preserve rollback, verify old/new response parity, and keep signing strictly client-side.
