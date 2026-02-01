# Trade Bot (Telegram Interface) Documentation

The `trade-bot` provides a user-friendly interface for managing the trading suite via Telegram.

## Bot Commands

### Configuration Wizards
- `/dca`: Start the DCA setup wizard.
- `/grid`: Start the GRID setup wizard.
- `/mm`: Start the Market Maker setup wizard.

### Strategy Control
- `/dca_start` / `/dca_stop`: Control DCA strategies.
- `/grid_start` / `/grid_stop`: Control GRID strategies.
- `/mm_start` / `/mm_stop`: Control MM strategies.
- `/strategy_status`: View current performance and status of all active strategies.

### Key Management
- `/keys`: Manage your API keys (Add/View Status/Delete).
- `/keys_status`: Quick check of which exchanges have keys configured.

### Utilities
- `/price`: Get the current price of PEPEW/USDT.
- `/donate`: Show the project's donation address.
- `/help`: Show command list and usage instructions.

## Implementation Details

### Wizard Flow
The bot uses a **State Machine** approach to guide users through configurations.
1.  User starts a wizard (e.g., `/dca`).
2.  The bot stores the user's current "step" in memory.
3.  The bot uses **Inline Keyboards** for selections (Exchanges, Pairs) and **Text Input** for values (Amounts, Intervals).
4.  Each input is validated against minimum required amounts (e.g., balance check and minimum notional).

### Status Reporting
The `/strategy_status` command is the primary monitoring tool. It aggregates data from the `trade-api`:
- **Current Balances**: Fetched fresh from the exchange.
- **Strategy State**: Enabled/Disabled status and last action time.
- **Order Stats**: Count of open orders and recent fills (e.g., "Filled 5000 PEPEW in last 24h").
- **Failure Monitoring**: Displays any recent errors with a "Backoff" timer if applicable.

## Connectivity
The bot communicates with the `trade-api` via HTTP REST.
- `TRADE_API_BASE`: Must point to the reachable URL of the `trade-api` service.
- **Health Check**: On startup, the bot performs a `/healthz` check to ensure the backend is responsive.

## Configuration
See [services/trade-bot/.env.example](file:///home/ubuntu/pepepow-wallet-suite/services/trade-bot/.env.example) for required environment variables.
