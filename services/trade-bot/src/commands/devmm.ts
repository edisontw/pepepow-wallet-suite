/**
 * DevMM Telegram Bot Commands
 * 
 * Commands for managing the Dev Fee Market Making strategy via Telegram.
 * All responses use plain text only (no HTML/Markdown parse_mode).
 */

import { Context, InlineKeyboard } from "grammy";
import { ApiError, devmmStart, devmmStop, devmmStatus, devmmReport, DevmmStatusEntry, DevmmReportEntry } from "../api.js";
import { renderMenu } from "../utils/menu.js";
import { safeSend, sendLongText } from "../utils/telegram.js";
import { sendMainMenu, withMenuNav } from "./mainMenu.js";

type ExchangeName = "nonkyc" | "dextrade" | "nestex";

// State for wizard flow
interface DevmmWizardState {
    step: "exchange";
    updatedAt: number;
}

const pendingDevmm = new Map<string, DevmmWizardState>();
const WIZARD_TTL_MS = 15 * 60 * 1000;
const DEVMM_EXCHANGE_ALIASES: Record<string, ExchangeName> = {
    nonkyc: "nonkyc",
    dextrade: "dextrade",
    "dex-trade": "dextrade",
    nestex: "nestex",
};

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function isExpired(state: DevmmWizardState): boolean {
    return Date.now() - state.updatedAt > WIZARD_TTL_MS;
}

function normalizeDevmmExchange(value: string | undefined): ExchangeName | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    return DEVMM_EXCHANGE_ALIASES[normalized] || null;
}

function exchangeLabel(exchange: string): string {
    const clean = exchange === "dex-trade" ? "dextrade" : exchange;
    const labels: Record<ExchangeName, string> = {
        nonkyc: "NonKYC",
        dextrade: "Dex-Trade (Unavailable)",
        nestex: "NestEx",
    };
    return labels[clean as ExchangeName] || exchange;
}

