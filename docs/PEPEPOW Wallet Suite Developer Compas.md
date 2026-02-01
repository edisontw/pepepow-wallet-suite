# ✅ PEPEPOW Wallet Suite Developer Compass（含 Trade 系統）

> **此文件為最高層設計約束（憲法）**
> 所有 agent prompt、實作、debug、重構都必須回頭對齊這裡。
> 若程式碼與此文件衝突，**先修正程式碼**（或更新此文件並明確記錄原因）。

---

## 1️⃣ 核心設計原則（不可破壞）

### 🔐 Non-custodial（錢包系統最高優先）

* **助記詞 / 私鑰只存在使用者端**

  * Mini App：`localStorage` +（可選）Telegram Cloud Storage
* **後端嚴禁**

  * 不存助記詞
  * 不存私鑰
  * 不代簽交易

👉 **Wallet 後端只做：讀鏈、費率估算、送 rawTx**

---

### 🤖 Trade 系統補充原則（Exchange-based Automation）

> Trade 系統**不屬於** Non-custodial 錢包安全模型，而是「交易所 API 自動化」。
> 必須與 Wallet 系統 **隔離安全邊界**，僅可共 repo，不可共密鑰/簽名/鏈上權限。

* Trade API / Trade Bot 使用的是：

  * **中心化交易所 API Key**（NonKYC / Dex-Trade / NestEx等）
* Trade 系統不得：

  * 接觸 wallet 助記詞 / 私鑰
  * 代替使用者簽署鏈上交易
  * 影響或依賴 wallet-api 的安全模型
* Trade 系統只做：

  * 行情讀取、下單/撤單、自動化策略執行、狀態顯示

---

## 2️⃣ 使用者體驗總覽（產品層）

### Wallet MVP（必須）

* 建立 / 匯入錢包（12 / 24 助記詞）
* 顯示餘額
* 收款地址 + QR Code
* 發送交易
* 手續費估算
* 交易紀錄

### 介面形態（Wallet）

* Telegram Bot（指令導向）
* Telegram Mini App（完整視覺化錢包）
* 同一套前端也服務 Web Wallet

### Trade（策略交易控制面板）

* Telegram Trade Bot（指令導向）

  * 建立/啟停策略（DCA / MM / GRID…）
  * 顯示策略狀態、最近動作、錯誤原因
* 策略執行核心在 Trade API（非 bot）

---

## 3️⃣ 系統整體架構（邏輯版）

### A) Wallet 系統（Non-custodial）

```
Telegram Bot (grammY / Telegraf)
        │
        ├── /start /balance /deposit /send /history
        │
Telegram Mini App (React + Telegram WebApp SDK)
        │
        ├── Wallet Core（bip39 / UTXO / sign）
        │
Backend Wallet API (Node.js :9194)
        │
        ├── 驗證 Telegram initData → JWT
        ├── 呼叫 pepew-api（讀鏈）
        └── 呼叫 pepepowd RPC（送交易）
        │
pepew-api :9193  ←→  pepepowd (RPC + ZMQ)
```

### B) Trade 系統（Exchange-based Automation，平行隔離）

```
Telegram Trade Bot (grammY)
        │
        ├── /dca /grid /mm /strategy_status ...
        │
Trade API (Node.js :9195)
        │
        ├── Strategy Runner / Scheduler
        ├── Exchange Adapter（NonKYC / Dex-Trade）
        ├── Risk & Limit Guards
        └── SQLite trade.db（state only）
        │
Centralized Exchanges
(NonKYC / Dex-Trade ...)
```

📌 關鍵限制（必須記住）

* Wallet 系統：讀鏈 / 估費 / 廣播 rawTx（不碰交易所）
* Trade 系統：交易所下單 / 撤單 / 策略排程（不碰鏈上私鑰、不廣播 rawTx）

---

## 4️⃣ 元件與責任切分（防迷失關鍵）

### A. Telegram Bot（Wallet，輕、導流）

**只負責導引，不做錢包邏輯**

* `/start` → 綁定帳號 + 開 Mini App
* `/balance` → 查詢 + 快速按鈕
* `/deposit` → 地址 + QR
* `/send` → 導向 Mini App
* `/history` → 近 10 筆（快取）

---

### B. Mini App（Wallet 本體）

**錢包邏輯唯一所在地**

頁面結構：

1. 初始化

   * 建立 / 匯入助記詞
2. 首頁

   * 地址、餘額、QR
3. 發送

   * 地址、金額、手續費估算、UTXO 自動揀選、本地簽名、廣播
4. 紀錄

   * tx list → txid

> 之後擴充（非 MVP）
> PoS / MN、Telegram tip、掃碼支付

---

### C. Backend Wallet API（嚴格受限）

**定位明確：不變成第二個錢包**

* 驗證 Telegram WebApp `initData`
* 發 JWT（短效，例 30 分鐘）
* 提供：

  * balance
  * utxos
  * estimate fee
  * broadcast rawTx
  * history cache

---

### D. Trade API（策略執行核心）

**定位：策略引擎，不是 UI，也不是 Bot**

* 負責：

  * 策略建立/更新/啟停
  * 排程（tick、refresh、runner）
  * 下單/撤單（透過 exchange adapter）
  * 狀態查詢（供 trade-bot 顯示）
  * 風險控制（預算、運行時間、區間外停止、min notional 等）
