# 📘 Consolidation Feature – Development Notes & Lessons Learned

## 1. Background

PEPEPOW is a UTXO-based chain.
Over time, users accumulate thousands of small UTXOs (from mining, faucets, micro-transactions, etc.).

When a user attempts to send or consolidate:

* Each input requires raw transaction lookup
* Transaction size increases linearly with number of inputs
* RPC/indexer load increases dramatically
* Mobile browsers may freeze background JavaScript

The goal of consolidation was:

> Merge many small UTXOs into fewer large ones, safely and reliably, in a non-custodial web wallet.

---

## 2. Initial Problems Encountered

### 2.1 RawTx Lookup Storm

Example case:

```
165 inputs
→ 165 rawtx fetch calls
→ 37/165 failed
```

Root causes:

* Sequential rawtx lookups
* Timeout too short
* Upstream indexer/RPC under load
* Any single rawtx failure aborted whole transaction

---

### 2.2 Upstream API Overload

Under concurrency (multiple users):

* wallet-api → pepew-api (9193) spiked
* Timeouts (8s / 12s) were too aggressive
* Queue buildup caused 504 errors

Fix implemented:

* Global upstream concurrency gate
* Bounded queue
* Increased timeout:

  * `PEPEW_API_UPSTREAM_TIMEOUT_MS=15000`
  * `PEPEW_API_HISTORY_TIMEOUT_MS=25000`
* Concurrency:

  * `PEPEW_API_UPSTREAM_CONCURRENCY=8`
  * `PEPEW_API_UPSTREAM_MAX_QUEUE=200`

---

### 2.3 Oversized Single Consolidation

Wallets with thousands of UTXOs caused:

* 100+ rounds needed
* Users clicking repeatedly
* mempool conflicts
* RPC pressure amplification

We realized:

> Input count must be capped.

---

## 3. Architectural Decisions

### 3.1 Input Cap Strategy

We introduced multiple limits:

```
MIN_CONSOLIDATION_INPUTS = 40
DEFAULT_CONSOLIDATION_INPUTS = 80
MAX_UI_CONSOLIDATION_INPUTS = 120
HARD_CAP_CONSOLIDATION_INPUTS = 150
```

Why?

* 40 → safest (low failure rate)
* 80 → best stability/performance balance
* 120 → advanced option
* 150 → absolute safety ceiling
* 200 → too risky under real load

---

### 3.2 Chunked Consolidation

Instead of merging everything at once:

* Consolidation runs in rounds
* Each round merges at most `cap` inputs
* After broadcast:

  * Wait for propagation
  * Refresh UTXOs
  * Continue next round

This dramatically reduced:

* rawtx storm probability
* timeout frequency
* server overload risk

---

### 3.3 Auto Consolidation Mode

Problem:
Mobile browsers freeze JS when screen turns off.

Solution:

* Wake Lock API (best-effort)
* Pause when background detected
* Resume manually when foreground
* Persist minimal progress state (round count, last txid)
* No secret data stored

---

### 3.4 Load Protection Principles

To avoid systemic failure:

* Bounded concurrency (client side = 4)
* Global upstream gate (server side)
* Short TTL cache for rawtx (future optimization)
* No infinite polling
* Visibility-based refresh only

---

## 4. Key Lessons Learned

### 4.1 UTXO systems scale linearly with input count

Large input counts amplify:

* rawtx lookups
* RPC load
* transaction size
* timeout probability

Always cap inputs.

---

### 4.2 Mobile web apps are not background workers

JS timers are paused when:

* Screen locks
* Telegram Mini App backgrounded
* iOS Safari throttles

Auto processes must:

* Pause safely
* Resume safely
* Never silently fail

---

### 4.3 Stability > Speed

A slower but deterministic consolidation is better than:

* Fast but failure-prone behavior
* Random 504 errors
* User confusion

---

## 5. Final Safe Parameter Configuration

### Consolidation

```
DEFAULT_CONSOLIDATION_INPUTS = 80
HARD_CAP_CONSOLIDATION_INPUTS = 150
```

### Client

```
RAW_TX_BATCH_CONCURRENCY = 4
```

### Server (wallet-api)

```
PEPEW_API_UPSTREAM_TIMEOUT_MS=15000
PEPEW_API_HISTORY_TIMEOUT_MS=25000
PEPEW_API_UPSTREAM_CONCURRENCY=8
PEPEW_API_UPSTREAM_MAX_QUEUE=200
```

---

## 6. Future Improvements

* ElectrumX integration (remove rawtx storm entirely)
* Server-side rawtx batch endpoint
* Upstream latency monitoring (p95/p99)
* Adaptive input cap based on current load