function formatDateTime(ts: number | null | undefined): string {
    if (!ts) return "n/a";
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatNumber(value: number | null | undefined, decimals = 4): string {
    if (value === null || value === undefined) return "n/a";
    return value.toFixed(decimals);
}

function formatUsdt(value: number | null | undefined): string {
    if (value === null || value === undefined) return "n/a";
    const abs = Math.abs(value);
    const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return value.toFixed(decimals);
}

function stripHtml(text: string | null | undefined): string {
    if (!text) return "";
    // Remove tags
    let clean = text.replace(/<[^>]*>/g, " ");
    // Convert entity &nbsp; to space
    clean = clean.replace(/&nbsp;/g, " ");
    // Remove consecutive whitespaces
    clean = clean.replace(/\s+/g, " ").trim();
    // Truncate to reasonable length for TG
    if (clean.length > 200) {
        return clean.slice(0, 200) + "...";
    }
    return clean;
}

// Build callback data with prefix to avoid collision with other strategies
function buildCallbackData(action: string, value: string): string {
    // Standard literal values for core actions
    if (action === "menu") return `devmm:${value}`;
    if (action === "start") return `devmm:start:${value}`;
    if (action === "stop") return `devmm:stop:${value}`;
    if (action === "report") return `devmm:report:${value}`;

    return `devmm:${action}:${value}`.slice(0, 64);
}

function parseCallbackData(data: string): { action: string; value: string } | null {
    if (!data.startsWith("devmm:")) return null;
    const parts = data.slice(6).split(":");
    return { action: parts[0] || "", value: parts.slice(1).join(":") };
}

// /devmm - Show menu
export async function handleDevmm(ctx: Context): Promise<void> {
    const keyboard = withMenuNav(new InlineKeyboard()
        .text("Start", "devmm:start").row()
        .text("Start All", buildCallbackData("start", "all")).row()
        .text("Stop", "devmm:stop").row()
        .text("Stop All", buildCallbackData("stop", "all")));

    await safeSend(ctx, {
        step: "devmm_menu",
        text: renderMenu("🤖 DevMM Control", "Choose what to manage:"),
        replyMarkup: keyboard,
    });
}

// /devmm_start [exchange] - Start wizard or direct start
export async function handleDevmmStart(ctx: Context): Promise<void> {
    const args = (ctx.message?.text || "").split(/\s+/).slice(1);
    const exchangeArg = args[0];
    const exchange = normalizeDevmmExchange(exchangeArg);

    if (exchange) {
        // Direct start with exchange
        await startDevmmOnExchange(ctx, exchange);
        return;
    }

    // Show exchange selection
    const tgUserId = getTgUserId(ctx);
    pendingDevmm.set(tgUserId, { step: "exchange", updatedAt: Date.now() });

    const keyboard = withMenuNav(new InlineKeyboard()
        .text("NonKYC", buildCallbackData("start", "nonkyc")).row()
        .text("NestEx", buildCallbackData("start", "nestex")));

    await safeSend(ctx, {
        step: "devmm_start_select",
        text: renderMenu("🏦 Select Exchange", "DevMM start target\nNonKYC / NestEx"),
        replyMarkup: keyboard,
    });
}

async function startDevmmOnExchange(
    ctx: Context,
    exchange: ExchangeName,
    options: { showMainMenu?: boolean } = {}
): Promise<void> {
    const showMainMenu = options.showMainMenu !== false;
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, {
            step: "devmm_start_no_user",
            text: "Unable to determine your user ID.",
        });
        return;
    }

    try {
        const res = await devmmStart({ exchange, tgUserId });
        if (!res.ok) {
            await safeSend(ctx, {
                step: "devmm_start_error",
                text: `Failed to start DevMM: ${res.error || "Unknown error"}`,
            });
            return;
        }

        const cfg = res.config;
        let msg = `DevMM started on ${exchangeLabel(exchange)}\n\n`;
        if (cfg) {
            const effectiveOrderQuoteUsdt = Number(
                cfg.effectiveOrderQuoteUsdt ??
                (exchange === "nestex" ? 1 : cfg.orderQuoteUsdt)
            );
            msg += `Symbol: ${cfg.symbol || "PEPEW/USDT"}\n`;
            msg += `Order size: ${formatUsdt(effectiveOrderQuoteUsdt)} USDT\n`;
            msg += `Min notional: ${formatUsdt(cfg.minNotionalUsdt)} USDT\n`;
            msg += `Buy offset: -${(cfg.buyOffsetPct * 100).toFixed(1)}%\n`;
            msg += `Sell offset: +${(cfg.sellOffsetPct * 100).toFixed(1)}%\n`;
            msg += `Refresh: ${cfg.refreshSeconds}s\n`;
        }

        await safeSend(ctx, { step: "devmm_start_success", text: msg });
        if (showMainMenu) await sendMainMenu(ctx);
    } catch (err: any) {
        const msg = err instanceof ApiError ? `API error: ${err.message}` : `Error: ${err.message}`;
        await safeSend(ctx, { step: "devmm_start_exception", text: msg });
        if (showMainMenu) await sendMainMenu(ctx);
    }
}

// /devmm_stop [exchange] - Stop DevMM
export async function handleDevmmStop(ctx: Context): Promise<void> {
    const args = (ctx.message?.text || "").split(/\s+/).slice(1);
    const exchangeArg = args[0]?.toLowerCase();

    if (exchangeArg && ["nonkyc", "dextrade", "nestex"].includes(exchangeArg)) {
        await stopDevmmOnExchange(ctx, exchangeArg as ExchangeName);
        return;
    }

    // Show exchange selection
    const keyboard = withMenuNav(new InlineKeyboard()
        .text("NonKYC", buildCallbackData("stop", "nonkyc")).row()
        .text("NestEx", buildCallbackData("stop", "nestex")).row()
        .text("Stop All", buildCallbackData("stop", "all")));

    await safeSend(ctx, {
        step: "devmm_stop_select",
        text: renderMenu("🏦 Select Exchange", "DevMM stop target\nNonKYC / NestEx"),
        replyMarkup: keyboard,
    });
}

