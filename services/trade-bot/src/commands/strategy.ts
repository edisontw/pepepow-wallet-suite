import { Context } from "grammy";
import { ApiError, getStrategyStatus, StrategyConfig, StrategyFill, getNonKycBalance } from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { safeText, truncateText } from "../utils/strings.js";
import { ExchangeName } from "../lib/markets.js";

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
            statusLine += `\n   skip: ${skipReasons[0]}`;
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

export async function handleStrategyStatus(ctx: Context): Promise<void> {
    const rawTgUserId = ctx.from?.id;
    if (!rawTgUserId) {
        await safeSend(ctx, { step: "strategy_status.no_user", text: "❌ Could not identify user (missing Telegram ID)." });
        return;
    }
    const tgUserId = String(rawTgUserId);

    try {
        const data = await getStrategyStatus(tgUserId);

        if (!data.ok) {
            await safeSend(ctx, { step: "strategy_status.api_error", text: "❌ Failed to fetch status. Please try again." });
            return;
        }

        const realConfigs = (data.configs || []).filter(c => c.tradeMode === "REAL" && c.enabled);

        if (realConfigs.length === 0) {
            await safeSend(ctx, { step: "strategy_status.none", text: "No active strategy config found. Use /dca, /grid, or /mm to start one." });
            return;
        }

        // Fetch NonKYC REAL balance if any REAL strategies on NonKYC exist
        const hasNonKycReal = realConfigs.some(c => c.exchange === "nonkyc");
        let nonKycBalanceLine = "";

        // Use debug balance if available (single source of truth)
        if (data.debug) {
            const usdtStr = data.debug.freeUSDT.toFixed(4);
            const pepewStr = data.debug.freePEPEW.toExponential(2);
            nonKycBalanceLine = `📊 NonKYC Balance: ${usdtStr} USDT | ${pepewStr} PEPEW\n`;
        } else if (hasNonKycReal) {
            try {
                const balanceResp = await getNonKycBalance(tgUserId);
                if (balanceResp.ok && balanceResp.freeUSDT !== undefined) {
                    const usdtStr = balanceResp.freeUSDT.toFixed(4);
                    const pepewStr = (balanceResp.freePEPEW ?? 0).toExponential(2);
                    nonKycBalanceLine = `📊 NonKYC Balance: ${usdtStr} USDT | ${pepewStr} PEPEW\n`;
                }
            } catch (err) {
                // Silently fail - balance is optional info
            }
        }

        // Compact config display: 2 lines per config
        const lines: string[] = [];
        if (nonKycBalanceLine) {
            lines.push(nonKycBalanceLine);
        }
        lines.push("Your strategies:", "");
        realConfigs.forEach((cfg, index) => {
            const exchangeDisplay =
                cfg.exchange === "nonkyc" || cfg.exchange === "dextrade" || cfg.exchange === "nestex"
                    ? exchangeLabel(cfg.exchange as ExchangeName)
                    : cfg.exchange;
            let status = cfg.enabled ? "ACTIVE" : "STOPPED";
            if (cfg.disabledReason) {
                status = `🔴 AUTO-STOPPED (${cfg.disabledReason})`;
            } else if (cfg.backoff && cfg.backoff.remainingSec > 0) {
                status = `⚠️ BACKOFF (${formatInterval(cfg.backoff.remainingSec)})`;
            }

            // Line 1: Strategy Exchange Pair Mode Status
            lines.push(
                `${index + 1}) ${cfg.strategy}  ${exchangeDisplay}  ${cfg.pair}  ${cfg.tradeMode}  ${status}`
            );
            // Line 2: Compact params with pipe separators
            const sharedBal = data.debug ? { freeUSDT: data.debug.freeUSDT, freePEPEW: data.debug.freePEPEW } : null;
            lines.push(`   ${formatCompactParams(cfg, sharedBal)}`);

            // Line 3: Last action if present
            if (cfg.lastAction) {
                const isGridNewFormat = cfg.strategy === "GRID" && (cfg.lastAction.startsWith("GRID tick ok:") || cfg.lastAction.startsWith("GRID:"));
                if (!isGridNewFormat) {
                    const actionTime = cfg.lastActionAt ? formatTimeAgo(cfg.lastActionAt) : "";
                    const action = truncateText(safeText(cfg.lastAction), 200);
                    lines.push(`   Last Action: ${action}${actionTime ? ` (${actionTime})` : ""}`);
                }
            }

            // Line 3.5: Inventory warning if present
            if (cfg.inventoryWarning) {
                lines.push(`   ⚠️ ${cfg.inventoryWarning}`);
            }

            // Line 4: Failure info if present (only show if within last 30 minutes)
            const STALE_ERROR_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
            if (cfg.lastFailure) {
                const f = cfg.lastFailure;
                const ageMs = Date.now() - f.lastSeenAt;
                const isStale = ageMs > STALE_ERROR_THRESHOLD_MS;

                // Only show errors that are recent OR if strategy is in backoff/disabled
                if (!isStale || cfg.disabledReason || (cfg.backoff && cfg.backoff.remainingSec > 0)) {
                    const message = f.message ? truncateText(safeText(f.message), 200) : "";

                    // Filter out old/irrelevant GRID error strings
                    const isForbidden = /exchangeOpenOrders|Orders not found|after placing/i.test(message);

                    if (!isForbidden) {
                        const timeAgo = formatTimeAgo(f.lastSeenAt);
                        lines.push(`   Last Error Code: ${f.category} (${timeAgo})`);
                        if (f.httpStatus) {
                            lines.push(`   Last Error Status: ${f.httpStatus}`);
                        }
                        if (f.exchangeCode) {
                            lines.push(`   Last Error Exchange Code: ${f.exchangeCode}`);
                        }
                        if (message) {
                            lines.push(`   Last Error Message: ${message}`);
                        }
                    }
                }
            }
            lines.push("");
        });

        // Aggregated fills (max 5 unique entries)
        const fills = data.recentFills || [];
        if (fills.length === 0) {
            lines.push("Recent fills:", "- None");
        } else {
            lines.push("Recent fills:");
            const aggregated = aggregateFills(fills.slice(0, 10));
            aggregated.slice(0, 5).forEach((fill) => lines.push(formatAggregatedFill(fill)));
        }

        // Add Debug Trace if available
        if (data.debug) {
            const d = data.debug;
            lines.push("");
            lines.push("🔍 Debug Trace (NonKYC Balance):");
            lines.push(`- Source: ${d.balance_source}`);
            lines.push(`- Cache: ${d.isCached ? "YES" : "NO"} (${formatInterval(Math.floor(d.cacheAgeMs / 1000))} old)`);
            lines.push(`- Symbols Found: [${d.symbolsFound.join(", ")}]`);
            lines.push(`- Free USDT: ${d.freeUSDT.toFixed(6)}`);
            lines.push(`- Free PEPEW: ${d.freePEPEW.toExponential(6)}`);
        }

        await safeSend(ctx, { step: "strategy_status.success", text: lines.join("\n") });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[strategy_status] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            await safeSend(ctx, { step: "strategy_status.http", text: "❌ Failed to fetch status. Please try again." });
            return;
        }
        console.error(`[strategy_status] Error: ${err?.message || err}`);
        await safeSend(ctx, { step: "strategy_status.error", text: "❌ Failed to fetch status. Please try again." });
    }
}
