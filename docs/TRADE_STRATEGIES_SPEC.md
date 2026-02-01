# Trading Strategies Specification

This document details the technical implementation and behavior of the three core trading strategies supported by the PepePow Trading Suite: **DCA**, **GRID**, and **Market Maker (MM)**.

---

## 1. Dollar Cost Averaging (DCA)

The DCA strategy aims to reduce the impact of volatility by buying a fixed amount of an asset at regular intervals.

### Core Logic
- **Tick Interval**: User-defined (e.g., every 60 minutes).
- **Execution Model**: "All-In Buy" - Each tick attempts to execute the full buy order immediately.
- **Order Flow**:
    1.  Cancel any existing open BUY orders for this strategy instance.
    2.  Check for available quote currency (e.g., USDT).
    3.  Calculate the buy amount based on `quote_per_order`.
    4.  Attempt a **Market Order** (if supported by the exchange) or a high-priority **Limit Order** (sweep loop) to ensure immediate fill.
- **Safety Caps**:
    - `maxTotalSpend`: The strategy automatically disables itself once the cumulative spend exceeds this value.
    - `runForMinutes`: The strategy automatically disables itself after a set duration.

---

## 2. GRID Strategy

The GRID strategy places a series of buy and sell orders at fixed price intervals above and beyond a "base price".

### Core Logic
- **Initialization**: Sets a `basePrice` (usually current market price) upon start.
- **Grid Structure**:
    - **Buy Side**: Multiple limit buy orders below the base price.
    - **Sell Side**: Multiple limit sell orders above the base price.
- **Reconciliation ("Gap Filling")**:
    - Every tick, the runner compares local "tracked" orders with actual exchange open orders.
    - If a buy order is filled, it places a corresponding sell order one "grid step" higher.
    - If a sell order is filled, it places a corresponding buy order one "grid step" lower.
- **Phantom Order Prevention**: Uses redundant checks and local order registries to ensure no "lost" or "ghost" orders remain on the exchange.

---

## 3. Market Maker (MM)

The Market Maker strategy provides liquidity by simultaneously placing buy and sell orders near the current market price, profiting from the spread.

### Modes
- **TWO_SIDED**: Maintains both buy and sell orders.
- **ONE_SIDED_BUY**: Only maintains buy orders (useful for accumulation).
- **ONE_SIDED_SELL**: Only maintains sell orders (useful for distribution).

### Core Logic
- **Dynamic Pricing**: Orders are placed at a specified `spread` % distance from the current mid-price.
- **Inventory Management**:
    - Checks for sufficient balance before placing each side of the trade.
    - Automatically skips a side if inventory is below the configured `minNotional`.
- **Order Refresh**:
    - Every tick, the runner evaluates if existing orders are still within an acceptable price range.
    - If the market moves significantly, it cancels old orders and places new ones to stay "on the book".

---

## Common Features (All Strategies)
- **Retry & Backoff**: Automated retries with exponential backoff on exchange errors.
- **Minimum Notional Enforcement**: Ensures all orders meet the exchange's minimum size requirements (e.g., > 1 USDT).
- **Error Logging**: Detailed failure reasons are stored in the database and visible via Telegram `/strategy_status`.
- **REAL Mode Only**: All strategies currently operate in REAL mode to ensure execution certainty.
