# Nginx Hardening and Security Guide

This guide provides a minimal but robust set of configurations to protect the PEPEPOW Wallet Suite backend and static frontend.

## 1. HTTPS and TLS

Always serve the wallet over HTTPS. Use Let's Encrypt for automatic certificate management.

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name wallet.example.com;
    return 301 https://$host$request_uri;
}
```

## 2. Essential Security Headers

Add these headers to your `server` block to mitigate common web attacks.

```nginx
# Prevent browsers from MIME-sniffing
add_header X-Content-Type-Options nosniff always;

# Prevent clickjacking
add_header X-Frame-Options SAMEORIGIN always;

# Enable HSTS (1 year)
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# Referrer Policy
add_header Referrer-Policy "no-referrer-when-downgrade" always;
```

## 3. Restricting Sensitive Paths

Blocks access to `.env`, `.git`, and other potentially sensitive files.

```nginx
location ~ /\.(env|git|htaccess|ssh) {
    deny all;
    access_log off;
    log_not_found off;
}
```

## 4. Rate Limiting

Define rate limits in the `http` context to prevent Brute-force and DoS attacks.

```nginx
# In nginx.conf or top-level http block:
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

# In your server/location block:
location /v1/ {
    limit_req zone=api_limit burst=20 nodelay;
    proxy_pass http://127.0.0.1:9193;
}
```

## 5. Request Body and Buffers

Prevent large, malicious payloads.

```nginx
# Limits request body size (adjust based on transaction size)
client_max_body_size 1M;

# Timeout settings
client_body_timeout 12;
client_header_timeout 12;
keepalive_timeout 15;
send_timeout 10;
```

## 6. Implementation

To apply these without breaking your existing site:
1. Copy the `nginx/*.example.conf` templates.
2. Replace placeholders with your actual domains and paths.
3. Test the configuration: `sudo nginx -t`.
4. Reload Nginx: `sudo systemctl reload nginx`.
