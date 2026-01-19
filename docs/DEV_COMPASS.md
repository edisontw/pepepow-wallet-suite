Here’s a clean, professional **English version**, keeping the original structure and intent intact:

---

## 1️⃣ Core Design Principles (Non-negotiable)

### 🔐 Non-custodial (**Highest Priority**)

* Mnemonic phrases / private keys **exist only on the client side**
* Mini App storage:

  * `localStorage`
  * Optional: Telegram Cloud Storage
* **Backend is strictly forbidden** from:

  * Storing mnemonics
  * Storing private keys
  * Signing transactions on behalf of users

👉 **Backend responsibilities only**:

* Read blockchain data
* Estimate transaction fees
* Broadcast signed `rawTx`

---

## 2️⃣ User Experience Overview (Product Level)

### Supported Features (**MVP – must have**)

* Create / import wallet (12 / 24-word mnemonic)
* Display balance
* Receive address + QR code
* Send transactions
* Fee estimation
* Transaction history

### Interface Forms

* **Telegram Bot** (command-driven)
* **Telegram Mini App** (full visual wallet UI)
* The **same frontend codebase** also serves the Web Wallet

---

## 3️⃣ Overall System Architecture (Logical View)

```
Telegram Bot (grammY / Telegraf)
        │
        ├── /start /balance /deposit /send /history
        │
Telegram Mini App (React + Telegram WebApp SDK)
        │
        ├── Wallet Core (bip39 / UTXO / signing)
        │
Backend Wallet API (Node.js :9194)
        │
        ├── Verify Telegram initData → JWT
        ├── Call pepew-api (read-only blockchain access)
        └── Call pepepowd RPC (transaction broadcast)
        │
pepew-api :9193  ←→  pepepowd (RPC + ZMQ)
```

---

## 4️⃣ Components & Responsibility Split (Critical to Avoid Scope Drift)

### A. Telegram Bot (Lightweight, Traffic Entry)

* **No wallet logic**
* Used only for navigation and quick access

Commands:

* `/start` → bind account + open Mini App
* `/balance` → query balance + quick actions
* `/deposit` → address + QR code
* `/send` → redirect to Mini App
* `/history` → latest 10 transactions (cached)

---

### B. Mini App (The Wallet Itself)

* **The single source of all wallet logic**

#### Page Structure

* Initialization
* Create / import mnemonic
* Home

  * Address, balance, QR code
* Send

  * Destination address
  * Amount
  * Fee estimation
  * Automatic UTXO selection
  * Local signing
  * Broadcast
* History

  * Transaction list → `txid`

#### Future Extensions (Non-MVP)

* PoS / Masternodes
* Telegram tipping
* QR-based payments

---

### C. Backend Wallet API (Strictly Limited)

* **Must not evolve into a second wallet**
* Verify Telegram WebApp `initData`
* Issue short-lived JWTs (e.g. 30 minutes)

Provides:

* `balance`
* `utxos`
* `estimate fee`
* `broadcast rawTx`
* cached `history`

---

## 5️⃣ Blockchain Access Rules (Finalized)

| Type         | Source                                     |
| ------------ | ------------------------------------------ |
| Read chain   | `https://api.pepepow.net/v1/...`           |
| Broadcast    | `pepepowd` JSON-RPC (`sendrawtransaction`) |
| Block height | `pepew-api` / ZMQ                          |
| Fee rate     | `estimatesmartfee` → fallback              |

👉 **Direct RPC access from the Mini App is NOT allowed**

---

## 6️⃣ Technology Stack (Minor Adjustments Acceptable)

### Stable Choices

* Bot: Node.js + grammY
* Mini App: Vite + React + TypeScript + `@twa-dev/sdk`
* Backend: Node.js + Express / Fastify
* Validation: JWT + Zod
* Database: PostgreSQL (SQLite acceptable for MVP)

### Wallet Core

* `bip39`, `bip32`
* `bitcoinjs-lib` variant (customized for PEPEPOW address prefix)

### Deployment

* `systemd` (Docker is not the primary approach)
* Nginx + Let’s Encrypt

---

## 7️⃣ Database Role (Public Data & Cache Only)

### ❌ Must NOT Store

* Private keys
* Mnemonics
* Signature data

### ✅ Allowed to Store

* Telegram user basic profile
* Bound public addresses
* Cached transaction history

Schema design ✔ already reasonable
👉 No major changes required at this stage

---

## 8️⃣ Runtime & DevOps (Already Solid)

### Services & Ports

* `pepew-api` → `:9193`
* `wallet-api + bot` → `:9194`
* `nginx` → public entry

### Required Health Checks

* `/healthz`
* `/readyz` (returns `503` + error reason)

### Confirmed as a **Good Design**

* `systemd` units
* Separated env files
* Optional Redis / ZMQ
* Well-documented common failure scenarios

👉 This section does **not** need rewriting — **reference only**

---

If you want, I can next:

* Turn this into **ARCHITECTURE.md**
* Convert it into a **developer onboarding doc**
* Or rewrite it as a **“rules for contributors”** spec
