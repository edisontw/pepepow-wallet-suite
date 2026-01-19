# Architecture: PEPEPOW Wallet Suite

The **PEPEPOW Wallet Suite** is a modular, non-custodial wallet system designed for **Web**, **Telegram Mini App**, and **Telegram Bot** usage.

The architecture strictly enforces **key sovereignty**, **minimal trust**, and **clear security boundaries** by separating blockchain read access, wallet coordination, and client-side key management.

---

## Core Principles (Non-Negotiable)

- **Mnemonic phrases and private keys exist only on the client**
- The backend:
  - never stores mnemonics
  - never stores private keys
  - never signs transactions
- All transactions are **constructed and signed locally**
- The backend only performs:
  - blockchain reads
  - fee estimation
  - raw transaction broadcasting
  - minimal public user bindings and caches

---

## System Components

The system is composed of four primary components:

---

### 1. Web Wallet / Telegram Mini App (Client)

**Role:**  
Non-custodial wallet frontend (single shared codebase).

**Tech Stack:**
- React
- Vite
- Custom PEPEPOW wallet core (BIP-39 / BIP-44 derivation)

**Responsibilities:**
- Mnemonic generation and import
- HD address derivation (BIP-44, coin type 5)
- UTXO selection
- Transaction construction
- **Local transaction signing**
- UI / UX rendering

**Security Model:**
- Private keys and mnemonics exist **only** in:
  - browser memory
  - localStorage (encrypted)
  - optional Telegram Cloud Storage
- No secret material is ever sent to the backend

---

### 2. Wallet API (`wallet-api`, :9194)

**Role:**  
Authenticated wallet backend coordinator (control plane).  
**This is not a wallet and not a custodian.**

**Tech Stack:**
- Node.js (Express / Fastify)
- JWT
- SQLite / PostgreSQL (minimal state)

**Responsibilities:**
- Verify Telegram WebApp `initData`
- Issue short-lived JWTs
- Provide wallet-specific backend services:
  - fee estimation
  - raw transaction broadcasting
  - transaction / request caching
  - Telegram user ↔ address binding
  - payment request / claim flows

**Typical Endpoints (examples):**
- `POST /v1/profile/upsert`
- `GET  /v1/resolve`
- `POST /v1/requests`
- `POST /v1/requests/:id/claim`
- `GET  /v1/requests/:id`
- `POST /v1/broadcast`

**Security Model:**
- Authenticated (Telegram identity)
- Authorized (JWT)
- Stateful only for **public or cache data**
- **Never stores private keys or mnemonics**
- **Never signs transactions**

---

### 3. PEPEW API (`pepew-api`, :9193)

**Role:**  
Public, read-only blockchain data service (indexer / query layer).

**Tech Stack:**
- Node.js (Fastify)
- Connected to `pepepowd` via RPC / ZMQ / indexes

**Responsibilities:**
- Provide efficient read access to blockchain data:
  - chain height
  - address balance
  - UTXOs
  - transaction history
  - block / tx queries
- Serve multiple consumers:
  - Web Wallet
  - Telegram Mini App
  - Explorer
  - third-party services

**Security Model:**
- No user identity
- No JWT
- No database of users
- **Read-only access**
- No blockchain write capability

> Even if scanned or DoS-attacked, impact is limited to data queries only.

---

### 4. PEPEPOWD (Core Node)

**Role:**  
Canonical source of truth for the PEPEPOW blockchain.

**Responsibilities:**
- Block validation
- Transaction validation
- Mempool management
- JSON-RPC interface
- ZMQ event streaming

---

## Why `wallet-api` and `pepew-api` Are Separate

This separation is **intentional and required**, not historical.

### 1. Security Boundary Enforcement

- `pepew-api`: public, read-only, large attack surface, low risk
- `wallet-api`: authenticated, write-capable (broadcast), high sensitivity

Mixing them would:
- expand the attack surface
- complicate rate limiting and WAF rules
- risk wallet availability under external traffic

---

### 2. Clean Domain Separation

- `pepew-api` = **blockchain domain API**
- `wallet-api` = **wallet product domain API**

Keeping them separate:
- avoids endpoint contamination
- simplifies debugging
- keeps blockchain infrastructure reusable
- allows wallet features to evolve independently

---

### 3. Scalability and Reuse

With separation:
- `pepew-api` can serve explorers, wallets, and third-party apps
- `wallet-api` evolves for product needs:
  - Telegram tipping
  - request / claim flows
  - anti-abuse logic
  - caching and session policies

---

## Data Flow (Simplified)

```mermaid
graph TD
    User([User]) <--> WebApp[Web Wallet / Mini App]

    WebApp -- "1. Balance / UTXO / Fee" --> WalletAPI[wallet-api :9194]
    WalletAPI -- "2. Read Proxy" --> PepewAPI[pepew-api :9193]
    PepewAPI -- "3. Query Index" --> Node[(PEPEPOWD)]

    WebApp -- "4. Build & Sign Tx (Local)" --> WebApp

    WebApp -- "5. Broadcast rawTx" --> WalletAPI
    WalletAPI -- "6. sendrawtransaction" --> Node
````

---

## Backend Data Storage Policy

**Forbidden:**

* private keys
* mnemonic phrases
* signing material
* any data that can reconstruct keys

**Allowed (minimal):**

* Telegram user metadata
* user ↔ address bindings (public)
* transaction / request caches

---

## Deployment Model

* `pepew-api` → `127.0.0.1:9193`
* `wallet-api` → `127.0.0.1:9194`
* `nginx` → public HTTPS entry point

**Design Choice:**

* No Docker by default
* Direct Linux deployment
* Local loopback or UNIX socket communication
* Reduced overhead and simpler observability

---

## Non-Custodial Guarantee

The non-custodial nature of PEPEPOW Wallet Suite is guaranteed by design:

* Keys never leave the client
* Transactions are signed client-side
* Backend only accepts **already-signed raw transactions**
* Backend cannot control or reconstruct user funds