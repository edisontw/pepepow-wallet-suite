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

Status: **PRODUCTION ACCEPTED**

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

- [PASS PRODUCTION] real small-amount client-signed transaction broadcasts successfully;
- [PASS CODE] request body contains only `raw_tx`;
- [PASS CODE] no automatic broadcast retry;
- [PASS CODE] stale/recent-spent UTXO protection is active;
- [PASS CODE] Mini App no longer requires wallet-api direct `sendrawtransaction`.

Do not mark the live transaction acceptance PASS without a user-authorized wallet send.

## M5 — Fee decoupling

Status: **COMPLETE — production accepted 2026-09-28**

Selected design: **Option B — client-side deterministic size-based minimum fee policy**.

No PEPEW Light API fee endpoint is required.

Policy:

```text
fee rate   = 10,000 atomic / 1000 bytes (0.0001 PEPEW/kB)
minimum    = 10,000 atomic              (0.0001 PEPEW)
tx bytes   = 10 + inputs * 148 + outputs * 34
fee atomic = max(minimum, ceil(tx_bytes * fee_rate / 1000))
```

Implementation:

- Send fee is computed locally from fresh selected UTXO count using integer arithmetic.
- Normal send selects UTXOs against the dynamically increasing fee with a conservative 2-output model.
- Consolidation computes fee independently for its selected input count and 1-output model.
- The fee UI is read-only and identifies the source as `client-size-policy`.
- Mini App/Web Wallet no longer calls `/wallet/fee/estimate`.
- The client fee policy and wallet-api cleanup passed production acceptance. The legacy wallet-api fee route and direct `estimatesmartfee` dependency are no longer served in production.

Acceptance:

- [PASS CODE] deterministic fee helper and low/high input-count tests;
- [PASS CODE] normal send and consolidation both use the size-based policy;
- [PASS CODE] Mini App/Web Wallet has no `/wallet/fee/estimate` consumer;
- [PASS PRODUCTION] deployed Web build and completed a client-signed send with the new fee policy;
- [PASS CODE] wallet-api `/wallet/fee/estimate` and direct `estimatesmartfee` usage removed in `main`;
- [PASS PRODUCTION] wallet-api restarted successfully; `/wallet/fee/estimate` returns 404 and production source/dist contain no `estimatesmartfee` or `FEE_ESTIMATE_*`;
- [PASS ACTIVE WALLET PATH] fee calculation no longer requires `CORE_RPC_URL`. Remaining direct-RPC compatibility/diagnostic code is deferred to M6.

## M6 — Legacy cleanup

Status: **IN PROGRESS — M6a–M6e PRODUCTION ACCEPTED; final M6f isolation acceptance remains.**

After M1-M5 are accepted, remove or formally deprecate Wallet chain proxy code from wallet-api.

### M6a — dead read-proxy retirement

Code scope:

- remove `GET /wallet/balance`;
- remove `GET /wallet/utxos`;
- remove `GET /wallet/history`;
- remove `POST /v1/history` from wallet-api;
- remove the wallet-api `pepew-api` read-proxy queue/concurrency helpers and their dedicated `PEPEW_API_UPSTREAM_*` variables;
- remove stale Web API constants for those retired routes;
- keep raw-tx compatibility until M6b; keep direct broadcast compatibility, `PEPEW_API_BASE`, and `CORE_RPC_URL` for later M6 slices.

Production acceptance (2026-09-28): post-Light-API-cutover access logs showed zero calls to the retired routes; wallet-api build, M2/M3/M4/M5/M6a boundary tests, and Web build passed; `/healthz` and `/readyz` passed after restart; all four retired routes returned 404; Telegram `/balance` and `/history` passed through PEPEW Light API.

### M6b — raw-tx compatibility retirement

Code scope:

- remove `GET /wallet/tx/raw`;
- remove `GET /api/tx/raw`;
- remove `GET /v1/tx/raw/:txid`;
- remove `POST /wallet/tx/raw/batch`;
- remove `POST /api/tx/raw/batch`;
- remove the Wallet API raw-tx cache, batch/concurrency controls, retry logic, `pepew-api` raw lookup, and direct `getrawtransaction` RPC fallback;
- keep an explicit Nginx `/v1/tx/raw/` 404 tombstone so requests cannot fall through to the broader `pepew-api :9193` `/v1/tx/` route;
- preserve direct broadcast compatibility, RPC health/readiness, `PEPEW_API_BASE`, and `CORE_RPC_URL` for later M6 slices.

