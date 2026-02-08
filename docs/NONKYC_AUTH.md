# NonKYC Exchange API Authentication Spec

This document describes the correct authentication method for NonKYC private API endpoints, derived from the official NonKYC sample repositories.

## Sources

- [NonKYCExchange/nonkycapinodehmac](https://github.com/NonKYCExchange/nonkycapinodehmac) - Official HMAC example
- [NonKYCExchange/nonkycapinode](https://github.com/NonKYCExchange/nonkycapinode) - Official Basic Auth example

## Base URL

```
https://api.nonkyc.io/api/v2
```

> **Important**: The subdomain is `api.nonkyc.io`, not `nonkyc.io`!

## Authentication Methods

NonKYC supports two authentication methods:

### 1. Basic Auth (Simpler)

```javascript
const auth = "Basic " + Buffer.from(apiKey + ":" + apiSecret).toString("base64");
headers["Authorization"] = auth;
```

### 2. HMAC-SHA256 (More Secure) ← We use this

Headers required:
- `X-API-KEY`: Your API key
- `X-API-NONCE`: Unix timestamp in milliseconds
- `X-API-SIGN`: HMAC-SHA256 signature (hex encoded)

## Signature Formula

```
signature = HMAC-SHA256(
    apiKey + fullUrl + JSON.stringify(body) + nonce,
    apiSecret
).digest("hex")
```

### Example

```javascript
const apiKey = "abc123...";
const apiSecret = "secret456...";
const fullUrl = "https://api.nonkyc.io/api/v2/createorder";
const body = { symbol: "PEPEW_BNB", side: "buy", type: "limit", quantity: 1000, price: 0.0001 };
const nonce = "1706419234567";

const canonical = apiKey + fullUrl + JSON.stringify(body) + nonce;
// = "abc123...https://api.nonkyc.io/api/v2/createorder{\"symbol\":\"PEPEW_BNB\"...}1706419234567"

const signature = crypto.createHmac("sha256", apiSecret).update(canonical).digest("hex");
```

## Endpoints

### Private Endpoints (require auth)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/balances` | GET | Account balances |
| `/createorder` | POST | Place order |
| `/cancelorder` | POST | Cancel order |
| `/getorders` | GET | List orders |
| `/gettrades` | GET | Trade history |

### Create Order

**Endpoint**: `POST /createorder`

**Body**:
```json
{
  "symbol": "PEPEW_BNB",
  "side": "buy",
  "type": "limit",
  "quantity": 1000000,
  "price": 0.0000001,
  "userProvidedId": "optional-client-id",
  "strictValidate": false
}
```

### Cancel Order

**Endpoint**: `POST /cancelorder`

**Body**:
```json
{
  "id": "order-uuid-here"
}
```

## Testing with curl

```bash
# Set variables
API_KEY="your_api_key"
API_SECRET="your_api_secret"
NONCE=$(date +%s%3N)
URL="https://api.nonkyc.io/api/v2/balances"

# Calculate signature (requires openssl)
CANONICAL="${API_KEY}${URL}${NONCE}"
SIGNATURE=$(echo -n "$CANONICAL" | openssl dgst -sha256 -hmac "$API_SECRET" | cut -d' ' -f2)

# Make request
curl -X GET "$URL" \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: $API_KEY" \
  -H "X-API-NONCE: $NONCE" \
  -H "X-API-SIGN: $SIGNATURE"
```

## Common Issues

1. **403 Forbidden**: Usually signature mismatch or wrong base URL
2. **Invalid Signature**: Check canonical string matches exactly
3. **Nonce expired**: Nonce should be recent (within a few minutes)

## Time Precision

- Nonce is in **milliseconds** (13 digits)
- Server allows some clock drift (a few minutes)
