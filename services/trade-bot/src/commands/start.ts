import { Context } from "grammy";
import { safeSend } from "../utils/telegram.js";
import { sendMainMenu } from "./mainMenu.js";

const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PDep1ZNhCyqyRwjnQif8K6tPGsE7TvhyT6";

export async function handleStart(ctx: Context): Promise<void> {
    const intro = [
        "PEPEPOW Trade Bot",
        "",
        "Use the menu buttons below to manage strategy setup, status, reports, stop actions, and API keys.",
    ].join("\n");
    await sendMainMenu(ctx, intro);
}

export async function handleHelp(ctx: Context): Promise<void> {
    const message = [
        "PEPEPOW Trade Bot Help",
        "",
        "Main menu commands:",
        "• /start - Open main menu",
        "• /strategy - Strategy menu",
        "• /status - Unified status (strategy + DevMM)",
        "• /report - Period + exchange report",
        "• /stop - Stop strategies by exchange",
        "• /key - Key shortcuts (/keys, /keys_status, /keys_clear)",
        "• /price - Check current prices",
        "• /donate - Donation address",
        "",
        "Strategy wizards:",
        "• /dca, /grid, /mm, /devmm",
        "• Legacy alias: /strategy_status, /devmm_status, /devmm_report",
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
        `Donate Address: ${DONATE_ADDRESS}`,
    ].join("\n");

    await safeSend(ctx, { step: "help", text: message });
    await sendMainMenu(ctx);
}
