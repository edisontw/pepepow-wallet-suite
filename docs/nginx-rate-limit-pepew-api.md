# Nginx Rate Limit for pepew-api (Production)

**This is a production-grade example** for the public `pepew-api` entry host with conservative wallet-path protections. It is tuned for the current single-host deployment (`1 vCPU / 6 GB RAM`) and keeps `wallet-api` path ownership unchanged.

## Example Configuration

Add the zones in the `http {}` block, preferably via `/etc/nginx/conf.d/pepepow-rate-limit.conf` sourced from [ops/nginx/pepepow-rate-limit.conf](/home/ubuntu/pepepow-wallet-suite/ops/nginx/pepepow-rate-limit.conf):

```nginx
limit_req_status 429;
limit_conn_status 429;

log_format pepepow_api_timing
  '$remote_addr - $host [$time_local] '
  '"$request" status=$status bytes=$body_bytes_sent '
  'rt=$request_time urt=$upstream_response_time '
  'ustatus=$upstream_status';

limit_conn_zone $binary_remote_addr zone=api_per_ip_conn:10m;

limit_req_zone $binary_remote_addr zone=pepew_api_light:10m rate=8r/s;
limit_req_zone $binary_remote_addr zone=pepew_api_heavy:10m rate=2r/s;
limit_req_zone $binary_remote_addr zone=wallet_auth_ip:10m rate=6r/m;
limit_req_zone $binary_remote_addr zone=wallet_resolve_ip:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=wallet_request_ip:10m rate=15r/m;
limit_req_zone $binary_remote_addr zone=wallet_tx_ip:10m rate=2r/m;
```

Apply limits inside the `server {}` block that proxies to pepew-api:

```nginx
server {
    listen 443 ssl;
    server_name api.pepepow.net;

    access_log /var/log/nginx/pepepow-api.access.log pepepow_api_timing;
    client_max_body_size 256k;
    limit_conn api_per_ip_conn 20;

    location = /auth/telegram {
        limit_req zone=wallet_auth_ip burst=6 nodelay;
        proxy_pass http://127.0.0.1:9194;
    }

    location = /api/auth/telegram {
        limit_req zone=wallet_auth_ip burst=6 nodelay;
        proxy_pass http://127.0.0.1:9194;
    }

    location = /v1/resolve {
        limit_req zone=wallet_resolve_ip burst=10 nodelay;
        proxy_pass http://127.0.0.1:9194;
    }

    location = /v1/requests {
        limit_req zone=wallet_request_ip burst=10 nodelay;
        proxy_pass http://127.0.0.1:9194;
    }

    location ^~ /v1/requests/ {
        limit_req zone=wallet_request_ip burst=10 nodelay;
        proxy_pass http://127.0.0.1:9194;
    }

    # Heavier endpoints get stricter limits
    location ~ "^/v1/addr/[^/]+/(utxos|txs|balance)$" {
        limit_req zone=pepew_api_heavy burst=6 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }

    location = /v1/mempool/info {
        limit_req zone=pepew_api_heavy burst=6 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }

    location ~ "^/v1/tx/[0-9A-Fa-f]{64}$" {
        limit_req zone=pepew_api_heavy burst=6 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }

    location = /v1/tx/broadcast {
        limit_req zone=wallet_tx_ip burst=3 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }

    location ^~ /v1/chain/ {
        limit_req zone=pepew_api_light burst=24 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }

    location = /v1/fee/estimate {
        limit_req zone=pepew_api_light burst=24 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }
}
```

## Notes
- `limit_req_zone` defines a shared memory zone for rate limiting.
- Use different zones for heavy and light endpoints to avoid punishing health checks.
- `POST /v1/tx/broadcast` stays public only for compatibility and should be reviewed after sync completes.
- Keep these limits conservative during `pepepowd -reindex`; only relax them after observing low `429` rates and stable latency.

## Validation

```bash
sudo nginx -t
sudo nginx -T | rg 'pepepow_api_timing|limit_req_zone|wallet_tx_ip|pepew_api_heavy'
curl -fsS https://api.pepepow.net/healthz
curl -fsS https://api.pepepow.net/v1/chain/height
curl -fsS https://api.pepepow.net/v1/mempool/info
```

Short local burst to confirm `429` without high load:

```bash
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" https://api.pepepow.net/v1/mempool/info
done
```

## Rollback

```bash
sudo rm -f /etc/nginx/conf.d/pepepow-rate-limit.conf
sudo cp /path/to/known-good/pepepow-api /etc/nginx/sites-available/pepepow-api
sudo cp /path/to/known-good/pepepow-api /etc/nginx/sites-enabled/pepepow-api
sudo nginx -t
sudo systemctl reload nginx
```