Production acceptance (2026-09-29): post-Light-API-cutover access logs showed zero calls to the retired raw-tx routes; wallet-api build plus M2/M3/M4/M5/M6a/M6b boundary tests passed; `/healthz` and `/readyz` passed after restart; all five raw-tx routes returned 404; direct broadcast compatibility remained available; public Nginx still explicitly routed `/v1/tx/raw/` to wallet-api `:9194`, so there was no fall-through to `pepew-api :9193`; Telegram `/balance` and `/history` passed.

### M6c — direct-broadcast retirement

Code scope:

- remove `POST /wallet/tx/broadcast`;
- remove `POST /wallet/tx/send`;
- remove `POST /api/tx/send`;
- remove Wallet API direct `sendrawtransaction` RPC implementation;
- remove `decoderawtransaction` debug flow and `/tmp/rawtx.hex` debug-file support;
- remove Wallet API transaction-specific rate limiters and `WALLET_API_RATE_LIMIT_TX_*` settings;
- make the three retired Wallet direct-broadcast routes explicit Nginx 404 tombstones;
- preserve `pepew-api :9193` `/v1/tx/broadcast`, RPC health/readiness, `PEPEW_API_BASE`, and `CORE_RPC_URL` for later M6 work.

Production acceptance (2026-09-29): post-Light-API-cutover access logs showed zero calls to the three retired Wallet direct-broadcast routes; wallet-api build plus M2/M3/M4/M5/M6a/M6b/M6c boundary tests passed; `/healthz` and `/readyz` passed after restart; all three direct-broadcast routes returned 404 locally; the public `/wallet/tx/broadcast` path also returned 404 through the existing Nginx proxy to wallet-api; Telegram `/balance` and `/history` passed. `PEPEW_API_BASE` and `CORE_RPC_URL` readiness/diagnostic dependencies remain for M6d.

### M6d — readiness/RPC decoupling

Code scope:

- remove Wallet API `PEPEW_API_BASE`, `CORE_RPC_URL`, `CORE_RPC_USER`, `CORE_RPC_PASS`, and `CORE_RPC_TIMEOUT*` usage;
- remove direct `getblockcount` readiness checks and `/healthz/rpc`, `/wallet/healthz/rpc`;
- make Wallet API `/readyz` depend on PEPEW Light API `GET /api/status` plus Telegram instead of `pepew-api :9193` and direct node RPC;
- keep `PEPEW_LIGHT_API_BASE` as the Bot chain-read dependency;
- do not remove `pepew-api` itself or its separate `/v1/tx/broadcast`, because other consumers may still use it.

Production acceptance (2026-09-29): retired RPC-health endpoint consumer check passed; wallet-api build and M3/M6a/M6b/M6c/M6d plus Web M2/M4/M5 regression checks passed; after restart `/healthz` passed, `/readyz` reported `pepewLight` + `telegram` with no `pepewApi` or `coreRpc`, retired `/healthz/rpc` routes returned 404, and Telegram `/balance` and `/history` passed. Production env cleanup and broader deploy/script documentation cleanup follow in M6e.

### M6e — deployment/config/script cleanup

Source scope:

- make the verified Git checkout deployment model authoritative for Wallet production;
- remove Wallet deploy/doctor assumptions about `/opt/.../current`, release symlinks, and Wallet `CORE_RPC_URL`;
- make Wallet deploy build/restart Wallet components only, without coupling to `pepew-api :9193`;
- align Wallet systemd templates and static webroot with the verified production paths;
- remove the retired explicit Nginx `/v1/history` compatibility route;
- keep fail-closed tombstones for raw-tx/direct-broadcast routes that could otherwise fall through;
- retain `pepew-api :9193` itself and its separate consumers.

Production acceptance (2026-09-29): retired Wallet legacy env keys were removed with a backup retained; Wallet API restarted successfully and `/readyz` reported only `pepewLight` + `telegram`; the updated Wallet doctor returned exit code 0; duplicate Nginx `api.pepepow.net` backup loading was removed; the active API vhost passed `nginx -t`; retired raw/broadcast/history paths were fail-closed with public 404 responses; Telegram `/balance` and `/history` passed.

Remaining M6 cleanup after M6d is deployment/config/script documentation cleanup and final production isolation acceptance (M6e/M6f).

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
