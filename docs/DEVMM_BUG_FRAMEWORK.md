# DevMM Bug Framework

This document turns repeated DevMM production bugs into a stable framework:

- shared failure taxonomy
- fixed decision order
- required log contract
- regression checklist
- change entry points

Use this file as the first reference before patching `devmmRunner`.

## Scope

Applies to:

- `services/trade-api/src/strategies/devmmRunner.ts`
- `services/trade-api/src/strategies/devmmCodes.ts`
- `services/trade-api/src/routes/devmm.ts`
- `services/trade-api/src/exchanges/nestex.ts`
- `services/trade-api/src/exchanges/dextrade.ts`
- `services/trade-api/src/exchanges/nonkyc.ts`
- `services/trade-api/src/scheduler.ts`

## Non-Negotiable Invariants

1. On start (or first eligible tick), bootstrap must try to seed at most `1 BUY + 1 SELL` per exchange.
2. Bootstrap may bypass daily cap only for bootstrap placements.
3. Daily cap blocks new replenishment only; it must not force empty-book startup.
4. Daily cap reached must not cancel existing open orders.
5. MM and DevMM must not run on the same `exchange + pair` at the same time.
6. Open-order parsing must normalize both `order id` and `side` across endpoint variants.
7. Visibility lag must be handled via `pending + grace`, preventing duplicate bursts.
8. `skipReason` / `pauseReason` must come from shared enum constants in `devmmCodes.ts`.
9. `issueCode` (`F01..F07`) must be emitted in tick logs and available from status API.

## Failure Taxonomy

| Code | Symptom | Root Cause Pattern | Primary Check | Primary Fix Area |
|---|---|---|---|---|
| `F01_START_CAP_LOCK` | Start stays `open=0`, reason includes `DAILY_CAP_REACHED` | Cap gate applied before first seed | `devmmRunner` logs for `phase=BOOTSTRAP` + `DAILY_CAP_BYPASS` | `devmmRunner` bootstrap/cap gating |
| `F02_BOOTSTRAP_ONE_SIDE` | Bootstrap places only BUY or only SELL | Inventory ratio guard blocks one side during bootstrap | `orderAttempt/orderResult` and `skip` decisions in bootstrap tick | `devmmRunner` bootstrap inventory override |
| `F03_NESTEX_SIDE_UNKNOWN` | NestEx repeatedly adds same side (e.g. 3 BUY 1 SELL) | Open-orders parser misses side field variants (`order_type`, etc.) | Raw `/orders` payload vs parsed side | `nestex.ts` order parser + side normalization |
| `F04_MM_DEVMM_COLLISION` | Mixed order behavior despite DevMM running | MM config still dispatching same pair/exchange | Scheduler logs for MM dispatch/skip reason | `scheduler.ts` occupancy guard |
| `F05_NOT_VISIBLE_DUP_BURST` | Order attempts spike while exchange says open orders missing | Visibility lag not covered by pending grace | `ORDER_NOT_VISIBLE`, `pendingCount`, `PENDING_NOT_VISIBLE` logs | `devmmRunner` pending reconciliation and grace |
| `F06_KEYS_SCOPE_MISMATCH` | Start API returns `MISSING_KEYS` unexpectedly | Wrong user id field (`tgUserId` vs `tg_user_id`) or env fallback to `devfee` | Start API request payload + key lookup logs | `routes/devmm.ts` input contract and callers |
| `F07_ZERO_SPREAD_LOOP` | No crossing spread from source, repeated degraded ticks | Book invalid, ticker fallback with zero spread not widened | `ZERO_SPREAD`, `FORCE_SPREAD`, `NO_CROSSING` logs | top-of-book fallback and force spread guard |

## Locked Tick Decision Order

Keep this order. Reordering causes regressions.

1. Resolve keys and config sanity.
2. Fetch balances and top-of-book (with fallback).
3. Derive guarded prices (`no-crossing`, `force-spread` if needed).
4. Compute qty and min-notional safety.
5. Read open orders and reconcile pending visibility.
6. Determine `phase=BOOTSTRAP|NORMAL`.
7. In bootstrap: allow one-time inventory ratio override if funds are sufficient.
8. Apply cap gates only when replenishment is needed and not bypassed.
9. Apply soft/hard order count guards.
10. Place up to `DEVMM_MAX_NEW_ORDERS_PER_TICK`.
11. Verify visibility, record pending, update decision and state.

## Required Tick Log Contract

Each tick must emit one summary line with:

- `exchangeId`, `strategyId`
- `phase`
- `bootstrapDone`
- `openOrders`, `pendingCount`
- `dailyCapBypassed`
- `decision`
- `skipReason`
- `orderAttempt`
- `orderResult`

These fields are required to classify incidents into `F01..F07`.

## Regression Checklist (Before Merge)

Run this minimum matrix:

1. Start with cap already exceeded:
   - expected: bootstrap still attempts initial placements.
2. Start with high USDT share:
   - expected: bootstrap can still place SELL if funds allow.
3. NestEx open orders response contains `order_type` only:
   - expected: side parsed correctly, no repeated same-side replenishment.
4. DevMM enabled with MM configs present:
   - expected: scheduler logs `reason=DEVMM_OWNS_PAIR` for matching MM config.
5. Simulate delayed order visibility:
   - expected: pending/grace blocks duplicate spam.
6. Stop/start via API payload variants:
   - expected: key lookup uses intended user id (no accidental `devfee` fallback).

## Fast Diagnosis Commands

Use `scripts/devmm-doctor.sh` for a one-shot view, or run manually:

```bash
curl -s "http://127.0.0.1:9195/v1/devmm/status?tg_user_id=<TG_USER_ID>" \
  | jq '.exchanges[] | {exchange,status,pauseReason,lastDecision,openOrders,pendingCount,phase,bootstrapDone}'

sudo journalctl -u pepepow-trade-api -n 1200 --no-pager \
  | egrep -i "devmmRunner|DAILY_CAP|BOOTSTRAP|orderAttempt|orderResult|PENDING_NOT_VISIBLE|MAX_OPEN_ORDERS_SOFT|NO_CROSSING|MIN_NOTIONAL|DEVMM_OWNS_PAIR|ORDER_NOT_VISIBLE|TICKER_FALLBACK|ZERO_SPREAD"
```

## Change Entry Points

Use this map to avoid editing the wrong layer:

- bootstrap and cap timing:
  - `services/trade-api/src/strategies/devmmRunner.ts`
- open-order endpoint compatibility/parsing:
  - `services/trade-api/src/exchanges/nestex.ts`
- MM/DevMM mutual exclusion:
  - `services/trade-api/src/scheduler.ts`
- start/stop payload and user-id resolution:
  - `services/trade-api/src/routes/devmm.ts`
- status projection for UI/bot:
  - `services/trade-api/src/routes/devmm.ts`
  - `services/trade-bot/src/commands/devmm.ts`

## Incident Workflow

For each new bug:

1. classify with `Fxx` (or add new code)
2. capture evidence using doctor script + status output
3. patch one layer only if possible
4. run regression checklist
5. append a short note to `DEVMM_INCIDENT_TEMPLATE.md`
