# Nginx Rate Limit for pepew-api (Production)

**This is a production-grade example** for the public `pepew-api` only. Do **not** apply these limits to `wallet-api` unless you intentionally change its behavior.

## Example Configuration

Add the zones in the `http {}` block:

```nginx
# Global per-IP request rate (lightweight endpoints)
limit_req_zone $binary_remote_addr zone=pepew_api_light:10m rate=30r/s;

# Heavier endpoints (history/utxo/tx lookups)
limit_req_zone $binary_remote_addr zone=pepew_api_heavy:10m rate=5r/s;

# Optional: connection cap per IP
limit_conn_zone $binary_remote_addr zone=pepew_api_conn:10m;
```

Apply limits inside the `server {}` block that proxies to pepew-api:

```nginx
server {
    listen 443 ssl http2;
    server_name api.pepepow.net;

    # Default (light) limit for all pepew-api routes
    limit_req zone=pepew_api_light burst=60 nodelay;
    limit_conn pepew_api_conn 50;

    # Heavier endpoints get stricter limits
    location ~ ^/v1/(addr/[^/]+/(utxos|txs|balance)|utxos|history|tx/[^/]+|mempool/info)$ {
        limit_req zone=pepew_api_heavy burst=10 nodelay;
        proxy_pass http://127.0.0.1:9193;
    }

    # All other pepew-api routes
    location / {
        proxy_pass http://127.0.0.1:9193;
    }

    # Wallet API is handled separately and should have its own limits
    location /wallet/ {
        proxy_pass http://127.0.0.1:9194/;
    }
}
```

## Notes
- `limit_req_zone` defines a shared memory zone for rate limiting.
- Use **different zones** for heavy and light endpoints to avoid punishing health checks.
- Tune `rate` and `burst` based on observed traffic and cache hit ratio.
- Consider a stricter `burst` and lower `rate` for batch endpoints like `/v1/history` and `/v1/utxos`.
