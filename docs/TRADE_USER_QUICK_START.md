# PEPEPOW Trade Bot Quick Start (Current UI)

This guide matches the current Telegram bot behavior.

## Design Purpose

- Reduce manual order placement workload by automating repetitive trading operations.
- Improve market depth and stability by continuously maintaining structured buy/sell liquidity.
- Strategy execution can generate profit in some market conditions, but profit is not the primary purpose.
- The primary purpose is healthier market structure and more stable trading activity for PEPEW pairs.

## Prerequisites

Before you start:

1. Telegram account.
2. Exchange account with trade-enabled API key and secret.
3. Funds in exchange account:
   - quote asset (`USDT` or `BNB`) for buys
   - `PEPEW` inventory if you want sell-side quoting (GRID/MM)

Supported exchanges:
- NonKYC
- Dex-Trade
- NestEx

## Step 0: Open the Bot

1. Open Telegram.
2. Search `@pepepow_tradebot`.
3. Tap `Start` (or run `/start`).
4. Main menu keyboard appears:

`Status | Debug | Price | Strategy | Report | Stop | API Keys | Donation`

## Step 1: Set API Keys

1. Tap `API Keys` (or run `/key`).
2. Choose one action:
   - `Set`
   - `Status`
   - `Clear`
3. To set keys:
   - `Set` -> choose exchange
   - paste API key
   - paste API secret

Use `Status` to verify keys are stored and valid.

## Step 2: Start a Strategy

Tap `Strategy` (or run `/strategy`) and choose:
- `DCA`
- `GRID`
- `MM`
- `DEVMM`

### DCA flow (auto-buy)

`Strategy -> DCA` then:
1. Select exchange.
2. Select pair.
3. Enter quote per order (text input).
4. Enter interval in minutes (text input).
5. Enter max total spend (`0` = unlimited).
6. Enter run duration in minutes (`0` = unlimited).

The config is created and started in REAL mode.

### MM flow (market making)

`Strategy -> MM` then:
1. Select exchange and pair.
2. Select spread (`1%` to `5%`, button-only).
3. Select quote per order (buttons; manual number is also accepted).
4. Select orders per side (`1`, `3`, `5`).

Default quote buttons (USDT pairs):
- NonKYC: `1.05 3 5 10 20 35 50 100`
- Dex-Trade: `5.1 7 10 15 20 35 50 100`
- NestEx: `0.5 1 3 5 10 20 35 50 100`

### GRID flow

`Strategy -> GRID` then:
1. Select exchange and pair.
2. Select levels (`1 2 3 5 7 10`).
3. Select step percent (`1% 2% 3% 5% 10% 20% 30% 50% 100%`).
4. Select quote per order (buttons; manual number is accepted).

The config is created and started in REAL mode.

### DEVMM flow

`Strategy -> DEVMM` provides:
- `Start`
- `Start All`
- `Stop`
- `Stop All`

## Step 3: Check Status

Tap `Status` (or run `/status`) for unified monitoring:
- exchange balances
- active REAL strategies
- DevMM summary
- runtime/degraded hints

Use `Debug` for deeper DevMM diagnostics.

## Step 4: Generate Report

Tap `Report` (or run `/report`):
1. Choose period: `Daily`, `Weekly`, or `Monthly`.
2. Bot returns one report that includes all exchanges.
3. If some exchanges have zero trades, compact view may hide them; use `Show all exchanges` to expand.

## Step 5: Stop Trading

Tap `Stop` (or run `/stop`):
- NonKYC
- Dex-Trade
- NestEx
- Stop All

This stops active DCA/GRID/MM/DEVMM for the selected scope and queues order cancellation.

## Important Usage Notes

- Trading involves risk; losses can occur in volatile or illiquid markets.
- The bot does not guarantee profit, and should not be treated as a guaranteed income tool.
- Start with small order sizes first, then scale after observing real fills and behavior.
- Use trade-only API keys only; never enable withdrawal permission.
- Keep sufficient quote and base balances, or strategies may skip/underperform.
- Monitor `/status` and `/report` regularly, and use `/stop` immediately when conditions change.
- The bot validates minimum notional requirements per exchange/pair.
- Legacy commands still work, but `/status` and `/report` are the primary paths.
