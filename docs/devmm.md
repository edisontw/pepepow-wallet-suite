# DevMM Strategy Documentation

## Overview

DevMM (Dev Fee Market Making) is a lightweight market-making strategy designed to:
1. **Provide micro-liquidity** for the PEPEW/USDT pair
2. **Gradually convert dev fee** PEPEW to USDT at low market impact
3. **Maintain order book depth** with controlled risk

## Supported Exchanges

| Exchange | minNotional | Status |
|----------|-------------|--------|
| NonKYC | 1 USDT | Supported |
| Dex-Trade | 5 USDT | Delisted (Unsupported) |
| NestEx | 0.001 USDT | Supported |

## Commands

### `/devmm`
Opens the DevMM menu with options to Start, Stop, view Status, or Reports.

### `/devmm_start [exchange]`
Starts DevMM on the specified exchange. If no exchange is provided, shows a selection menu.

**Parameters:**
- `exchange`: `nonkyc` or `nestex` (optional)

### `/devmm_stop [exchange]`
Stops DevMM on the specified exchange and cancels all open orders.

### `/devmm_status [exchange]`
Shows current DevMM status including:
- Strategy status (ACTIVE/PAUSED/STOPPED)
- Turnover vs daily cap
- Inventory (USDT/PEPEW balances)
- Current market prices (bid/ask/mid)
- Open order IDs
- Last action/error

### `/devmm_report [exchange] [period]`
Shows trading report with:
- Total turnover (BUY/SELL)
- VWAP prices
- Fee totals
- Net USDT/PEPEW changes

**Periods:** `daily`, `weekly`, `monthly`

## How It Works

### Order Placement
1. Fetches current orderbook bid/ask
2. Calculates mid price = (bid + ask) / 2
3. Places buy order at `mid * (1 - 2%)` 
4. Places sell order at `mid * (1 + 1%)`
5. Both orders are post-only (maker) to avoid taker fees

### Guards (Risk Controls)

| Guard | Trigger | Action |
|-------|---------|--------|
| Spread | < 0.2% or > 3% | PAUSE |
| Trend | Mid deviates > 8% from 60-min EMA | PAUSE 60min |
| Daily Cap | Turnover > 10% of 24h volume | PAUSE |
| Hourly Cap | Turnover > cap/24 | PAUSE |
| Inventory | USDT share < 10% | Skip BUY |
| Inventory | USDT share > 30% | Skip SELL |
| Cross-Self | buy_price >= sell_price | PAUSE |

### Refresh Cycle
- Default: Every 45 seconds ± 15s jitter
- On fill: 15-minute cooldown before next order

### Post-Only Enforcement
If post-only is rejected (would execute immediately):
1. Shift price by 1 tick away from counterparty
2. Retry up to 3 times
3. If still rejected, PAUSE with reason `POST_ONLY_REJECT`

## Configuration

DevMM uses a dedicated user ID for API keys: `devfee` (or set `DEVMM_TG_USER_ID` env var).

Before starting DevMM, ensure API keys are configured:
```
/keys → Select exchange → Enter API key/secret
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVMM_TG_USER_ID` | `devfee` | TG user ID for API key lookup |
| `DEBUG_DEVMM` | `0` | Enable debug logging (1/true) |

## Database Tables

- `devmm_config` - Strategy parameters per exchange
- `devmm_state` - Runtime state (prices, orders, turnover)
- `devmm_fills` - Trade fill records for reporting

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/devmm/start` | Start strategy |
| POST | `/v1/devmm/stop` | Stop strategy |
| GET | `/v1/devmm/status` | Get current status |
| GET | `/v1/devmm/report` | Get trading reports |
