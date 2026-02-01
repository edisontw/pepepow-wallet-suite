import { Context } from "grammy";
import { safeSend } from "../utils/telegram.js";

const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PDep1ZNhCyqyRwjnQif8K6tPGsE7TvhyT6";

export async function handleStart(ctx: Context): Promise<void> {
    const message = [
        "🐸 PEPEPOW Trade Bot",
        "",
        "Welcome to the PEPEPOW DCA Trading Bot!",
        "",
        "This bot helps you set up Dollar Cost Averaging (DCA), GRID, and Market Making strategies for PEPEW tokens.",
        "",
        "Available Commands:",
        "• /price - View current PEPEW prices",
        "• /dca - Configure DCA (wizard)",
        "• /dca_start - Start DCA",
        "• /dca_stop - Stop DCA",
        "• /grid - Configure GRID (wizard)",
        "• /grid_start - Start GRID",
        "• /grid_stop - Stop GRID",
        "• /mm - Configure Market Maker (wizard)",
        "• /mm_start - Start MM",
        "• /mm_stop - Stop MM",
        "• /strategy_status - View all strategies",
        "• /keys - Set exchange API keys",
        "• /keys_status - View key status",
        "• /keys_clear - Clear exchange keys",
        "• /help - Show help and commands",
        "• /donate - Support development",
        "",
        "Donate Address:",
        `${DONATE_ADDRESS}`,
        "",
        "This bot is free to use. Consider donating to support development!",
    ].join("\n");

    await safeSend(ctx, { step: "start", text: message });
}

export async function handleHelp(ctx: Context): Promise<void> {
    const message = [
        "PEPEPOW Trade Bot Help",
        "",
        "Main Commands:",
        "• /dca - Set up Dollar-Cost Averaging",
        "• /grid - Set up Grid trading",
        "• /mm - Set up Market Making",
        "• /price - Check current prices",
        "• /strategy_status - View all active strategies",
        "• /keys - Configure exchange API keys",
        "• /keys_status - Check API key status",
        "",
        "Strategy Control:",
        "• /dca_start, /dca_stop - Start/stop DCA",
        "• /grid_start, /grid_stop - Start/stop GRID",
        "• /mm_start, /mm_stop - Start/stop MM",
        "",
        "",
        "Security recommendations:",
        "• Use trade-only API keys (no withdrawal permission)",
        "• Enable IP whitelist on your exchange account",
        "• Start with small amounts to test",
        "• Monitor your strategy regularly",
        "",
        "Supported Exchanges:",
        "• NonKYC (PEPEW/BNB, PEPEW/USDT)",
        "• Dex-Trade (PEPEW/USDT)",
        "• NestEx (PEPEW/USDT)",
        "",
        "Use /donate to support development!",
    ].join("\n");

    await safeSend(ctx, { step: "help", text: message });
}
