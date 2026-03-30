# pepew-api

`pepew-api` is the public chain-read service for the PEPEPOW ecosystem. It sits in front of the core node and exposes a small HTTP interface for blockchain lookups that are safe to share publicly.

It is designed for:

- chain height and readiness checks
- fee estimation
- transaction lookup
- address balance, UTXO, and history reads
- raw transaction broadcast

It is not designed for:

- Telegram authentication
- user profile or address binding
- payment requests
- private key handling
- wallet state management

Those wallet-facing concerns belong to `wallet-api`.

## Public Base URL

- Public host: `https://api.pepepow.net`
- Local service port: `http://127.0.0.1:9193`
- Swagger UI: `https://api.pepepow.net/docs`

## Public Routing Model

`api.pepepow.net` is a path-split host.

Some routes on the host belong to `pepew-api`, while others belong to `wallet-api`. This split is intentional and should remain stable so the web wallet and Telegram wallet keep working without changes.

### Public `pepew-api` routes on `api.pepepow.net`

- `GET /health`
- `GET /healthz`
- `GET /readyz`
- `GET /docs`
- `GET /v1/chain/height`
- `GET /v1/fee/estimate`
- `GET /v1/addr/:address/balance`
- `GET /v1/addr/:address/utxos`
- `GET /v1/addr/:address/txs`
- `GET /v1/tx/:txid`
- `POST /v1/tx/broadcast`
- `GET /v1/mempool/info`

### Public routes on the same host that belong to `wallet-api`

- `POST /auth/telegram`
- `POST /api/auth/telegram`
- `/wallet/*`
- `/api/*`
- `/tg/*`
- `GET /v1/whoami`
- `POST /v1/profile/upsert`
- `GET|POST /v1/address/default`
- `GET /v1/resolve`
- `POST /v1/requests`
- `GET /v1/requests/:id`
- `POST /v1/requests/:id/claim`
- `POST /v1/history`
- `GET /v1/price`
- `GET /v1/tx/raw/:txid`

Important: `POST /v1/history` on the public host is a `wallet-api` compatibility route. It is not the public entry point for `pepew-api`.

## Endpoints Intentionally Not Public

The following `pepew-api` capabilities remain local or internal-only:

- `POST /v1/history`
- `POST /v1/utxos`
- `GET /v1/node/blockchaininfo`
- `GET /v1/node/indexinfo`
- `POST /v1/wallet/importaddress`
- `GET /v1/wallet/listunspent`

This keeps the public surface narrow and avoids exposing node-management or wallet-watch-only operations.

## Endpoint Notes

### Health and readiness

- `GET /health` returns a basic health response and current block height when available.
- `GET /healthz` is the public liveness endpoint.
- `GET /readyz` verifies service dependencies and is the best endpoint for load balancers and operational monitoring.

### Chain height

- `GET /v1/chain/height` returns the current PEPEPOW block height.

Example:

```json
{ "height": 4303307 }
```

### Fee estimate

- `GET /v1/fee/estimate` returns a fee rate estimate for wallet send flows.
- If the node cannot provide a fresh smart-fee estimate, a fallback value may be returned.

### Address reads

- `GET /v1/addr/:address/balance` returns the balance for one address.
- `GET /v1/addr/:address/utxos` returns spendable outputs for one address.
- `GET /v1/addr/:address/txs` returns recent address history.

These routes are the public read-chain contract expected by the wallet architecture.

### Transaction lookup and broadcast

- `GET /v1/tx/:txid` returns a verbose transaction view.
- `POST /v1/tx/broadcast` submits a signed raw transaction to the network.

Broadcast requests must already be fully signed by the client. `pepew-api` does not sign transactions.

### Mempool status

- `GET /v1/mempool/info` returns basic mempool information from the connected node.

## Authentication

`pepew-api` is intended to be a public read service.

- If no API key is configured, public routes can be called without credentials.
- If an API key is configured, callers must send:

```http
x-api-key: <api-key>
```

This protection applies to the service routes themselves, including `/docs`.

## Rate Limiting

Public traffic is rate limited to protect the node and keep wallet traffic stable.

General behavior:

- a default global rate limit applies to the service
- stricter route-level limits apply to heavier or more sensitive operations

Typical stricter routes include:

- `GET /v1/fee/estimate`
- `POST /v1/tx/broadcast`

If a limit is exceeded, the service returns `429 Too Many Requests`.

## CORS

The service is CORS-enabled for approved wallet frontends.

Allowed origins are intended for the official web wallet and related public properties. Third-party integrations should not assume broad wildcard CORS access.

## Relationship With `wallet-api`

The two services serve different roles:

- `pepew-api` is the public blockchain read layer
- `wallet-api` is the wallet control plane for Telegram auth, wallet bindings, payment requests, and broadcast-related compatibility routes

The web wallet and Telegram wallet do not rely on direct access to every `pepew-api` route. They intentionally keep using `wallet-api` for wallet-domain flows such as:

- authentication
- payment requests
- default address management
- compatibility history batching on `/v1/history`
- wallet-specific read proxies under `/wallet/*`

## Operational Notes

- Public health checks for `pepew-api` use `/healthz` and `/readyz` on `api.pepepow.net`.
- Wallet-specific health checks use `/wallet/healthz` and `/wallet/readyz`.
- If `GET /v1/chain/height` or `GET /docs` returns `404` on the public host, the issue is usually Nginx path routing, not the `pepew-api` process itself.
- Local service checks should use `http://127.0.0.1:9193`.

## Example Requests

### Health

```bash
curl -sS https://api.pepepow.net/healthz
curl -sS https://api.pepepow.net/readyz
```

### Chain reads

```bash
curl -sS https://api.pepepow.net/v1/chain/height
curl -sS https://api.pepepow.net/v1/fee/estimate
curl -sS https://api.pepepow.net/v1/mempool/info
```

### Address reads

```bash
curl -sS https://api.pepepow.net/v1/addr/<ADDRESS>/balance
curl -sS https://api.pepepow.net/v1/addr/<ADDRESS>/utxos
curl -sS "https://api.pepepow.net/v1/addr/<ADDRESS>/txs?limit=20"
```

### Transaction lookup and broadcast

```bash
curl -sS https://api.pepepow.net/v1/tx/<TXID>
curl -sS -X POST https://api.pepepow.net/v1/tx/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"rawtx":"<SIGNED_RAW_TX>"}'
```

## Compatibility Notice

Do not assume that every `/v1/*` route on `api.pepepow.net` belongs to `pepew-api`.

In particular:

- `/v1/history` is public `wallet-api`
- `/v1/price` is public `wallet-api`
- `/v1/address/default` is public `wallet-api`
- `/v1/resolve` is public `wallet-api`
- `/v1/requests*` is public `wallet-api`

When documenting or integrating against the public host, always describe the path ownership explicitly.
