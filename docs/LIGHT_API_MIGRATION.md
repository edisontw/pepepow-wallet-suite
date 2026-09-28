# PEPEW Light API Migration Roadmap

Approved: 2026-09-27

Goal: move Telegram Wallet blockchain access from the legacy local `pepew-api / pepepowd RPC` path to the existing PEPEW Light API / ElectrumX stack without changing the non-custodial security model.

Reference implementations:

- `edisontw/pepepow-light-wallet`
- `edisontw/pepepow-electrumx-service`
- `edisontw/electrumx-pepepow`

## Hard invariants

- Mnemonic/private keys remain client-side.
- Client signs transactions.
- Backend never signs.
- Trade remains isolated.
- ElectrumX is not exposed directly to browsers.
- Migration is incremental and rollbackable.
- Do not introduce new dependencies on legacy wallet-api chain proxy/RPC routes.

## M0 — Architecture / contract freeze

Status: **COMPLETE**

Scope:

- approve PEPEW Light API as Wallet chain-access data plane;
- redefine wallet-api as Telegram/product control plane;
- document legacy runtime as transitional;
- define migration stages and final acceptance;
- align documentation with the actual Light API UTXO contract.

No runtime behavior change.

## M1 — Add Light API client to Wallet Suite

Status: **COMPLETE**

Goal: create a dedicated client adapter in Wallet Suite without changing production call sites yet.

Reference:

`pepepow-light-wallet/apps/web/src/lib/pepewLightClient.ts`

Required client methods:

```text
getAddress(address)
getHistory(address, options)
getUtxo(address, options)
getTx(txid, raw)
broadcastSignedRawTx(rawTx)
```

Requirements:

- typed normalized responses;
- timeout;
- safe error mapping;
- HTTP 429 handling/backoff;
- bounded retries only where safe;
- no secret-bearing request types;
- production base URL/configuration documented.

Verification:

- unit tests for success/error shapes;
- invalid address;
- timeout;
- 429;
- 5xx/unavailable;
- API requests contain no mnemonic/private key.

M1 implementation:

- added `apps/web/src/lib/pepewLightClient.ts`;
- added typed address/history/UTXO/tx/broadcast contracts;
- GET/HEAD requests have one bounded retry by default for network/timeout/429/502/503/504 failures;
- signed broadcast is never automatically retried;
- API errors are mapped to stable safe messages rather than exposing upstream detail;
- added `VITE_PEPEW_LIGHT_API_BASE_URL` with production default `https://light.pepepow.net`;
- added `npm --prefix apps/web run test:light-client`.

M1 does not change any production call site and does not delete legacy API code.

## M2 — Mini App read migration

Status: **COMPLETE**

Switch these Mini App/Web Wallet functions to the Light API client:

- address summary / balance;
- transaction history;
- UTXO lookup;
- transaction/raw previous transaction lookup.

Keep temporarily:

- legacy fee estimate;
- legacy broadcast, until M4.

Requirements:

- compare old/new data for known addresses;
- preserve amount units exactly;
- use 8-decimal atomic integer semantics;
- handle mempool/unconfirmed state;
- refresh UTXO before send preparation;
- do not overuse `fresh=1`.

Implementation:

- Wallet balance/address summary uses PEPEW Light API.
- Wallet UTXO state uses `GET /api/wallet/utxo/{address}`.
- The client derives the active P2PKH script locally from the public sender address; the Light UTXO contract does not carry `scriptHex`.
- Send/consolidation refresh spend-sensitive UTXOs with `fresh=1`.
- Previous raw transactions use `GET /api/wallet/tx/{txid}?raw=1` with client-side concurrency capped at 6.
- History uses PEPEW Light API for the active wallet address. The previous 40-address browser fan-out was intentionally not reproduced because it would turn one batch request into 40 public API calls. The current transaction builder returns change to the active sender address. If multi-address HD discovery is required later, add a bounded Light API batch/discovery contract instead of browser fan-out.
- Legacy fee estimation remains on `/wallet/fee/estimate`.
- Legacy signed broadcast remains on `/wallet/tx/broadcast` until M4.

Acceptance:

- Mini App balance/history/UTXO/raw-tx reads no longer call Wallet Suite legacy chain proxy endpoints.
- Fresh UTXO lookup occurs immediately before send selection.
- Fee estimation and broadcast remain unchanged for rollback isolation.

## M3 — Telegram Bot read migration

Status: **COMPLETE**

Change Bot command flow:

```text
/balance
  -> wallet-api default address
  -> Light API address summary

/history
  -> wallet-api default address
  -> Light API history
```

Do not change:

- Telegram auth;
- default address binding;
- payment request logic;
- Mini App signing.

Implementation:

- Telegram `/balance` and its callback still resolve the user's default public address through `wallet-api /v1/address/default`, then query `PEPEW_LIGHT_API_BASE/api/wallet/address/{address}`.
- Telegram `/history` and its callback query `PEPEW_LIGHT_API_BASE/api/wallet/history/{address}?limit=10&verbose=true&detail_limit=10`.
- Light balance atomic values are converted to PEPEW at the display boundary; internal arithmetic stays atomic.
- History uses Light API address-relative delta fields when available.
- Bot Light reads use bounded one-retry handling for 429/502/503/504 and transient network failures.
- Deposit/default-address/payment-request flows remain on wallet-api.
- Fee estimate and signed broadcast remain legacy for M4/M5 isolation.

