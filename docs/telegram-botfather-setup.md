# Telegram BotFather Setup

This guide is for operators setting up the PEPEPOW Wallet Telegram bot.

## 1) Create the Bot
1. Open Telegram and chat with `@BotFather`.
2. Run `/newbot`.
3. Provide a display name (e.g., `PEPEPOW Wallet`).
4. Provide a username ending with `bot` (e.g., `pepepow_walletbot`).
5. Save the bot token returned by BotFather.

Set `BOT_TOKEN` in the wallet-api environment (`/etc/pepepow/pepepow-wallet-api.env`).

## 2) Set Commands
In BotFather:
1. Run `/setcommands` and choose your bot.
2. Paste the command list below:

```
start - Open wallet and see options
balance - Check your wallet balance
deposit - Get your deposit address
send - Send PEPEW (via Mini App)
help - Show help and security notes
```

## 3) Configure the Menu Button (Web App)
1. In BotFather, run `/setmenubutton`.
2. Choose your bot.
3. Select **Web App**.
4. Set the URL to the Mini App:
   - `https://wallet.pepepow.net/mini`

## 4) Configure the Webhook (with secretToken)
The bot uses a webhook endpoint served by `wallet-api`:
- `POST /tg/webhook`

Set the webhook using the Telegram API and include a secret token:

```bash
curl -sS -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.pepepow.net/tg/webhook",
    "secret_token": "<BOT_SECRET_TOKEN>"
  }'
```

Notes:
- `BOT_SECRET_TOKEN` must match the `x-telegram-bot-api-secret-token` header that Telegram sends.
- Store `BOT_SECRET_TOKEN` in the wallet-api environment file.

Verify:
```bash
curl -sS "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo" | jq .
```

## Common Errors and Fixes

### 401 Unauthorized (auth/telegram)
- The Mini App did not pass a valid `initData`.
- Ensure the request is made from inside Telegram WebApp.

### initData missing
- The Mini App is opened in a normal browser, not inside Telegram.
- Open the wallet from the bot or a Telegram chat button.

### Webhook 403
- `BOT_SECRET_TOKEN` mismatch or missing.
- Update the webhook secret and the wallet-api env file to match.

### Mini App gate / blank screen
- Telegram WebApp only exposes `initData` on mobile (and the official client).
- Test on Telegram mobile app and ensure the WebApp URL is correct.
