# Exchange API Debug Guide

This document explains how to enable debug logging for exchange API calls and troubleshoot common issues.

## Environment Variables

Enable debug mode for each exchange:

| Exchange | Environment Variable | Description |
|----------|---------------------|-------------|
| NonKYC | `NONKYC_DEBUG=1` | Log full request/response details |
| Dex-Trade | `DEXTRADE_DEBUG=1` | Log signature components |
| NestEx | `NESTEX_DEBUG=1` | Log request body (secrets masked) |

## What Gets Logged

When debug mode is enabled, the following information is logged (secrets are **always** masked):

### NonKYC
```
[nonkyc:debug] request: {
  "method": "POST",
  "url": "https://api.nonkyc.io/api/v2/createorder",
  "headers": {
    "Content-Type": "application/json",
    "X-API-KEY": "abcd...wxyz",
    "X-API-NONCE": "1706419234567",
    "X-API-SIGN": "1234...5678"
  },
  "body": { "symbol": "PEPEW_BNB", "side": "buy", ... }
}
[nonkyc:debug] canonical (masked): abcd...wxyz + https://api.nonkyc.io/api/v2/createorder + {"symbol"...} + 1706419234567
```

### Dex-Trade
```
[dextrade:debug] signature values: ["PEPEW_USDT", "0", "10000", ...]
[dextrade:debug] sign payload (masked): PEPEW_USDT01000... + abcd...wxyz
```

### NestEx
```
[nestex:debug] request: {
  "url": "https://trade.nestex.one/api/v2/placelimitorder",
  "method": "POST",
  "body": { "apikey": "abcd...wxyz", "apisecret": "1234...5678", ... }
}
```

## Self-Test Script

Run the self-test to verify API connectivity:

```bash
# Build first
cd /home/ubuntu/pepepow-wallet-suite/services/trade-api
npm run build

# Test NonKYC
NONKYC_API_KEY=your_key NONKYC_API_SECRET=your_secret \
  node dist/scripts/selftest-exchanges.js --exchange=nonkyc

# Test with debug output
NONKYC_API_KEY=your_key NONKYC_API_SECRET=your_secret \
  node dist/scripts/selftest-exchanges.js --exchange=nonkyc --debug

# Test all exchanges
node dist/scripts/selftest-exchanges.js --all --debug
```

## Generating curl Commands

For NonKYC, the debug output includes a curl command (secrets masked) that you can use for manual testing:

```bash
# The selftest script prints this on failure:
curl -X GET 'https://api.nonkyc.io/api/v2/balances' \
  -H 'Content-Type: application/json' \
  -H 'X-API-KEY: abcd...wxyz' \
  -H 'X-API-NONCE: 1706419234567' \
  -H 'X-API-SIGN: 1234...5678'
```

## Common Error Categories

| Category | Description | How to Fix |
|----------|-------------|------------|
| `AUTH_FAILED` | Invalid API key/secret | Verify credentials in `/keys` |
| `SIGNATURE_MISMATCH` | HMAC calculation error | Regenerate API keys |
| `IP_BLOCKED` | IP not whitelisted | Add server IP in exchange |
| `KEY_EXPIRED` | API key expired | Generate new keys |
| `PERMISSION_DENIED` | No trade permission | Enable trading on API key |
| `RATE_LIMIT` | Too many requests | Will auto-backoff |
| `ENDPOINT_CHANGED` | 404 on known endpoint | Report as bug |

## Troubleshooting

### NonKYC 403 Forbidden

1. **Check API key**: Make sure the key is valid and not expired
2. **Check IP whitelist**: NonKYC may require IP whitelisting
3. **Check permissions**: Ensure the key has "trade" permission enabled
4. **Check nonce**: Nonce must be increasing (we use Unix timestamp in ms)

### Dex-Trade Auth Issues

1. **Check login-token**: This is different from the API key
2. **Check request_id**: Must be incrementing (we use microsecond timestamp)
3. **Check signature**: Values must be sorted alphabetically by key

### NestEx Auth Issues

1. **Check body format**: `apikey` and `apisecret` must be in POST body, NOT headers
2. **Check rate limit**: Minimum 5 seconds between requests per user
3. **Check endpoint**: Should use `https://trade.nestex.one/api/v2/`

## Viewing Logs in Production

```bash
# Watch trade-api logs
journalctl -u pepepow-trade-api.service -f

# View recent logs with debug
sudo systemctl stop pepepow-trade-api.service
NONKYC_DEBUG=1 node /home/ubuntu/pepepow-wallet-suite/services/trade-api/dist/server.js

# Or add to systemd override
sudo systemctl edit pepepow-trade-api.service
# Add: Environment="NONKYC_DEBUG=1"
sudo systemctl restart pepepow-trade-api.service
```