Acceptance:

- Bot balance/history no longer call `wallet-api /wallet/balance` or `/wallet/history`;
- Bot default-address resolution remains on `wallet-api /v1/address/default`;
- failures are user-safe;
- Bot never receives private-key material.

## M4 — Signed broadcast migration

Status: **CODE COMPLETE — live signed-tx acceptance pending**

Move Mini App broadcast to:

```text
POST https://light.pepepow.net/api/wallet/broadcast
{ "raw_tx": "<already signed hex>" }
```

Adopt proven Light Wallet resilience where applicable:

- recent-spent outpoint tracking;
- fresh/reconciled UTXO state;
- bounded previous-tx retry;
- no blind repeated broadcast;
- refresh history/UTXO after broadcast.

Implementation:

- Mini App and consolidation broadcast now call `pepewLightClient.broadcastSignedRawTx()`.
- The Light API request body is exactly `{ "raw_tx": "<signed hex>" }`.
- Broadcast POST is attempted exactly once; no automatic retry is allowed after timeout/network/upstream uncertainty.
- Timeout/network/5xx ambiguity is surfaced as `BROADCAST_STATUS_UNCERTAIN` so the user reconciles history/UTXOs before any retry.
- `broadcast_rejected` is treated as a definite rejection and directs the user to refresh UTXOs/history.
- Successfully broadcast inputs are persisted in browser storage for 10 minutes and excluded from spend selection while ElectrumX/indexer state catches up.
- Consolidation progress checks use a raw fresh Light API UTXO snapshot so local recent-spent filtering cannot falsely signal indexer progress.
- The legacy wallet-api broadcast endpoint remains available only as rollback compatibility until M6; Mini App no longer calls it.

Acceptance:

- [PENDING MANUAL] real small-amount client-signed transaction broadcasts successfully;
- [PASS CODE] request body contains only `raw_tx`;
- [PASS CODE] no automatic broadcast retry;
- [PASS CODE] stale/recent-spent UTXO protection is active;
- [PASS CODE] Mini App no longer requires wallet-api direct `sendrawtransaction`.

Do not mark the live transaction acceptance PASS without a user-authorized wallet send.

## M5 — Fee decoupling

Status: **BLOCKED ON M4 LIVE ACCEPTANCE**

Remove fee estimation as the final Wallet API direct-RPC exception.

Choose one reviewed design:

### Option A — Light API fee policy

Expose a bounded fee-rate/policy response through PEPEW Light API.

### Option B — Client-side fee policy

Use reviewed transaction-size estimation and a documented fee-rate policy.

Do not simply copy the Light Wallet's temporary fixed `0.0001 PEPEW` default as the production architecture.

Acceptance:

- send preview shows deterministic fee;
- low/high input-count cases are tested;
- no direct `estimatesmartfee` dependency remains in wallet-api;
- `CORE_RPC_URL` is no longer required for Wallet functions.

## M6 — Legacy cleanup

Status: planned

After M1-M5 are accepted, remove or formally deprecate Wallet chain proxy code from wallet-api:

- `/wallet/balance`;
- `/wallet/utxos`;
- `/wallet/history`;
- raw-tx lookup/cache/RPC fallback;
- direct broadcast aliases/RPC implementation;
- Wallet dependency on `pepew-api :9193`;
- Wallet direct `CORE_RPC_URL`.

Do not remove `pepew-api` itself if other products still consume it.

Update:

- architecture docs;
- env docs;
- systemd/readiness checks;
- Nginx routes/rate limits;
- operational runbooks.

## Final acceptance matrix

| Check | Required |
| --- | --- |
| Bot `/balance` through Light API | PASS |
| Bot `/history` through Light API | PASS |
| Mini App balance/history through Light API | PASS |
| Mini App UTXO through Light API | PASS |
| Previous tx/raw lookup through Light API | PASS |
| Client-side signing only | PASS |
| Signed rawTx broadcast through Light API | PASS |
| Fee no longer requires Wallet direct RPC | PASS |
| Wallet Suite blocked from local pepepowd RPC | wallet functions still PASS |
| No mnemonic/private key in backend requests/logs/DB | PASS |
| Telegram auth/address binding/payment requests | PASS |
| Trade subsystem unaffected | PASS |

## Rollback policy

Each milestone must be deployable independently.

If a new Light API path fails acceptance:

1. restore the previous production call site;
2. do not roll back non-custodial security checks;
3. capture the failing response/error shape without secrets;
4. fix the smallest responsible layer;
5. rerun parity tests before attempting cutover again.

## Agent implementation rule

Before implementing a milestone, read:

1. this roadmap;
2. `docs/DEV_COMPASS.md`;
3. only the relevant Wallet Suite source files;
4. the corresponding current Light Wallet / PEPEW Light API reference implementation.

Make one coherent layer change per task and report:

- files changed;
- API paths changed;
- tests run;
- rollback path;
- security-boundary verification.
