# Trade API Service Documentation

The `trade-api` is the core execution engine of the PepePow Trading Suite. It handles strategy logic, exchange connectivity, and data persistence.

## API Specification

The API is structured around versioned endpoints (v1).

### 1. Strategy Management (`/v1/strategy`)
- `POST /v1/strategy/upsert`: Create or update a strategy configuration.
- `POST /v1/strategy/enable`: Enable or disable a strategy.
- `GET /v1/strategy/status`: Fetch comprehensive status for one or all strategies (includes balances, open orders, and recent fills).
- `POST /v1/strategy/funds_check`: Validate if the account has enough funds for a proposed strategy.
- `POST /v1/strategy/cancel_orders`: Cancel all open orders for a specific strategy and pair.

### 2. DCA Specific (`/v1/dca`)
- `POST /v1/dca/set`: Shortcut for configuring a DCA strategy.
- `POST /v1/dca/start`: Start a DCA execution loop.
- `POST /v1/dca/stop`: Stop a DCA execution loop and cancel its orders.
- `GET /v1/dca/status`: Fetch specific status for DCA strategies.

### 3. Key Management (`/v1/keys`)
- `POST /v1/keys/set`: Encrypt and store API keys for an exchange.
- `GET /v1/keys/status`: Check if keys are set for a user/exchange.
- `POST /v1/keys/clear`: Securely remove API keys.

## Database Schema (SQLite)

The database (`trade.db`) contains the following key tables:
- **`strategy_config`**: Stores user-defined parameters for DCA, GRID, and MM.
- **`strategy_failure`**: Tracks errors and failures for debugging and auto-disabling.
- **`order_logs`**: History of all orders placed by the system.
- **`fills`**: Records of successfully filled orders.
- **`encrypted_keys`**: Secure storage for exchange credentials.
- **`grid_orders`**: Specific tracking for GRID levels and status.

## Internal Logic

### Scheduler
The scheduler runs at a fixed 10-second interval. In each interval, it:
1.  Queries the DB for all `enabled=1` strategies.
2.  Groups strategies by type and invokes the corresponding runner.
3.  Ensures runners complete before the next tick starts (using an execution lock).

### Exchange Adapters
Adapters are located in `src/exchanges/`. Each adapter implements a common interface for:
- Fetching ticker price.
- Fetching account balances.
- Creating limit/market orders.
- Listing/Cancelling open orders.

## Configuration
See [services/trade-api/.env.example](file:///home/ubuntu/pepepow-wallet-suite/services/trade-api/.env.example) for required environment variables.
