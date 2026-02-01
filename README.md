# PEPEPOW (PEPEW) Wallet Suite

A comprehensive, non-custodial wallet ecosystem for the PEPEPOW (PEPEW) blockchain. 

## Features

- **Web Wallet**: Modern, responsive React/Vite-based web interface.
- **Telegram Mini App**: Integrated wallet experience for Telegram users.
- **Wallet API**: Backend service for fee estimation, transaction broadcasting, and user UX helpers.
- **PEPEW API**: Indexer and chain data proxy for fast, read-only chain queries.
- **Trading Bot Suite**: A powerful collection of services for automated trading (DCA, GRID, Market Making) on centralized exchanges.

## ⚠️ Critical Security Warning: Non-Custodial

This project is **non-custodial**. Mnemonics and private keys are **NEVER** sent to or stored on the server. They remain exclusively in the client's browser or Telegram environment.

> [!WARNING]
> **PHISHING ATTACK WARNING**: If you enter your mnemonic on a non-official website, your funds will be lost immediately. Always verify the domain name (`wallet.pepepow.org` or `wallet.pepepow.net`) and ensure you are using the official release.

## Architecture

This project follows a client-side signing model:

```text
[ Client (Web/Mini App) ] --(Auth/UX)--> [ Wallet API ]
           |                                  |
    (Sign Transaction)                (Broadcast Raw Tx)
           |                                  |
           v                                  v
[   Local Browser    ]                [  pepepowd RPC   ]
                                              |
[     PEPEW API      ] <--(Indexed Data)-- [ Blockchain ]
```

1. **Client**: Generates mnemonics and signs transactions locally.
2. **Wallet API**: Provides business logic, fee estimation, and broadcasts signed raw transactions.
3. **PEPEW API**: High-performance indexer for checking balances, UTXOs, and history.

## Repository Structure

- `apps/web`: React-based web wallet.
- `services/wallet-api`: Node.js backend for the wallet.
- `packages/wallet-core`: Shared logic for coin operations (BIP39/32/44).
- `pepew-api`: Chain indexer service.
- `services/trade-api`: Backend for automated trading strategies.
- `services/trade-bot`: Telegram bot for managing trading strategies.
- `docs/`: Technical documentation and runbooks.
- `scripts/`: Deployment and maintenance scripts.

## Getting Started

### Prerequisites

- Node.js 20 LTS
- `pepepowd` node with `txindex=1` and `addressindex=1` (requires `-reindex` if newly enabled).
- PostgreSQL (optional, used for UX cache and Telegram identity).

### Installation

```bash
# Install dependencies for the workspace
npm install

# Build all packages
npm run build
```

### Configuration

Copy `.env.example` to `.env` and fill in the required values. See [Environment Rules](docs/ENV_RULES.md) for details.

```bash
cp .env.example .env
```

## Documentation

- [Architecture Overview](docs/architecture.md)
- [Security Statement](docs/security.md)
- [Deployment Layout](docs/deploy_layout.md)
- [API Reference](docs/pepew-api.md)
- [Trading Suite Architecture](docs/TRADE_ARCHITECTURE.md)
- [Trading Strategy Specifications](docs/TRADE_STRATEGIES_SPEC.md)
- [Trade API Documentation](docs/trade-api.md)
- [Trade Bot Documentation](docs/trade-bot.md)
- [Trading Quick Start Guide](docs/TRADE_USER_QUICK_START.md)
- [Nginx Hardening](docs/nginx-hardening-minimal.md)
- [Publishing to GitHub](docs/publishing-to-github.md)

## Development

See [DEV_COMPASS.md](docs/DEV_COMPASS.md) for a guide to the codebase and internal dependencies.