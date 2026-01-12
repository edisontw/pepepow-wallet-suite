# PEPEW-API Integration Guide

The `pepew-api` is a high-performance indexer and proxy for the PEPEPOW blockchain. It provides read-only chain data required for wallet operations.

## Features
- Fast UTXO lookups.
- Address balance and transaction history.
- Chain height and network status.
- CORS-enabled for web wallet integration.

## Common Endpoints

### 1. Chain Height
- **URL**: `GET /v1/chain/height`
- **Description**: Returns the current block height.
- **Response**: `{ "height": 123456 }`

### 2. Address Balance
- **URL**: `GET /v1/address/:address/balance`
- **Description**: Returns total balance and UTXO count.
- **Response**:
  ```json
  {
    "address": "P...",
    "balance": 1500.25,
    "utxoCount": 5
  }
  ```

### 3. UTXOs (Unspent Transaction Outputs)
- **URL**: `GET /v1/address/:address/utxos`
- **Description**: Returns a list of available UTXOs for an address. Required for building transactions.
- **Response**:
  ```json
  [
    {
      "txid": "...",
      "vout": 0,
      "amount": 100.0,
      "height": 123450
    }
  ]
  ```

### 4. Transaction History
- **URL**: `GET /v1/address/:address/history`
- **Description**: paginated transaction history.

## Headers and Format
- **Content-Type**: `application/json`
- **CORS**: Responds to `OPTIONS` preflight requests with allowed origins from configuration.

## Rate Limiting
The API implements basic rate limiting to prevent abuse. If triggered, it returns `429 Too Many Requests`.

## Error Format
```json
{
  "error": "Not Found",
  "message": "Address not found",
  "statusCode": 404
}
```
