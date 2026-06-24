# Trading Strategies Specification

This document describes the current runtime behavior of the three core strategies in PepePow Trading Suite: **DCA**, **GRID**, and **MM**.

`DEVMM` is documented separately in `docs/devmm.md`.

---

## 1. Dollar Cost Averaging (DCA)

DCA accumulates a fixed quote amount at a fixed interval.

### Core Logic
- **Interval guard**: Tick executes only when `intervalSec` has elapsed.
- **Stop caps**:
  - `maxTotalSpend` auto-stops when cumulative spend reaches cap.
  - `endsAt` (derived from `runForMinutes`) auto-stops on time limit.
- **Hard cleanup rule**: Before placing a new buy, runner cancels all existing open DCA BUY orders for this config.
- **Execution model**: all-in buy attempt per tick.
  - Dex-Trade (Delisted/Disabled) used MARKET-style execution path.
  - NonKYC/NestEx use aggressive limit/sweep behavior.
- **Validation and safety**:
  - API key required in REAL mode.
  - Minimum notional enforced.
  - Rate-limit guard (`max orders/hour`, `max quote/day`) applied before order placement.

---

## 2. GRID Strategy

GRID maintains a ladder of limit BUY/SELL orders around a base price.

### Core Logic
- **Initialization**: If `base_price` is missing, first tick sets it from current market price and returns.
- **Ladder generation**:
  - BUY targets below base.
  - SELL targets above base (`allow_sell=true` by default).
  - Target count controlled by `grid_levels` and `grid_step_pct`.
- **Exchange reconciliation**:
  - Compares tracked open orders with exchange open orders.
  - Missing exchange orders are synced as closed/filled after propagation buffer.
  - Removes duplicates and cross-side collisions to prevent self-crossing.
- **Gap filling**:
  - Rebuilds desired levels each tick.
  - Places only missing levels, respecting side room and `refresh_sec`.
- **Safety checks**:
  - Key presence and decrypt check.
  - Minimum notional / minimum quantity checks before placement.
  - Balance checks prevent creating BUY/SELL legs without inventory.

---

## 3. Market Maker (MM)

MM places quotes around mid-price and refreshes them continuously.

### Modes
- **TWO_SIDED**: Maintains both buy and sell orders.
- **ONE_SIDED_BUY**: Only maintains buy orders (useful for accumulation).
- **ONE_SIDED_SELL**: Only maintains sell orders (useful for distribution).

### Core Logic
- **Quote model**:
  - Uses `spread_pct` around current mid-price.
  - Uses `quote_per_order` and `orders_per_side` (1/3/5 from bot wizard).
- **REAL-mode inventory source**: fetches live balances each tick (fail-closed on balance fetch failure).
- **Order reconciliation**:
  - Fetches exchange open orders.
  - Reconciles local registry with exchange state.
  - Cancels stale/excess managed orders and re-quotes.
- **Inventory and notional guards**:
  - Side can be skipped when inventory is insufficient.
  - Minimum notional enforcement per exchange/pair.

---

## Common Features (All Strategies)
- **Retry & Backoff**: Automated retries with exponential backoff on exchange errors.
- **Auto-stop on severe errors**: Error classifier can auto-disable config and cancel outstanding orders.
- **Minimum Notional Enforcement**: Orders below exchange minimum are rejected/skipped.
- **Failure recording**: Failures are aggregated in DB and surfaced in Telegram `/status` as backoff/auto-stopped state.
- **REAL Mode Only**: Bot/user flow creates and runs DCA/GRID/MM in REAL mode.
