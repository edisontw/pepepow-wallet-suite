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

function formatUsdt(value: number): string {
    if (!Number.isFinite(value)) return "0.000 USDT";
    return `${value.toFixed(3)} USDT`;
}

function formatPepewVolume(value: number): string {
    if (!Number.isFinite(value)) return "0 PEPEW";
    return `${Math.round(value).toLocaleString("en-US")} PEPEW`;
}

function formatMetricLine(label: string, metric: StrategyReportMetrics): string {
    return `${label.toUpperCase()}: orders=${metric.orderCount} fills=${metric.fillCount} volume=${formatPepewVolume(metric.baseVolume)} net=${formatUsdt(metric.netQuote)}`;
}

function buildExchangeReportLines(
    exchange: ReportExchange,
    period: ReportPeriod,
    result: Awaited<ReturnType<typeof getStrategyReport>>
): string[] {
    const report = result.report;
    return [
        `[${exchangeLabel(exchange)}] bucket=${result.bucket}`,
        formatMetricLine("dca", report.dca),
        formatMetricLine("grid", report.grid),
        formatMetricLine("mm", report.mm),
        formatMetricLine("devmm", report.devmm),
        formatMetricLine("total", report.total),
        `gross=${formatUsdt(report.total.quoteVolume)} fee=${formatUsdt(report.total.fee)}`,
        `period=${periodLabel(period)}`,
    ];
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

    const state = pendingReport.get(tgUserId);
    if (!state || isExpired(state)) {
        pendingReport.delete(tgUserId);
        await safeSend(ctx, { step: "report.cb.expired", text: "Report flow expired. Use /report again." });
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "period" && (value === "daily" || value === "weekly" || value === "monthly")) {
        pendingReport.delete(tgUserId);
        const period = value as ReportPeriod;
        try {
            const reportResults = await Promise.allSettled(
                REPORT_EXCHANGES.map((exchange) => getStrategyReport(tgUserId, period, exchange))
            );
            const lines: string[] = [
                `📈 Report ${periodLabel(period)} (All Exchanges)`,
                "--------------------",
                "Source: strategy logs only (manual exchange trades excluded)",
            ];

            reportResults.forEach((item, index) => {
                const exchange = REPORT_EXCHANGES[index];
                lines.push("");
                if (item.status === "fulfilled") {
                    const exchangeLines = buildExchangeReportLines(exchange, period, item.value);
                    lines.push(...exchangeLines);
                    console.log(
                        `[trade-bot] report.generate userId=${tgUserId} period=${period} exchange=${exchange} total=${item.value.report.total.quoteVolume}`
                    );
                    return;
                }

                const reason = item.reason instanceof ApiError
                    ? item.reason.message
                    : (item.reason?.message || "unknown error");
                lines.push(`[${exchangeLabel(exchange)}] failed: ${reason}`);
            });

            await safeSend(ctx, { step: "report.result", text: lines.join("\n") });
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