async function stopDevmmOnExchange(
    ctx: Context,
    exchange: ExchangeName,
    options: { showMainMenu?: boolean } = {}
): Promise<void> {
    const showMainMenu = options.showMainMenu !== false;
    try {
        const res = await devmmStop(exchange);
        if (!res.ok) {
            await safeSend(ctx, {
                step: "devmm_stop_error",
                text: `Failed to stop DevMM: ${res.error || "Unknown error"}`,
            });
            return;
        }

        let msg = `DevMM stopped on ${exchangeLabel(exchange)}\n`;
        if (res.ordersVisibleBefore !== undefined) {
            msg += `Open before stop: ${res.ordersVisibleBefore}\n`;
        }
        if (res.ordersAttempted !== undefined) {
            msg += `Cancel attempts: ${res.ordersAttempted}\n`;
        }
        if (res.ordersCancelled !== undefined) {
            msg += `Orders cancelled: ${res.ordersCancelled}\n`;
        }
        if (res.ordersAlreadyClosed !== undefined && res.ordersAlreadyClosed > 0) {
            msg += `Already closed: ${res.ordersAlreadyClosed}\n`;
        }
        if (res.ordersFailed !== undefined && res.ordersFailed > 0) {
            msg += `Failed to cancel: ${res.ordersFailed}\n`;
        }

        await safeSend(ctx, { step: "devmm_stop_success", text: msg });
        if (showMainMenu) await sendMainMenu(ctx);
    } catch (err: any) {
        const msg = err instanceof ApiError ? `API error: ${err.message}` : `Error: ${err.message}`;
        await safeSend(ctx, { step: "devmm_stop_exception", text: msg });
        if (showMainMenu) await sendMainMenu(ctx);
    }
}

// /devmm_status - Show status (no parameters)
export async function handleDevmmStatus(ctx: Context): Promise<void> {
    // Check if user provided a parameter (now deprecated)
    let hasParam = false;
    if (ctx.message?.text) {
        const parts = ctx.message.text.trim().split(/\s+/);
        if (parts.length > 1) {
            hasParam = true;
        }
    }

    try {
        // Always fetch all exchanges (no filtering by exchange param)
        const res = await devmmStatus(undefined);

        if (!res.ok) {
            await safeSend(ctx, {
                step: "devmm_status_error",
                text: `Failed to get status: ${res.error || "Unknown error"}`,
            });
            return;
        }

        if (!res.exchanges || res.exchanges.length === 0) {
            await safeSend(ctx, {
                step: "devmm_status_empty",
                text: "No DevMM configurations found.",
            });
            return;
        }

        let msg = "";

        // Show warning if user tried to use deprecated parameter
        if (hasParam) {
            msg += "⚠️ Parameter removed. Use /devmm_status directly.\n\n";
        }

        msg += "DevMM Status\n" + "─".repeat(20) + "\n";
        // Always show all three exchanges
        for (const exName of ["nonkyc", "dextrade", "nestex"] as ExchangeName[]) {
            const entry = res.exchanges?.find(e => e.exchange === exName);
            if (entry) {
                msg += formatStatusSummary(entry) + "\n";
            } else {
                msg += `${exchangeLabel(exName)}: STOP\n`;
            }
        }

        // Always use sendLongText which uses reply (never editMessageText)
        await sendLongText(ctx, msg, { step: "devmm_status_result", maxLen: 3000 });
    } catch (err: any) {
        const msg = err instanceof ApiError ? `API error: ${err.message}` : `Error: ${err.message}`;
        await safeSend(ctx, { step: "devmm_status_exception", text: msg });
    }
}

