# API Defense Strategy: wallet-api vs pepew-api

This document focuses on operational defense and rate limiting. It complements `docs/security.md` without repeating the non-custodial principles.

## Threat Model Differences

### wallet-api
- Authenticated surface (Telegram JWT).
- Small number of write-capable product endpoints (profile binding, payment requests).
- Higher sensitivity per request (identity binding and product-state changes).
- Lower expected traffic volume.

### pepew-api
- Public read-only API with no user identity.
- High-volume, high-scan surface (address, tx, history queries).
- Primary DoS target due to public access and indexer cost.
- Serves external consumers beyond the wallet UI.

## Why pepew-api Needs Stricter Rate Limits
- It is the public entry point for chain data and will be scanned.
- Address and tx queries can be expensive (index lookups, cache misses).
- High-volume abuse affects explorer, wallet, and third-party integrations.
- Rate limiting reduces load amplification and protects the node/indexer.

## Endpoints Most Likely to be Abused

**pepew-api high-risk paths:**
- `/v1/addr/:address/utxos`
- `/v1/addr/:address/txs`
- `/v1/addr/:address/balance`
- `/v1/tx/:txid`
- `/v1/utxos` (batch)
- `/v1/history` (batch)
- `/v1/mempool/info`

**wallet-api high-risk paths:**
- `/auth/telegram` (initData validation + JWT issue)
- `/v1/resolve` (username/address probing)

## Cloudflare / Nginx / App Layer Responsibilities

**Cloudflare (edge):**
- Global WAF rules, bot filtering, DDoS protection.
- Global request rate caps to avoid volumetric spikes.

**Nginx (origin edge):**
- Path-based rate limits for pepew-api vs wallet-api.
- Restrict admin or debug endpoints if any are added.
- Enforce TLS and standard security headers.

**App layer (Node services):**
- JWT validation and user-specific limits.
- Input validation for product/control-plane inputs.
- Per-route rate limiting for auth/read/product-state flows.

## Relationship to `security.md`
- `security.md` defines non-custodial guarantees and user safety.
- This file defines **operational defenses** against abuse and load.
- Keep `security.md` authoritative for key custody and trust boundaries.
