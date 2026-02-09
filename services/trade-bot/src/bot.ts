import { Bot } from "grammy";
import { ApiError, getApiBase, getHealth } from "./api.js";
import { handleStart, handleHelp } from "./commands/start.js";
import { handleDonate } from "./commands/donate.js";
import { handlePrice } from "./commands/price.js";
import {
    handleDca,
    handleDcaSet,
    handleDcaStart,
    handleDcaStop,
    handleDcaStatus,
    handleDcaCallback,
    handleDcaTextInput,
} from "./commands/dca.js";
import {
    handleGrid,
    handleGridStart,
    handleGridStop,
    handleGridCallback,
    handleGridTextInput,
} from "./commands/grid.js";
import {
    handleMm,
    handleMmStart,
    handleMmStop,
    handleMmCallback,
    handleMmTextInput,
} from "./commands/mm.js";
import {
    handleDevmm,
    handleDevmmStart,
    handleDevmmStop,
    handleDevmmCallback,
    handleDevmmTextInput,
} from "./commands/devmm.js";
import {
    handleStrategyMenu,
    handleStrategyMenuCallback,
    handleStrategyStatus,
    handleDevmmStatusAlias,
    handleStatus,
} from "./commands/strategy.js";
import {
    handleKeys,
    handleKeysStatus,
    handleKeysClear,
    handleKeysCallback,
    handleKeysTextInput,
} from "./commands/keys.js";
import { handleMainMenuCallback } from "./commands/menu.js";
import { handleReport, handleReportCallback, handleDevmmReportAlias } from "./commands/report.js";
import { handleStop, handleStopCallback } from "./commands/stop.js";
import { handleKey, handleKeyCallback } from "./commands/key.js";

const requiredEnv = ["TRADE_BOT_TOKEN", "TRADE_API_BASE"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`[trade-bot] Missing environment variables: ${missingEnv.join(", ")}`);
    // Suggest systemd env file fix
    console.error(`[trade-bot] Please verify /etc/pepepow/pepepow-trade-bot.env has KEY=VALUE format (no 'export', no space around '=', LF line endings).`);
    process.exit(1);
}

const BOT_TOKEN = process.env.TRADE_BOT_TOKEN!;

// Log masked token
const maskToken = (t: string) => (t.length > 10 ? `${t.substring(0, 4)}...${t.substring(t.length - 4)}` : "***");
console.log(`[trade-bot] TRADE_BOT_TOKEN=${maskToken(BOT_TOKEN)}`);

// 本 bot 僅使用純文字訊息，禁止全域 parse_mode，避免 Telegram entity parse errors
const bot = new Bot(BOT_TOKEN);

console.log(`[trade-bot] TRADE_API_BASE=${getApiBase()}`);

// Register commands
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("donate", handleDonate);
bot.command("price", handlePrice);
bot.command("dca", handleDca);
bot.command("dca_set", handleDcaSet);
bot.command("dca_start", handleDcaStart);
bot.command("dca_stop", handleDcaStop);
bot.command("dca_status", handleDcaStatus);
bot.command("grid", handleGrid);
bot.command("grid_start", handleGridStart);
bot.command("grid_stop", handleGridStop);
bot.command("mm", handleMm);
bot.command("mm_start", handleMmStart);
bot.command("mm_stop", handleMmStop);
bot.command("devmm", handleDevmm);
bot.command("devmm_start", handleDevmmStart);
bot.command("devmm_stop", handleDevmmStop);
bot.command("status", handleStatus);
bot.command("strategy_status", handleStrategyStatus);
bot.command("devmm_status", handleDevmmStatusAlias);
bot.command("report", handleReport);
bot.command("devmm_report", handleDevmmReportAlias);
bot.command("stop", handleStop);
bot.command("key", handleKey);
bot.command("strategy", handleStrategyMenu);
bot.command("keys", handleKeys);
bot.command("keys_status", handleKeysStatus);
bot.command("keys_clear", handleKeysClear);

bot.on("callback_query:data", async (ctx) => {
    const raw = ctx.callbackQuery?.data || "";
    const uid = String(ctx.from?.id || ctx.callbackQuery?.from?.id || "");
    const parts = raw.split(":");
    const scope = parts[0] || "unknown";
    const action = parts[1] || "unknown";
    const value = parts.slice(2).join(":");
    const maybeExchange = value === "nonkyc" || value === "dextrade" || value === "nestex" || value === "all" ? value : "n/a";
    const strategy = scope === "mm" || scope === "grid" || scope === "dca" || scope === "devmm" ? scope.toUpperCase() : "n/a";
    console.log(
        `[trade-bot] callback userId=${uid || "unknown"} action=${scope}:${action} exchange=${maybeExchange} strategy=${strategy} params=${value || "n/a"}`
    );

    if (await handleMainMenuCallback(ctx)) return;
    if (await handleReportCallback(ctx)) return;
    if (await handleStopCallback(ctx)) return;
    if (await handleKeyCallback(ctx)) return;
    if (await handleKeysCallback(ctx)) return;
    if (await handleStrategyMenuCallback(ctx)) return;
    if (await handleDcaCallback(ctx)) return;
    if (await handleGridCallback(ctx)) return;
    if (await handleMmCallback(ctx)) return;
    if (await handleDevmmCallback(ctx)) return;
    await ctx.answerCallbackQuery();
});

bot.on("message:text", async (ctx) => {
    if (await handleKeysTextInput(ctx)) return;
    if (await handleDcaTextInput(ctx)) return;
    if (await handleGridTextInput(ctx)) return;
    if (await handleMmTextInput(ctx)) return;
    if (await handleDevmmTextInput(ctx)) return;
});

// Error handler
bot.catch((err) => {
    console.error("[trade-bot] Error:", err.message || err);
});

// Start polling
console.log("[trade-bot] Starting bot...");
bot.start({
    onStart: (botInfo) => {
        console.log(`[trade-bot] Bot started: @${botInfo.username}`);
    },
});

// Non-blocking trade-api connectivity check
void (async () => {
    try {
        const health = await getHealth();
        if (health.ok) {
            console.log("[trade-bot] Trade API health check OK");
            return;
        }
        console.warn(`[trade-bot] Trade API health check failed: ${health.error || health.message || "unknown error"}`);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.warn(`[trade-bot] Trade API health check error: ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            return;
        }
        console.warn(`[trade-bot] Trade API health check error: ${err?.message || err}`);
    }
})();