* 資料庫（SQLite）只存：

  * 策略設定（非敏感）
  * 策略執行狀態（state machine）
  * 必要的訂單參考資訊（order id / timestamps / last action）
* 不應存：

  * 錢包助記詞/私鑰/簽名
  * 鏈上地址與 UTXO
  * 交易所 API 明文（如有加密，僅保存加密結果與必要 metadata）

---

### E. Telegram Trade Bot（策略控制面板）

**定位：Control Plane（薄層），不做策略決策**

* 負責：

  * 指令解析、參數輸入流程
  * 呼叫 Trade API
  * 顯示策略狀態、錯誤、最近動作
* 不負責：

  * 策略邏輯與計算
  * 價格抓取與下單決策
  * 排程與生命週期

---

## 5️⃣ 區塊鏈存取規則（Wallet 已定）

| 類型  | 來源                                         |
| --- | ------------------------------------------ |
| 讀鏈  | `https://api.pepepow.net/v1/...`           |
| 送交易 | `pepepowd` JSON-RPC (`sendrawtransaction`) |
| 高度  | pepew-api / ZMQ                            |
| 費率  | `estimatesmartfee` → fallback              |

👉 **不允許直接從 Mini App 打 RPC**
👉 Trade 系統不參與鏈上 RPC（只做交易所）

---

## 6️⃣ 技術選型（可接受微調）

### Wallet（已穩定）

* Bot：Node.js + grammY
* Mini App：Vite + React + TS + `@twa-dev/sdk`
* Backend：Node.js + Express / Fastify
* 驗證：JWT + Zod
* DB：PostgreSQL（MVP 可 SQLite）
* 錢包核心：`bip39`, `bip32`, `bitcoinjs-lib` 變體
* 部署：systemd（非 Docker 為主）、Nginx + Let’s Encrypt

### Trade（目前實作方向）

* trade-bot：Node.js + grammY（指令導向）
* trade-api：Node.js + Express（或同級框架）
* DB：SQLite（trade.db，狀態/快取用途）
* Exchange：NonKYC / Dex-Trade（以 adapter 層隔離）

---

## 7️⃣ 資料庫角色（只存「必要狀態與快取」）

### Wallet DB（公開與快取）

❌ 不存：私鑰、助記詞、簽名資料
✅ 存：Telegram user 基本資料、綁定地址（公開）、交易快取（history）

### Trade DB（策略狀態）

❌ 不存：錢包私鑰/助記詞/簽名、交易所 API 明文
✅ 存：策略設定、策略狀態、訂單 reference、必要的執行記錄（避免爆量 log）

---

## 8️⃣ Runtime & DevOps（引用既有規範）

### 服務與 Port（現況）

* pepew-api → `:9193`
* wallet-api（含 wallet bot）→ `:9194`
* trade-api → `:9195`
* nginx → public

### 必備健康檢查

* `/healthz`
* `/readyz`（503 + error reason）

### 已確認是好設計

* systemd units
* env file 分離（`/etc/pepepow/*.env`）
* Redis / ZMQ optional
* 詳細 common failure 列表

---

## 9️⃣ Nginx / SSL（定版）

* HTTP → HTTPS
* HSTS
* `/healthz` `/readyz` passthrough
* certbot webroot

👉 不建議引入 Traefik / Caddy

---

## 🔟 文件策略（docs/）

* 原有 docs 原則上不動
* 若行為或介面有變更，必須在上傳 GitHub 前：

  * 補齊或新增對應文件（尤其 trade-api / trade-bot）
  * 更新本 DEV_COMPASS 的架構圖與責任切分（保持一致）

---

## 1️⃣1️⃣ 重要規則與環境備忘

### 錢包 HD 路徑

PEPEPOW wallets use BIP-39 for mnemonic generation and BIP-44 HD derivation with SLIP-0044 coin type 5:
`m/44'/5'/0'/0/x`

### env 關係圖（現況）

* wallet-api (9194) → `/etc/pepepow/pepepow-wallet-api.env`
* pepew-api (9193) → `/etc/pepepow/pepew-api.env`
* trade-api (9195) → `/etc/pepepow/pepepow-trade-api.env`（若存在）
* 專案 build/dev → `/home/ubuntu/pepepow-wallet-suite/.env`

### UI 單位規則

UI 顯示與輸入使用 PEPEW coin（例：1.2345）
內部計算再轉最小單位（integer）

### Web root（嚴格）

前端 webroot：`/var/www/pepepow-wallet/`（nginx 對外）

⚠️ 禁止事項：
❌ 禁止使用 `/opt/pepepow-wallet-suite/releases/*`
❌ 禁止改成 release/symlink 部署
❌ 不要把 nginx webroot 指回 repo 的 `apps/web/dist`
✅ 只允許 repo in-place 修改 + build + rsync 到 `/var/www/pepepow-wallet/`
✅ `wallet.pepepow.net` 靜態站維持在 `/var/www/pepepow-wallet/`

Production services run directly from `/home/ubuntu/pepepow-wallet-suite/`
`/opt` 不用於 active deployments

---

## 1️⃣2️⃣ 語系/i18n（Wallet UI）

目前 i18n 實作：`apps/web/src/i18n.ts`
來源優先序：query param `?lang=` → localStorage → Telegram `initDataUnsafe.user.language_code`
預設 fallback：en
header 語系切換：en → zh-TW → ru
