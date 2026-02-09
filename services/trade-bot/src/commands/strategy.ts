import { Context, InlineKeyboard } from "grammy";
import { ApiError, devmmStatus, DevmmStatusEntry, getStrategyStatus, StrategyConfig, StrategyFill } from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { safeText, truncateText } from "../utils/strings.js";
import { ExchangeName } from "../lib/markets.js";
import { handleDca } from "./dca.js";
import { handleGrid } from "./grid.js";
import { handleMm } from "./mm.js";
import { handleDevmm } from "./devmm.js";
import { sendMainMenu } from "./mainMenu.js";

function exchangeLabel(exchange: ExchangeName): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade";
    return "NestEX";
}

function formatDateTime(ts: number | null | undefined): string {
    if (!ts || !Number.isFinite(ts)) return "-";
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function trimNumberString(value: string): string {
    return value.replace(/(?:\.0+|(\.\\d+?)0+)$/, "$1");
}

function formatQuantity(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    if (abs < 1e-8) return value.toExponential(6);
    return trimNumberString(value.toPrecision(10));
}

function formatPrice(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
    const abs = Math.abs(value);
    if (abs < 1e-8) return value.toExponential(6);
    return trimNumberString(value.toPrecision(12));
}

/**
 * Format interval in human-readable form: 10m, 1h 30m, etc.
 */
function formatInterval(sec: number | null | undefined): string {
    if (!sec || !Number.isFinite(sec) || sec <= 0) return "-";
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatTimeAgo(ts: number): string {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    const hours = Math.floor(sec / 3600);
    return `${hours}h ago`;
}

const STRATEGY_CALLBACK_PREFIX = "strategy:";
const STRATEGY_CALLBACK_MAX_BYTES = 64;

function buildStrategyCallback(action: string, value: string): string {
    const data = `${STRATEGY_CALLBACK_PREFIX}${action}:${value}`;
    if (Buffer.byteLength(data, "utf8") > STRATEGY_CALLBACK_MAX_BYTES) {
        return `${STRATEGY_CALLBACK_PREFIX}invalid`;
    }
    return data;
}

async function safeAnswerCallbackQuery(ctx: Context, step: string): Promise<void> {
    try {
        await ctx.answerCallbackQuery();
    } catch (err: any) {
        console.error(`[strategy] ${step} answerCallbackQuery failed: ${err?.message || err}`);
    }
}

/**
 * Get quote unit from pair string (e.g., "PEPEW/BNB" -> "BNB")
 */
function getQuoteFromPair(pair: string): string {
    const parts = pair.split("/");
    return parts.length > 1 ? parts[1] : "";
}

/**
 * Format compact params line for each strategy type
 * Output: "spread 5% | order 4 USDT/side | refresh 15s | last 2026-01-27 13:31"
 */
function formatCompactParams(config: StrategyConfig, sharedBalance?: { freeUSDT: number; freePEPEW: number } | null): string {
    const params = (config.params || {}) as Record<string, any>;
    const lastRun = formatDateTime(config.lastRunAt);
    const quote = getQuoteFromPair(config.pair);

    if (config.strategy === "DCA") {
        const budget = params.budget ?? "?";
        const intervalSec = params.intervalSec ?? params.interval_sec ?? 600;
        const interval = formatInterval(intervalSec);
        const lastFilled = params.lastFilledQuote ? ` | lastFilled ${params.lastFilledQuote.toFixed(4)} ${quote}` : "";
        const openBuy = params.openBuy !== undefined ? ` | openBuy ${params.openBuy}` : "";
        return `budget ${budget} ${quote} | every ${interval}${lastFilled}${openBuy} | last ${lastRun}`;
    }

    if (config.strategy === "GRID") {
        const levels = params.grid_levels ?? "?";
        const step = params.grid_step_pct !== undefined
            ? `${formatQuantity(params.grid_step_pct * 100)}%`
            : "?";
        const budget = params.total_quote_budget ?? "?";
        const openOrders = params.open_orders_count ?? 0;
        const placedBuy = params.placed_buy ?? 0;
        const placedSell = params.placed_sell ?? 0;
        const lastAction = params.last_action ?? "";

        // Show status for GRID
        let statusLine = `levels ${levels} | step ${step} | budget ${budget} ${quote} | last ${lastRun}`;

        if (lastAction && (lastAction.startsWith("GRID tick ok:") || lastAction.startsWith("GRID:"))) {
            // Recognize both old and new format
            const cleanAction = lastAction.replace(/^GRID( tick ok)?: /, "");
            statusLine += `\n   ✓ ${cleanAction}`;
        } else if (openOrders > 0) {
            statusLine += `\n   ✓ trackedOrders=${openOrders} (buy=${placedBuy}, sell=${placedSell})`;
        }

        // Show skip reasons if any
        const skipReasons = params.skip_reasons || [];
        if (skipReasons.length > 0) {
            statusLine += `\n   skip: ${skipReasons[0]}`;
        }

        return statusLine;
    }

    if (config.strategy === "MM") {
        const spread = params.spread_pct !== undefined
            ? `${formatQuantity(params.spread_pct * 100)}%`
            : "?";
        const quotePerOrder = params.quote_per_order ?? params.order_quote ?? 2;
        const ordersPerSide = params.orders_per_side ?? 1;
        const totalPerSide = quotePerOrder * ordersPerSide;
        const refresh = params.refresh_sec ?? 15;
        const mode = params.mode ?? "TWO_SIDED";
        const openOrders = params.open_orders_count ?? 0;
        const placedBuy = params.placed_buy ?? 0;
        const placedSell = params.placed_sell ?? 0;
        const lastAction = params.last_action ?? "";

        let statusLine = `spread ${spread} | quote/order ${quotePerOrder} ${quote} | orders/side ${ordersPerSide} | total/side ${totalPerSide} ${quote}\n   refresh ${formatInterval(refresh)} | mode ${mode} | last ${lastRun}`;

        // Show placement info
        if (lastAction && lastAction.startsWith("PLACED")) {
            statusLine += `\n   ✓ placed buy=${placedBuy} sell=${placedSell}`;
        } else if (openOrders > 0) {
            statusLine += `\n   openOrders=${openOrders}`;
        }

        // Show skip reasons if any
        let skipReasons = (params.skip_reasons || []) as string[];

        // Final override: if shared balance or config-specific balance says we HAVE enough, don't show "have 0"
        if (skipReasons.length > 0 && skipReasons[0].includes("NO_INVENTORY")) {
            const isBuy = skipReasons[0].includes("BUY");
            const isSell = skipReasons[0].includes("SELL");

            // Use config-specific inventory if available, otherwise fallback to shared
            const inv = config.currentInventory || (sharedBalance ? {
                USDT: sharedBalance.freeUSDT,
                PEPEW: sharedBalance.freePEPEW
            } : null);

            if (inv) {
                if (isBuy && inv.USDT > 0) {
                    skipReasons[0] = skipReasons[0].replace(/have 0(\.0+)?/, `have ${inv.USDT.toFixed(2)}`);
                }
                if (isSell && inv.PEPEW > 0) {
                    skipReasons[0] = skipReasons[0].replace(/have 0(\.0+)?/, `have ${inv.PEPEW.toExponential(2)}`);
                }
            }
        }

        if (skipReasons.length > 0) {
            // Include details like (have X, need Y)
            statusLine += `\n   skip: ${skipReasons.slice(0, 2).join(" | ")}`;
        }

        return statusLine;
    }

    return `last ${lastRun}`;
}

/**
 * Aggregated fill for deduplication display
 */
interface AggregatedFill {
    strategy: string;
    exchange: string;
    pair: string;
    side: string;
    quoteQty: number;
    price: number;
    count: number;
}

function aggregateFills(fills: StrategyFill[]): AggregatedFill[] {
    if (!fills || fills.length === 0) return [];

    const aggregated: AggregatedFill[] = [];

    for (const fill of fills) {
        // Group by strategy, exchange, pair, side, qty (rounded), and price (rounded)
        const matched = aggregated.find(a =>
            a.strategy === fill.strategy &&
            a.exchange === fill.exchange &&
            a.pair === fill.pair &&
            a.side === fill.side &&
            Math.abs(a.quoteQty - (fill.quoteQty ?? 0)) < 0.0001 &&
            Math.abs(a.price - (fill.price ?? 0)) / (a.price || 1) < 0.0001
        );

        if (matched) {
            matched.count++;
        } else {
            aggregated.push({
                strategy: fill.strategy,
                exchange: fill.exchange,
                pair: fill.pair,
                side: fill.side,
                quoteQty: fill.quoteQty ?? 0,
                price: fill.price ?? 0,
                count: 1,
            });
        }
    }

    return aggregated;
}

/**
 * Format aggregated fill with optional count
 * Output: "- MM NonKYC PEPEW/USDT: BUY 4 @ 4.56e-7 (x3)"
 */
function formatAggregatedFill(fill: AggregatedFill): string {
    const exchange =
        fill.exchange === "nonkyc" || fill.exchange === "dextrade" || fill.exchange === "nestex"
            ? exchangeLabel(fill.exchange as ExchangeName)
            : fill.exchange;

    const qtyStr = formatQuantity(fill.quoteQty);
    const priceStr = formatPrice(fill.price);
    const countSuffix = fill.count > 1 ? ` (x${fill.count})` : "";

    return `- ${fill.strategy} ${exchange} ${fill.pair}: ${fill.side} ${qtyStr} @ ${priceStr}${countSuffix}`;
}

function formatDevmmCompact(entry: DevmmStatusEntry): string {
    const status = entry.status || "STOPPED";
    const turnover = entry.turnover?.todayUsdt ?? 0;
    const fee = entry.turnover?.capDayUsdt ?? 0;
    const openOrders = (entry.orders?.buyOrderId ? 1 : 0) + (entry.orders?.sellOrderId ? 1 : 0);
    const reason = entry.pauseReason || entry.lastErrorCode || entry.lastError || "-";
    return `${exchangeLabel(entry.exchange as ExchangeName)}: ${status} | open=${openOrders} | turnover=${formatQuantity(turnover)} | cap=${formatQuantity(fee)} | reason=${truncateText(reason, 80)}`;
}

function formatDevmmDetail(entry: DevmmStatusEntry): string {
    const lines: string[] = [];
    if (entry.market?.mid) {
        lines.push(`mid=${formatPrice(entry.market.mid)}`);
    }
    if (entry.turnover) {
        lines.push(`hour=${formatQuantity(entry.turnover.hourUsdt)}/${formatQuantity(entry.turnover.capHourUsdt)}`);
    }
    if (entry.inventory && !("status" in entry.inventory)) {
        lines.push(`inventoryUSDT=${formatQuantity(entry.inventory.usdtBalance)}`);
    }
    if (entry.lastDecision) {
        lines.push(`decision=${truncateText(entry.lastDecision, 80)}`);
    }
    return lines.join(" | ");
}

export async function handleStatus(ctx: Context): Promise<void> {
    const rawTgUserId = ctx.from?.id;
    if (!rawTgUserId) {
        await safeSend(ctx, { step: "status.no_user", text: "❌ Could not identify user (missing Telegram ID)." });
        await sendMainMenu(ctx);
        return;
    }
    const tgUserId = String(rawTgUserId);

    try {
        const data = await getStrategyStatus(tgUserId);
        let devmmEntries: DevmmStatusEntry[] = [];
        try {
            const devmm = await devmmStatus();
            if (devmm.ok && devmm.exchanges) {
                devmmEntries = devmm.exchanges;
            }
        } catch (devmmErr: any) {
            console.warn(`[status] failed to fetch devmm status: ${devmmErr?.message || devmmErr}`);
        }

        if (!data.ok) {
            await safeSend(ctx, { step: "status.api_error", text: "❌ Failed to fetch status. Please try again." });
            await sendMainMenu(ctx);
            return;
        }

        const realConfigs = (data.configs || []).filter(c => c.tradeMode === "REAL" && c.enabled);

        if (realConfigs.length === 0) {
            const lines = ["No active strategy config found. Use /dca, /grid, or /mm to start one."];
            if (devmmEntries.length > 0) {
                lines.push("", "DevMM summary:");
                for (const entry of devmmEntries) {
                    lines.push(`- ${formatDevmmCompact(entry)}`);
                }
            }
            await safeSend(ctx, { step: "status.none", text: lines.join("\n") });
            await sendMainMenu(ctx);
            return;
        }

        const balanceLines: string[] = [];
        if (data.balances && data.balances.length > 0) {
            for (const bal of data.balances) {
                const label = exchangeLabel(bal.exchange as ExchangeName);
                if (bal.ok) {
                    const snap = bal.snapshot;
                    const usdt = snap?.assets?.USDT || { free: bal.assets.USDT, total: bal.assets.USDT };
                    const bnb = snap?.assets?.BNB || { free: bal.assets.BNB, total: bal.assets.BNB };
                    const pepew = snap?.assets?.PEPEW || { free: bal.assets.PEPEW, total: bal.assets.PEPEW };
                    const updatedTs = snap?.ts || bal.lastOkTs || null;
                    const parts: string[] = [];
                    parts.push(`USDT ${usdt.free.toFixed(4)}/${usdt.total.toFixed(4)}`);
                    if (bal.exchange === "nonkyc") {
                        parts.push(`BNB ${bnb.free.toFixed(4)}/${bnb.total.toFixed(4)}`);
                    }
                    parts.push(`PEPEW ${pepew.free.toExponential(2)}/${pepew.total.toExponential(2)}`);
                    balanceLines.push(`${label} balance: ${parts.join(" | ")} | ${formatDateTime(updatedTs)}`);
                } else {
                    const reason = bal.errCode || bal.reason || "BALANCE_FETCH_FAILED";
                    const lastOk = bal.lastOkTs ? formatDateTime(bal.lastOkTs) : "-";
                    balanceLines.push(`${label} balance: unavailable (${reason}, lastOk ${lastOk})`);
                }
            }
        } else if (data.debug) {
            // Fallback to debug balance if balances array missing
            const usdtStr = data.debug.freeQuote.toFixed(4);
            const pepewStr = data.debug.freePEPEW.toExponential(2);
            balanceLines.push(`NonKYC balance: USDT ${usdtStr} | PEPEW ${pepewStr}`);
        }

        // Compact status display
        const lines: string[] = [];
        if (balanceLines.length > 0) {
            lines.push(...balanceLines);
            lines.push("");
        }
        lines.push("Strategies:");
        realConfigs.forEach((cfg, index) => {
            const exchangeDisplay =
                cfg.exchange === "nonkyc" || cfg.exchange === "dextrade" || cfg.exchange === "nestex"
                    ? exchangeLabel(cfg.exchange as ExchangeName)
                    : cfg.exchange;
            let status = cfg.enabled ? "ACTIVE" : "STOPPED";
            if (cfg.disabledReason) {
                status = `AUTO-STOPPED (${cfg.disabledReason})`;
            } else if (cfg.backoff && cfg.backoff.remainingSec > 0) {
                status = `BACKOFF ${formatInterval(cfg.backoff.remainingSec)}`;
            }

            lines.push(
                `${index + 1}. ${cfg.strategy} ${exchangeDisplay} ${cfg.pair} ${status}`
            );
            const sharedBal = data.debug ? { freeUSDT: data.debug.freeQuote, freePEPEW: data.debug.freePEPEW } : null;
            lines.push(`   ${formatCompactParams(cfg, sharedBal)}`);
            lines.push("");
        });

        if (devmmEntries.length > 0) {
            lines.push("");
            lines.push("DevMM summary:");
            for (const entry of devmmEntries) {
                lines.push(`- ${formatDevmmCompact(entry)}`);
            }
            lines.push("");
            lines.push("DevMM details:");
            for (const entry of devmmEntries) {
                const detail = formatDevmmDetail(entry);
                lines.push(`- ${exchangeLabel(entry.exchange as ExchangeName)}: ${detail || "-"}`);
            }
        }

        await safeSend(ctx, { step: "status.success", text: lines.join("\n") });
        await sendMainMenu(ctx);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[status] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            await safeSend(ctx, { step: "status.http", text: "❌ Failed to fetch status. Please try again." });
            await sendMainMenu(ctx);
            return;
        }
        console.error(`[status] Error: ${err?.message || err}`);
        await safeSend(ctx, { step: "status.error", text: "❌ Failed to fetch status. Please try again." });
        await sendMainMenu(ctx);
    }
}

export async function handleStrategyMenu(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard()
        .text("DCA", buildStrategyCallback("open", "dca"))
        .text("GRID", buildStrategyCallback("open", "grid")).row()
        .text("MM", buildStrategyCallback("open", "mm"))
        .text("DEVMM", buildStrategyCallback("open", "devmm"));

    await safeSend(ctx, {
        step: "strategy.menu",
        text: "Select strategy:",
        replyMarkup: keyboard,
    });
}

export async function handleStrategyMenuCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith(STRATEGY_CALLBACK_PREFIX)) return false;

    const payload = data.slice(STRATEGY_CALLBACK_PREFIX.length);
    const [action, value] = payload.split(":");
    await safeAnswerCallbackQuery(ctx, "strategy.menu.callback");

    if (action !== "open") {
        await safeSend(ctx, { step: "strategy.menu.invalid", text: "❌ Unknown strategy action." });
        return true;
    }

    if (value === "dca") {
        await handleDca(ctx);
        return true;
    }
    if (value === "grid") {
        await handleGrid(ctx);
        return true;
    }
    if (value === "mm") {
        await handleMm(ctx);
        return true;
    }
    if (value === "devmm") {
        await handleDevmm(ctx);
        return true;
    }

    await safeSend(ctx, { step: "strategy.menu.unknown", text: "❌ Unknown strategy type." });
    return true;
}

export async function handleStrategyStatus(ctx: Context): Promise<void> {
    await safeSend(ctx, {
        step: "status.alias.strategy_status",
        text: "ℹ️ /strategy_status has been integrated into /status.",
    });
    await handleStatus(ctx);
}

export async function handleDevmmStatusAlias(ctx: Context): Promise<void> {
    await safeSend(ctx, {
        step: "status.alias.devmm_status",
        text: "ℹ️ /devmm_status has been integrated into /status.",
    });
    await handleStatus(ctx);
}
