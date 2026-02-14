import { Context, InlineKeyboard } from "grammy";
import {
    ApiError,
    getStrategyReport,
    ReportExchange,
    ReportPeriod,
    StrategyReportMetrics,
} from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { renderMenu } from "../utils/menu.js";
import { sendMainMenu, withMenuNav } from "./mainMenu.js";

type ReportState = {
    step: "period";
    updatedAt: number;
};
type ReportViewMode = "compact" | "all";

const REPORT_STATE_TTL_MS = 10 * 60 * 1000;
const REPORT_EXCHANGES: ReportExchange[] = ["nonkyc", "dextrade", "nestex"];
const pendingReport = new Map<string, ReportState>();

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function isExpired(state: ReportState): boolean {
    return Date.now() - state.updatedAt > REPORT_STATE_TTL_MS;
}

function exchangeLabel(exchange: ReportExchange): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade";
    return "NestEx";
}

function periodLabel(period: ReportPeriod): string {
    if (period === "daily") return "Daily";
    if (period === "weekly") return "Weekly";
    return "Monthly";
}

function buildPeriodKeyboard(): InlineKeyboard {
    return withMenuNav(new InlineKeyboard()
        .text("Daily", "report:period:daily")
        .text("Weekly", "report:period:weekly")
        .text("Monthly", "report:period:monthly"));
}

function formatSignedUsdt(value: number): string {
    if (!Number.isFinite(value)) return "0.0000 USDT";
    const abs = Math.abs(value).toFixed(4);
    if (value > 0) return `+${abs} USDT`;
    if (value < 0) return `-${abs} USDT`;
    return "0.0000 USDT";
}

function formatPepewVolume(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0 PEPEW";
    return `${Math.round(value).toLocaleString("en-US")} PEPEW`;
}

function formatOrderSideCount(metric: StrategyReportMetrics): string {
    const orderBuy = Number(metric.orderBuyCount || 0);
    const orderSell = Number(metric.orderSellCount || 0);
    if (orderBuy > 0 || orderSell > 0) {
        return `${orderBuy + orderSell} (${orderBuy}B/${orderSell}S)`;
    }
    const fillBuy = Number(metric.fillBuyCount || 0);
    const fillSell = Number(metric.fillSellCount || 0);
    if (fillBuy > 0 || fillSell > 0) {
        return `${fillBuy + fillSell} (${fillBuy}B/${fillSell}S)`;
    }
    return `${Number(metric.orderCount || 0)} (0B/0S)`;
}

function hasTradeActivity(total: StrategyReportMetrics): boolean {
    return Number(total.fillCount || 0) > 0 && Number(total.quoteVolume || 0) > 0;
}

function buildReportResultKeyboard(period: ReportPeriod, hiddenExchanges: ReportExchange[]): InlineKeyboard | undefined {
    if (hiddenExchanges.length === 0) return undefined;
    return new InlineKeyboard().text("Show all exchanges", `report:period_all:${period}`);
}

function formatReportLines(
    period: ReportPeriod,
    viewMode: ReportViewMode,
    reportResults: PromiseSettledResult<Awaited<ReturnType<typeof getStrategyReport>>>[]
): { lines: string[]; hiddenExchanges: ReportExchange[] } {
    const lines: string[] = [
        `📈 ${periodLabel(period)} Report`,
        "--------------------",
    ];
    const hiddenExchanges: ReportExchange[] = [];

    reportResults.forEach((item, index) => {
        const exchange = REPORT_EXCHANGES[index];
        const label = exchangeLabel(exchange);
        if (item.status !== "fulfilled") {
            const reason = item.reason instanceof ApiError
                ? item.reason.message
                : (item.reason?.message || "unknown error");
            lines.push(`⚠️ ${label}: failed (${reason})`);
            return;
        }

        const total = item.value.report.total;
        const active = hasTradeActivity(total);
        if (!active && viewMode === "compact") {
            hiddenExchanges.push(exchange);
            return;
        }

        if (!active) {
            lines.push(`— ${label}: 0 trades`);
            return;
        }

        const icon = total.netQuote >= 0 ? "✅" : "⚠️";
        lines.push(
            `${icon} ${label}: ${formatSignedUsdt(total.netQuote)} · Vol ${formatPepewVolume(total.baseVolume)} · Orders ${formatOrderSideCount(total)}`
        );
    });

    if (viewMode === "compact" && hiddenExchanges.length > 0) {
        lines.push(`(Hidden: ${hiddenExchanges.map(exchangeLabel).join(", ")} = 0 trades)`);
    }
    if (lines.length === 2) {
        lines.push("No filled trades in this period.");
    }

    return { lines, hiddenExchanges };
}

