# User Quick Start Guide

Welcome to the PepePow Trading Suite! This guide will help you get your first trading strategy up and running in minutes.

## Prerequisites

1.  **Telegram Account**: You'll interact with the suite via a Telegram bot.
2.  **Exchange API Keys**: You need an account and API keys (Key + Secret) for one of the supported exchanges:
    - **NonKYC** (Recommended)
    - **DEXTrade**
    - **NestEx**
3.  **PEPEW / USDT Balances**: Ensure you have enough funds on your exchange account for the strategy you intend to run.

## Step 1: Set Up Your API Keys

Before starting any strategy, you must provide your API keys so the bot can trade on your behalf.

1.  Open your Telegram bot and type `/keys`.
2.  Select your exchange from the list.
3.  The bot will ask for your **API Key**—paste it into the chat.
4.  The bot will then ask for your **API Secret**—paste it into the chat.
5.  *(Optional)* Type `/keys_status` to verify that your keys are correctly saved.

## Step 2: Configure a Strategy

Let's set up a basic **DCA (Dollar Cost Averaging)** strategy to accumulate PEPEW.

1.  Type `/dca` in the chat.
2.  **Exchange**: Select the exchange you just configured.
3.  **Pair**: Select `PEPEW/USDT`.
4.  **Budget**: Enter the amount of USDT you want to spend *per order* (e.g., `5`).
5.  **Interval**: Enter how often the bot should buy, in minutes (e.g., `60` for every hour).
6.  **Review**: Confirm the settings. The bot will automatically start the strategy for you.

## Step 3: Monitor Your Progress

You can check how your strategies are doing at any time.

1.  Type `/strategy_status`.
2.  The bot will reply with a detailed report including:
    - Your current USDT and PEPEW balances.
    - Active strategies and their last execution time.
    - Information about any recently filled orders.

## Step 4: Stopping a Strategy

If you want to pause or stop trading:

1.  Type `/dca_stop`.
2.  Select the strategy you want to stop.
3.  The bot will disable the strategy and cancel any remaining open orders on the exchange.

---

### Pro Tips
- **Min Notional**: Exchange orders usually have a minimum size (e.g., 1 USDT). If your budget is too small, the bot will warn you.
- **Donations**: Like the project? Support the developers by typing `/donate`.
- **Issues?**: Use `/help` to see the full list of commands or check the status for error messages.
