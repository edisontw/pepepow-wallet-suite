# Trade Bot (Telegram Interface) Documentation

The `trade-bot` is the Telegram control plane for `trade-api`. It provides menu-driven setup and command aliases for DCA, GRID, MM, and DEVMM.

## Main Menu

After `/start`, the persistent keyboard shows:

- `Status`
- `Debug`
- `Price`
- `Strategy`
- `Report`
- `Stop`
- `API Keys`
- `Donation`

## Supported Commands

### Core
- `/start`: Open main menu.
- `/help`: Show command help.
- `/status`: Unified status (strategies + DevMM).
- `/debug`: DevMM diagnostics.
- `/report`: Period report across all exchanges.
- `/stop`: Stop strategies by exchange or all.
- `/price`: PEPEW price snapshot.
- `/donate`: Show donation address.

### Strategy Setup and Control
- `/strategy`: Open strategy menu.
- `/dca`, `/grid`, `/mm`, `/devmm`: Open setup/control wizards.
- `/dca_start`, `/dca_stop`, `/dca_status`
- `/grid_start`, `/grid_stop`
- `/mm_start`, `/mm_stop`
- `/devmm_start`, `/devmm_stop`

### API Key Management
- `/key`: Key shortcuts menu (`Set`, `Status`, `Clear`).
- `/keys`: Set keys wizard.
- `/keys_status`: Validate/check key status.
- `/keys_clear`: Clear keys by exchange.

### Legacy Aliases (Still Accepted)
- `/strategy_status` -> integrated into `/status`
- `/devmm_status` -> integrated into `/status`
- `/devmm_report` -> integrated into `/report`

## Wizard Behavior

- User flows are stateful (in-memory per Telegram user, about 15 minute TTL).
- Exchange/pair and discrete options use inline keyboards.
- Some steps accept text input:
  - DCA: quote per order, interval, budget cap, duration cap.
  - Keys: API key and API secret.
  - GRID/MM: optional numeric text input for some steps.
- Strategy creation is REAL mode only, with key checks and funds guards before activation.

## Monitoring and Reporting

- `/status` is the primary monitoring command.
  - Exchange balances (healthy/degraded state)
  - Active REAL strategies and runtime params
  - DevMM per-exchange summary and degraded flags
  - last update time
- `/report` asks for period (`daily`, `weekly`, `monthly`) and returns all exchanges in one report.
  - Compact mode hides zero-trade exchanges.
  - "Show all exchanges" expands hidden rows.

## Connectivity

The bot communicates with `trade-api` via HTTP REST.

- `TRADE_API_BASE`: must point to a reachable `trade-api` endpoint.
- Startup health check: bot calls `/healthz` and logs the result.

## Configuration

See [services/trade-bot/.env.example](../services/trade-bot/.env.example) for required environment variables.