async function renderReportForPeriod(ctx: Context, tgUserId: string, period: ReportPeriod, viewMode: ReportViewMode): Promise<void> {
    const reportResults = await Promise.allSettled(
        REPORT_EXCHANGES.map((exchange) => getStrategyReport(tgUserId, period, exchange))
    );
    const { lines, hiddenExchanges } = formatReportLines(period, viewMode, reportResults);
    await safeSend(ctx, {
        step: `report.result.${period}.${viewMode}`,
        text: lines.join("\n"),
        replyMarkup: buildReportResultKeyboard(period, hiddenExchanges),
    });

    for (const [index, item] of reportResults.entries()) {
        if (item.status !== "fulfilled") continue;
        const exchange = REPORT_EXCHANGES[index];
        console.log(
            `[trade-bot] report.generate userId=${tgUserId} period=${period} exchange=${exchange} total=${item.value.report.total.quoteVolume}`
        );
    }
}

export async function handleReport(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "report.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    pendingReport.set(tgUserId, { step: "period", updatedAt: Date.now() });
    await safeSend(ctx, {
        step: "report.select_period",
        text: renderMenu("📈 Strategy Report", "Select report period:"),
        replyMarkup: buildPeriodKeyboard(),
    });
}

export async function handleReportCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("report:")) return false;

    const tgUserId = getTgUserId(ctx);
    const parts = data.split(":");
    const action = parts[1] || "";
    const value = parts[2] || "";
    const extra = parts[3] || "";
    const maybeExchange = value === "nonkyc" || value === "dextrade" || value === "nestex" ? value : undefined;
    console.log(
        `[trade-bot] callback userId=${tgUserId || "unknown"} action=report:${action} exchange=${maybeExchange || "n/a"} strategy=n/a params=${value || "n/a"}`
    );

    await ctx.answerCallbackQuery().catch(() => { });

    if (!tgUserId) {
        await safeSend(ctx, { step: "report.cb.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return true;
    }

    // Backward compatibility for old inline buttons already sent before this change.
    if (action === "exchange" && (value === "nonkyc" || value === "dextrade" || value === "nestex")) {
        await safeSend(ctx, {
            step: "report.exchange_removed",
            text: "ℹ️ Exchange step removed. Select period only; report now includes all exchanges.",
        });
        await handleReport(ctx);
        return true;
    }

    if (action === "period_all" && (value === "daily" || value === "weekly" || value === "monthly")) {
        try {
            await renderReportForPeriod(ctx, tgUserId, value as ReportPeriod, "all");
            await sendMainMenu(ctx);
            return true;
        } catch (err: any) {
            if (err instanceof ApiError) {
                await safeSend(ctx, { step: "report.cb.api_error", text: `❌ Report failed: ${err.message}` });
            } else {
                await safeSend(ctx, { step: "report.cb.error", text: "❌ Report failed. Please try again." });
            }
            await sendMainMenu(ctx);
            return true;
        }
    }

    if (action === "period" && (value === "daily" || value === "weekly" || value === "monthly")) {
        const viewMode: ReportViewMode = extra === "all" ? "all" : "compact";
        const state = pendingReport.get(tgUserId);
        if (!state || isExpired(state)) {
            pendingReport.delete(tgUserId);
            await safeSend(ctx, { step: "report.cb.expired", text: "Report flow expired. Use /report again." });
            await sendMainMenu(ctx);
            return true;
        }

        pendingReport.delete(tgUserId);
        try {
            await renderReportForPeriod(ctx, tgUserId, value as ReportPeriod, viewMode);
            await sendMainMenu(ctx);
            return true;
        } catch (err: any) {
            if (err instanceof ApiError) {
                await safeSend(ctx, { step: "report.cb.api_error", text: `❌ Report failed: ${err.message}` });
            } else {
                await safeSend(ctx, { step: "report.cb.error", text: "❌ Report failed. Please try again." });
            }
            await sendMainMenu(ctx);
            return true;
        }
    }

    await safeSend(ctx, { step: "report.cb.unknown", text: "Unknown report action." });
    await sendMainMenu(ctx);
    return true;
}

export async function handleDevmmReportAlias(ctx: Context): Promise<void> {
    await safeSend(ctx, {
        step: "report.alias.devmm",
        text: "ℹ️ /devmm_report has been integrated into /report.",
    });
    await handleReport(ctx);
}
