# 🚀 PEPEPOW Trade Bot – Quick Start Guide (New UI Version)

Welcome to the **PEPEPOW Trading Suite**.
The new graphical menu makes everything easier — no need to remember long commands. Just tap buttons and follow the flow.

---

## ✅ Prerequisites

Before you begin, make sure you have:

1. **Telegram account**
2. **Exchange account + API Key & Secret** (spot trading enabled)

   * **NonKYC** (Recommended)
   * **Dex-Trade**
   * **NestEx**
3. **Funds in your exchange account**

   * USDT (for buying)
   * PEPEW (for market making / grid)

---

# 🔹 Step 0 — Open the Bot

1. Open Telegram
2. Search: **@pepepow_tradebot**
3. Tap **Start**
4. You’ll now see the main menu buttons:

```
Strategy | Status | Report | Stop | Key | Help
```

From now on, just tap buttons — no need to type most commands.

---

# 🔑 Step 1 — Set Up API Keys

Before running any strategy, connect your exchange.

1. Tap **Key**
2. Choose:

   * `Set`
   * `Status`
   * `Clear`

### To add keys:

1. Tap **Set**
2. Select your exchange
3. Paste **API Key**
4. Paste **API Secret**
5. Done ✅

You can verify anytime with **Key → Status**

---

# 📈 Step 2 — Start a Strategy

Tap **Strategy** and choose:

* **DCA**
* **GRID**
* **MM**
* **DEVMM**

---

## 🔹 Example: Start DCA (Auto Buy)

1. Tap **Strategy → DCA**
2. Select Exchange
3. Select Pair `PEPEW/USDT`
4. Choose:

   * Budget per order
   * Interval
5. Confirm

The bot starts automatically.

---

## 🔹 Example: Start MM (Market Making)

1. Tap **Strategy → MM**
2. Select Exchange
3. Select Pair
4. Choose **Quote per order** (buttons shown based on exchange)

Example:

**NonKYC options:**
`1.05  3  5  10  20  35  50  100`

**Dex-Trade options:**
`5.1  7  10  15  20  35  50  100`

**NestEx options:**
`0.5  1  3  5  10  20  35  50  100`

No manual number typing needed.

---

## 🔹 Example: Start GRID

1. Tap **Strategy → GRID**
2. Select Exchange
3. Choose:

   * **Grid Levels**
     `1 2 3 5 7 10`
   * **Grid Step %**
     `1% 2% 3% 5% 10% 20% 30% 50% 100%`
   * **Quote per order** (exchange-based buttons)
4. Confirm

---

## 🔹 DEVMM (Dev Fee Market Making)

Tap **Strategy → DEVMM**

Options:

* **Start All**
* **Stop All**
* Per-exchange start/stop

---

# 📊 Step 3 — Check Status

Tap **Status**

You’ll see:

* Exchange balances
* Active strategies
* Order counts
* Recent activity
* DevMM summary

Everything is unified under `/status`.

---

# 📑 Step 4 — Generate Reports

Tap **Report**

Flow:

1. Choose Period

   * Daily
   * Weekly
   * Monthly
2. Choose Exchange
3. Get breakdown:

   * DCA
   * GRID
   * MM
   * DEVMM
   * TOTAL

---

# 🛑 Step 5 — Stop Trading

Tap **Stop**

Options:

* NonKYC
* Dex-Trade
* NestEx
* Stop All

Stopping will:

* Disable strategies
* Cancel open orders safely

---

# 💡 Pro Tips

### ✔ Minimum Order Size

Exchanges require minimum order values:

* NonKYC ≈ 1 USDT
* Dex-Trade ≈ 5 USDT
* NestEx ≈ small but enforced

The bot validates automatically.

---

### ✔ Safer UI

* No scientific notation
* No manual numeric input required
* Always returns to main menu after actions

---

### ✔ Need Help?

Tap **Help** anytime.

---

## 🎯 You're Ready

With the new UI:

* Setup takes under 2 minutes
* Strategies launch in a few taps
* Monitoring and reporting are fully integrated

Welcome to automated PEPEW trading 🚀