function formatStatusSummary(entry: DevmmStatusEntry): string {
    const ex = exchangeLabel(entry.exchange as ExchangeName);
    // Shorten status display
    let status = entry.status || "STOP";
    if (status === "STOPPED") status = "STOP";
    if (status === "NOT_CONFIGURED") status = "STOP";

    // Build compact info parts
    const parts: string[] = [];

    // Mid price (scientific notation, 2 digits)
    if (entry.market?.mid) {
        parts.push(`mid=${entry.market.mid.toExponential(2)}`);
    }

    // Inventory (USDT only)
    if (entry.inventory && !("status" in entry.inventory) && entry.inventory.usdtBalance !== null) {
        parts.push(`inv=${formatNumber(entry.inventory.usdtBalance, 1)}U`);
    }

    // Open orders count
    let orderCount = 0;
    if (entry.orders?.buyOrderId) orderCount++;
    if (entry.orders?.sellOrderId) orderCount++;
    parts.push(`open=${orderCount}`);

    // Time since last action
    if ((status === "ACTIVE" || status === "DEGRADED" || status === "PAUSED") && entry.lastActionAt) {
        const ageSec = Math.max(0, Math.round((Date.now() - entry.lastActionAt) / 1000));
        parts.push(`${ageSec}s`);
    }

    // Note (pause reason or error, max 40 chars, no HTML)
    let note = "";
    if (entry.pauseReason) {
        note = stripHtml(entry.pauseReason).slice(0, 40);
    } else if (entry.lastErrorCode) {
        note = stripHtml(entry.lastErrorCode).slice(0, 40);
    } else if (entry.lastDecision) {
        const decisionText = String(entry.lastDecision);
        const skipMatch = decisionText.match(/SKIP_TICK:([A-Z0-9_]+)/);
        const skippedSideMatch = decisionText.match(/SKIPPED:([A-Z+]+)/);
        if (skipMatch?.[1]) {
            note = skipMatch[1].slice(0, 40);
        } else if (skippedSideMatch?.[1]) {
            note = `SKIPPED_${skippedSideMatch[1]}`.slice(0, 40);
        }
    }
    if (note) {
        parts.push(note);
    }

    const infoStr = parts.length > 0 ? " " + parts.join(" ") : "";
    return `${ex}: ${status}${infoStr}`;
}

