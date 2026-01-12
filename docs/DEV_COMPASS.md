1️⃣ 核心設計原則（不可破壞）
🔐 非託管（Non-custodial）【最高優先】
助記詞 / 私鑰只存在使用者端
Mini App：localStorage + 可選 Telegram Cloud Storage
後端嚴禁
不存助記詞
不存私鑰
不代簽交易
👉 後端只做：讀鏈、費率估算、送 rawTx

2️⃣ 使用者體驗總覽（產品層）
支援功能（MVP 必須）
建立 / 匯入錢包（12 / 24 助記詞）
顯示餘額
收款地址 + QR Code
發送交易
手續費估算
交易紀錄
介面形態
Telegram Bot（指令導向）
Telegram Mini App（完整視覺化錢包）
同一套前端也服務 Web Wallet

3️⃣ 系統整體架構（邏輯版）
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

4️⃣ 元件與責任切分（防迷失關鍵）
A. Telegram Bot（輕、導流）
只負責導引，不做錢包邏輯
/start → 綁定帳號 + 開 Mini App
/balance → 查詢 + 快速按鈕
/deposit → 地址 + QR
/send → 導向 Mini App
/history → 近 10 筆（快取）

B. Mini App（錢包本體）
錢包邏輯唯一所在地
頁面結構：
初始化
建立 / 匯入助記詞
首頁
地址、餘額、QR
發送
地址
金額
手續費估算
UTXO 自動揀選
本地簽名
廣播
紀錄
tx list → txid
之後擴充（非 MVP）
PoS / MN、Telegram tip、掃碼支付

C. Backend Wallet API（嚴格受限）
定位明確：不變成第二個錢包
驗證 Telegram WebApp initData
發 JWT（短效，例 30 分鐘）

提供：
balance
utxos
estimate fee
broadcast rawTx
history cache

5️⃣ 區塊鏈存取規則（已定）
類型	來源
讀鏈	https://api.pepepow.net/v1/...
送交易	pepepowd JSON-RPC (sendrawtransaction)
高度	pepew-api / ZMQ
費率	estimatesmartfee → fallback

👉 不允許直接從 Mini App 打 RPC

6️⃣ 技術選型（可接受微調）
已穩定
Bot：Node.js + grammY
Mini App：Vite + React + TS + @twa-dev/sdk
Backend：Node.js + Express / Fastify
驗證：JWT + Zod
DB：PostgreSQL（MVP 可 SQLite）

錢包核心：
bip39, bip32
bitcoinjs-lib 變體（依 PEPEPOW address 前綴）

部署：
systemd（不是 Docker 為主）
Nginx + Let’s Encrypt

7️⃣ 資料庫角色（只存「公開與快取」）
❌ 不存
私鑰
助記詞
簽名資料

✅ 存
Telegram user 基本資料
綁定地址（公開）
交易快取（history）
Schema 設計 ✔ 已合理
👉 目前不需大改

8️⃣ Runtime & DevOps（已很完整）
服務與 Port
pepew-api → :9193
wallet-api + bot → :9194
nginx → public
必備健康檢查
/healthz
/readyz（503 + error reason）

已確認是「好設計」
systemd units
env file 分離
Redis / ZMQ optional
詳細 common failure 列表
這一段不需要重寫，只需要引用