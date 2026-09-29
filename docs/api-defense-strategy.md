# API Defense Strategy

This document covers operational defense and rate limiting for the Wallet control plane, PEPEW Light API data plane, and the separate legacy pepew-api surface. Non-custodial guarantees remain authoritative in `docs/security.md`.

## Service boundaries

### wallet-api :9194

Purpose: Telegram/product control plane.

Characteristics:

- Telegram/JWT-authenticated product surface.
- Stores only minimal product metadata such as public address bindings and payment requests.
- Does not provide Wallet balance/UTXO/history/raw-tx/broadcast chain routes.
- Does not use direct pepepowd RPC.
- Higher sensitivity per authenticated state-changing request, but lower expected traffic volume.

High-risk examples:

- `POST /auth/telegram`
- `POST /api/auth/telegram`
- `GET /v1/resolve`
- payment request / claim routes
- default-address binding changes

### PEPEW Light API

Purpose: Wallet blockchain data plane.

Base:

```text
https://light.pepepow.net
```

Wallet contract:

```text
GET  /api/wallet/address/{address}
GET  /api/wallet/history/{address}
GET  /api/wallet/utxo/{address}
GET  /api/wallet/tx/{txid}
POST /api/wallet/broadcast
```

Characteristics:

- public chain-data queries;
- potentially high-volume address/history/UTXO/tx access;
- accepts only already-signed raw transactions for broadcast;
- must enforce input validation, request-size limits, rate limits, bounded timeouts, and safe error handling;
- must never receive mnemonic/private-key/signing requests.

An uncertain broadcast POST must not be blindly retried.

### legacy pepew-api :9193

Purpose: separate legacy/public compatibility service for non-Wallet consumers.

Characteristics:

- may expose legacy chain read/broadcast compatibility paths;
- may depend on node RPC/Redis/ZMQ;
- remains a separate operational security surface;
- new Wallet features must not depend on it.

Its Nginx rate-limit policy remains documented separately in `docs/nginx-rate-limit-pepew-api.md`.

## Defense layers

### Edge / CDN

- DDoS mitigation and bot filtering.
- Global request-rate controls.
- TLS enforcement.
- Avoid exposing private ElectrumX or pepepowd interfaces.

### Nginx

- Route Wallet control-plane paths to `:9194`.
- Keep retired Wallet chain routes absent or fail-closed with explicit 404 tombstones where broader legacy routes could otherwise catch them.
- Apply service-appropriate rate limits.
- Validate configuration before reload with `nginx -t`.
- Avoid duplicate active vhosts or backup files under `sites-enabled`.

### Application layer

wallet-api:

- validate Telegram `initData`;
- validate JWTs;
- rate-limit auth and product-state operations;
- validate public addresses and product inputs;
- never log secrets or recovery material.

PEPEW Light API:

- validate addresses/txids/raw transaction size and encoding;
- apply bounded upstream timeouts;
- rate-limit expensive read and broadcast paths;
- treat broadcast uncertainty carefully and do not automatically retry;
- return safe errors without leaking infrastructure secrets.

## Boundary rule

The operational defense model must preserve the architecture boundary:

```text
Wallet identity/product state -> wallet-api :9194
Wallet chain data/broadcast   -> PEPEW Light API
Other legacy consumers        -> pepew-api :9193 (separate)
```

Do not solve an availability problem by reintroducing Wallet direct RPC or legacy Wallet chain proxy dependencies.

## Relationship to security.md

- `docs/security.md` defines key custody, signing, and trust boundaries.
- This file defines abuse/load defenses and service separation.
- `docs/runtime.md` defines current production runtime and operational checks.