function formatStatusEntry(entry: DevmmStatusEntry): string {
    let msg = `[${exchangeLabel(entry.exchange as ExchangeName)}]\n`;
    msg += `Status: ${entry.status}`;
    if (entry.pauseReason) {
        msg += ` (${entry.pauseReason})`;
    }
    msg += "\n";

    if (entry.status === "NOT_CONFIGURED") {
        return msg;
    }

    if (entry.requestedExchange || entry.normalizedExchange || entry.resolvedExchange || entry.adapterKey) {
        const requested = entry.requestedExchange || entry.exchange;
        const normalized = entry.normalizedExchange || requested;
        const resolved = entry.resolvedExchange || entry.exchange;
        msg += `Requested exchange: ${exchangeLabel(requested)}\n`;
        msg += `Normalized exchange: ${exchangeLabel(normalized as ExchangeName)}\n`;
        msg += `Resolved exchange: ${exchangeLabel(resolved as ExchangeName)}\n`;
        msg += `Adapter key: ${entry.adapterKey || resolved}\n`;
    }

    if (entry.config) {
        const effectiveOrderQuoteUsdt = entry.config.effectiveOrderQuoteUsdt ?? entry.config.orderQuoteUsdt;
        msg += `Order: ${formatUsdt(effectiveOrderQuoteUsdt)} USDT\n`;
        msg += `Offsets: BUY -${(entry.config.buyOffsetPct * 100).toFixed(1)}% / SELL +${(entry.config.sellOffsetPct * 100).toFixed(1)}%\n`;
    }

    if (entry.turnover) {
        const pctUsed = entry.turnover.capDayUsdt > 0
            ? ((entry.turnover.todayUsdt / entry.turnover.capDayUsdt) * 100).toFixed(1)
            : "0";
        msg += `Turnover: ${formatNumber(entry.turnover.todayUsdt, 2)} / ${formatNumber(entry.turnover.capDayUsdt, 2)} USDT (${pctUsed}%)\n`;
    }

    if (entry.inventory) {
        if ("status" in entry.inventory && entry.inventory.status === "unavailable") {
            msg += `Inventory: (unavailable: ${entry.inventory.reason || "unknown"})\n`;
        } else if (!("status" in entry.inventory)) {
            msg += `Inventory: ${formatNumber(entry.inventory.usdtBalance, 2)} USDT + ${formatNumber(entry.inventory.pepewBalance, 0)} PEPEW\n`;
            if (entry.inventory.usdtShare !== null && entry.inventory.usdtShare !== undefined) {
                msg += `USDT share: ${(entry.inventory.usdtShare * 100).toFixed(1)}%\n`;
            }
        }
    }

    if (entry.market && entry.market.mid) {
        const spreadPct = entry.market.spread ? (entry.market.spread * 100).toFixed(3) : "n/a";
        msg += `Mid: ${entry.market.mid.toExponential(4)} (spread ${spreadPct}%)\n`;
    }

    if (entry.orders) {
        if (entry.orders.buyOrderId || entry.orders.sellOrderId) {
            msg += `Orders: BUY=${entry.orders.buyOrderId || "none"}, SELL=${entry.orders.sellOrderId || "none"}\n`;
        }
    }

    if (entry.cooldownUntil && entry.cooldownUntil > Date.now()) {
        const remaining = Math.round((entry.cooldownUntil - Date.now()) / 1000);
        msg += `Cooldown: ${remaining}s remaining\n`;
    }

    if (entry.lastAction) {
        if (entry.lastActionAt) {
            const ageSec = Math.max(0, Math.round((Date.now() - entry.lastActionAt) / 1000));
            msg += `Last: ${entry.lastAction} (${ageSec}s ago)\n`;
        } else {
            msg += `Last: ${entry.lastAction} at ${formatDateTime(entry.lastActionAt)}\n`;
        }
    }

    if (entry.lastErrorCode || entry.lastErrorMessage) {
        const code = entry.lastErrorCode || entry.lastError || "UNKNOWN";
        const rawMessage = entry.lastErrorMessage && entry.lastErrorMessage !== code ? entry.lastErrorMessage : "";
        const message = rawMessage ? ` (${stripHtml(rawMessage)})` : "";
        msg += `Error: ${code}${message} at ${formatDateTime(entry.lastErrorAt)}\n`;
    } else if (entry.lastError) {
        msg += `Error: ${stripHtml(entry.lastError)} at ${formatDateTime(entry.lastErrorAt)}\n`;
    }
    if (entry.balanceLastOkTs) {
        msg += `Balance lastOk: ${formatDateTime(entry.balanceLastOkTs)} (age ${entry.balanceLastOkAgeSec ?? "n/a"}s)\n`;
    }
    if (entry.balanceLastErrCode) {
        msg += `Balance lastErrCode: ${entry.balanceLastErrCode}\n`;
    }

    return msg;
}

