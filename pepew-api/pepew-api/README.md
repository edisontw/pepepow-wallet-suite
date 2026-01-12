# PEPEW API (Lightweight RPC Wrapper)

A lightweight REST API for the PEPEPOW blockchain node. It wraps JSON-RPC with:

- Fastify v4 HTTP API
- Swagger UI at `/docs`
- API key guard + rate limiting
- Optional Redis cache
- Optional ZMQ (rawblock) subscription for near-real-time height

## Requirements
- Node.js ≥ 20
- A running PEPEPOW node (daemon) with indexes enabled

## `PEPEPOW.conf` (example)
```ini
daemon=1
server=1
listen=1

rpcuser=change_this_user
rpcpassword=change_this_password
rpcallowip=127.0.0.1
rpcbind=127.0.0.1
rpcport=8093

txindex=1
addressindex=1
timestampindex=1
spentindex=1

zmqpubrawblock=tcp://127.0.0.1:28332
zmqpubrawtx=tcp://127.0.0.1:28333
```
> **Important:** Use strong credentials. Do **not** reuse passwords. Store secrets outside version control.

## Ports
| Component     | Port  | Purpose            |
|---------------|-------|--------------------|
| PEPEPOW RPC   | 8093  | Node JSON-RPC      |
| API Server    | 9193  | REST HTTP          |
| ZMQ (blocks)  | 28332 | rawblock publisher |
| ZMQ (tx)      | 28333 | rawtx publisher    |

## Quick Start
```bash
git clone https://github.com/edisontw/pepew-api
cd pepew-api
cp .env.example .env   # <-- EDIT .env to set RPC_USER/RPC_PASS/API_KEY, etc.
npm install
npm run build
node dist/index.js
# Browse: http://127.0.0.1:9193/docs
```

## `.env` Reference
| Key       | Default                 | Description                        |
|-----------|-------------------------|------------------------------------|
| RPC_URL   | http://127.0.0.1:8093   | PEPEPOW RPC endpoint               |
| RPC_USER  | (required)              | RPC username                       |
| RPC_PASS  | (required)              | RPC password                       |
| PORT      | 9193                    | API port                           |
| API_KEY   | change_this_api_key     | X-API-Key header                   |
| REDIS_URL | (empty)                 | redis://127.0.0.1:6379/0 (optional)|
| ZMQ_BLOCK | tcp://127.0.0.1:28332   | rawblock endpoint (optional)       |

## Project Structure
```
src/
  routes/           # endpoints
  security/         # API key + rate limit
  cache.ts          # in-memory cache
  redis.ts          # Redis wrapper (optional)
  rpc.ts            # RPC bridge
  zmq.ts            # rawblock subscription
  index.ts          # main entry
deploy/
  pepew-api.service # systemd unit (sample)
  nginx.conf        # nginx reverse proxy (sample)
```

## Endpoints (highlights)
- `GET /health` → `{ ok, height }`
- `GET /v1/chain/height` → `{ height }`
- `GET /v1/fee/estimate` → `{ feerate, source }`
- `GET /v1/tx/:txid`
- `POST /v1/tx/broadcast` → `{ txid }`
- `GET /v1/addr/:address/utxos`  
  - Prefers addressindex; fallback to `listunspent` (wallet/watch-only)
  - `?import=1[&rescan=1]` to auto-import address (rescan is heavy)
- `GET /v1/addr/:address/balance`  
  - Prefers addressindex; fallback to `listunspent`
- `GET /v1/mempool/info`
- `GET /v1/node/blockchaininfo`
- `GET /v1/node/indexinfo` (404 if not supported)
- Swagger UI: `GET /docs`

## Production (systemd)
```bash
sudo cp deploy/pepew-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pepew-api
journalctl -u pepew-api -f
```

## Notes
- If your node logs `ERROR: address index not enabled`, you must rebuild with `-reindex`
  after setting `addressindex=1`/`txindex=1`/`timestampindex=1`/`spentindex=1` in `PEPEPOW.conf`.
- Without addressindex, the API can still serve **wallet-owned or watch-only** addresses via `listunspent`.

## License
MIT