// /devmm_report [exchange] [period] - Show trading report
export async function handleDevmmReport(ctx: Context): Promise<void> {
    const args = (ctx.message?.text || "").split(/\s+/).slice(1);
    const exchangeArg = args[0];
    const periodArg = args[1]?.toLowerCase();

    try {
        const params: { exchange?: ExchangeName; period?: "daily" | "weekly" | "monthly" } = {};

        const exchange = normalizeDevmmExchange(exchangeArg);
        if (exchange) {
            params.exchange = exchange;
        }

        if (periodArg && ["daily", "weekly", "monthly"].includes(periodArg)) {
            params.period = periodArg as "daily" | "weekly" | "monthly";
        }

        const res = await devmmReport(Object.keys(params).length > 0 ? params : undefined);
        if (!res.ok) {
            await safeSend(ctx, {
                step: "devmm_report_error",
                text: `Failed to get report: ${res.error || "Unknown error"}`,
            });
            return;
        }

        if (!res.reports || res.reports.length === 0) {
            await safeSend(ctx, {
                step: "devmm_report_empty",
                text: "No report data available.",
            });
            return;
        }

        let msg = "DevMM Report\n" + "=".repeat(40) + "\n\n";

        for (const report of res.reports) {
            msg += formatReportEntry(report);
            msg += "\n";
        }

        await safeSend(ctx, { step: "devmm_report_result", text: msg });
    } catch (err: any) {
        const msg = err instanceof ApiError ? `API error: ${err.message}` : `Error: ${err.message}`;
        await safeSend(ctx, { step: "devmm_report_exception", text: msg });
    }
}

function formatReportEntry(report: DevmmReportEntry): string {
    let msg = `[${exchangeLabel(report.exchange as ExchangeName)}] ${report.period}`;
    if (report.bucket) {
        msg += ` (${report.bucket})`;
    }
    msg += "\n";

    if (report.message) {
        msg += `  ${report.message}\n`;
        return msg;
    }

    if (report.fillCount !== undefined) {
        msg += `Fills: ${report.fillCount}\n`;
    }
    if (report.totalTurnoverUsdt !== undefined) {
        msg += `Turnover: ${formatNumber(report.totalTurnoverUsdt, 2)} USDT\n`;
        msg += `  BUY: ${formatNumber(report.buyTurnoverUsdt, 2)} USDT (${formatNumber(report.buyQtyPepew, 0)} PEPEW)\n`;
        msg += `  SELL: ${formatNumber(report.sellTurnoverUsdt, 2)} USDT (${formatNumber(report.sellQtyPepew, 0)} PEPEW)\n`;
    }
    if (report.overallVwap) {
        msg += `VWAP: ${report.overallVwap.toExponential(4)}\n`;
    }
    if (report.totalFeeUsdt) {
        msg += `Fees: ${formatNumber(report.totalFeeUsdt, 4)} USDT\n`;
    }
    if (report.netUsdtChange !== undefined) {
        const sign = report.netUsdtChange >= 0 ? "+" : "";
        msg += `Net USDT: ${sign}${formatNumber(report.netUsdtChange, 2)}\n`;
    }
    if (report.netPepewChange !== undefined) {
        const sign = report.netPepewChange >= 0 ? "+" : "";
        msg += `Net PEPEW: ${sign}${formatNumber(report.netPepewChange, 0)}\n`;
    }

    return msg;
}

// Callback query handler
export async function handleDevmmCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith("devmm")) return false;

    console.log(`[trade-bot] DevMM callback received: data=${data}`);

    try {
        await ctx.answerCallbackQuery().catch(e => console.warn(`[trade-bot] ACK failed: ${e.message}`));
    } catch (err) {
        // Ignored
    }

    // Literal matching for core actions
    if (data === "devmm:start") {
        return handleMenuCallback(ctx, "start");
    }
    if (data === "devmm:stop") {
        return handleMenuCallback(ctx, "stop");
    }
    if (data === "devmm:status") {
        await safeSend(ctx, {
            step: "devmm.status.redirect",
            text: "ℹ️ DevMM status has been integrated into /status.",
        });
        await sendMainMenu(ctx);
        return true;
    }
    if (data === "devmm:report") {
        await safeSend(ctx, {
            step: "devmm.report.redirect",
            text: "ℹ️ DevMM report has been integrated into /report.",
        });
        await sendMainMenu(ctx);
        return true;
    }

    // Pattern matching for parameterized actions
    const parsed = parseCallbackData(data);
    if (!parsed) {
        // Fallback for unknown devmm actions
        await ctx.answerCallbackQuery({ text: `DevMM: unknown action <${data}>` }).catch(() => { });
        await ctx.reply(`DevMM: unknown action <${data}>`).catch(() => { });
        console.warn(`[trade-bot] Unknown DevMM callback data: ${data}`);
        return true;
    }

    const { action, value } = parsed;
    console.log(`[trade-bot] DevMM parsed callback: action=${action} value=${value}`);

    try {
        switch (action) {
            case "menu": // Backward compatibility if any old buttons remain
                return handleMenuCallback(ctx, value);
            case "start":
                if (value === "all") {
                    for (const ex of ["nonkyc", "dextrade", "nestex"] as ExchangeName[]) {
                        await startDevmmOnExchange(ctx, ex, { showMainMenu: false });
                    }
                    await sendMainMenu(ctx);
                    return true;
                }
                if (["nonkyc", "dextrade", "nestex"].includes(value)) {
                    await startDevmmOnExchange(ctx, value as ExchangeName);
                    return true;
                }
                break;
            case "stop":
                if (value === "all") {
                    for (const ex of ["nonkyc", "dextrade", "nestex"] as ExchangeName[]) {
                        await stopDevmmOnExchange(ctx, ex, { showMainMenu: false });
                    }
                    await sendMainMenu(ctx);
                    return true;
                }
                if (["nonkyc", "dextrade", "nestex"].includes(value)) {
                    await stopDevmmOnExchange(ctx, value as ExchangeName);
                    return true;
                }
                break;
            case "status":
                await safeSend(ctx, {
                    step: "devmm.status.alias",
                    text: "ℹ️ DevMM status has been integrated into /status.",
                });
                await sendMainMenu(ctx);
                return true;
            case "report":
                await safeSend(ctx, {
                    step: "devmm.report.alias",
                    text: "ℹ️ DevMM report has been integrated into /report.",
                });
                await sendMainMenu(ctx);
                return true;
        }
    } catch (err: any) {
        console.error(`[trade-bot] DevMM callback crash: ${err.message}`);
        await ctx.reply(`DevMM error: ${err.message}`).catch(() => { });
    }

    console.warn(`[trade-bot] Unhandled DevMM callback: action=${action} value=${value}`);
    return true;
}

async function handleMenuCallback(ctx: Context, value: string): Promise<boolean> {
    switch (value) {
        case "start":
            // Show exchange selection
            const keyboard = withMenuNav(new InlineKeyboard()
                .text("NonKYC", buildCallbackData("start", "nonkyc")).row()
                .text("NestEx", buildCallbackData("start", "nestex")));
            await safeSend(ctx, {
                step: "devmm_menu_start",
                text: renderMenu("🏦 Select Exchange", "DevMM start target\nNonKYC / NestEx"),
                replyMarkup: keyboard,
            });
            return true;

        case "stop":
            // Show exchange selection for stop
            const stopKeyboard = withMenuNav(new InlineKeyboard()
                .text("NonKYC", buildCallbackData("stop", "nonkyc")).row()
                .text("NestEx", buildCallbackData("stop", "nestex")).row()
                .text("Stop All", buildCallbackData("stop", "all")));
            await safeSend(ctx, {
                step: "devmm_menu_stop",
                text: renderMenu("🏦 Select Exchange", "DevMM stop target\nNonKYC / NestEx"),
                replyMarkup: stopKeyboard,
            });
            return true;
    }

    return false;
}

// Text input handler (for potential future use)
export async function handleDevmmTextInput(ctx: Context): Promise<boolean> {
    const tgUserId = getTgUserId(ctx);
    const state = pendingDevmm.get(tgUserId);

    if (!state || isExpired(state)) {
        pendingDevmm.delete(tgUserId);
        return false;
    }

    // Currently no text input needed for DevMM wizard
    // All interactions are via inline keyboard

    return false;
}
