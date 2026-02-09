import { Context, InlineKeyboard } from "grammy";
import {
    ApiError,
    getStrategyReport,
    ReportExchange,
    ReportPeriod,
    StrategyReportMetrics,
} from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { sendMainMenu } from "./mainMenu.js";

type ReportState = {
    step: "period" | "exchange";
    period?: ReportPeriod;
    updatedAt: number;
};

const REPORT_STATE_TTL_MS = 10 * 60 * 1000;
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
    return new InlineKeyboard()
        .text("Daily", "report:period:daily")
        .text("Weekly", "report:period:weekly")
        .text("Monthly", "report:period:monthly");
}

function buildExchangeKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("NonKYC", "report:exchange:nonkyc")
        .text("Dex-Trade", "report:exchange:dextrade")
        .text("NestEx", "report:exchange:nestex");
}

function formatMetricLine(label: string, metric: StrategyReportMetrics): string {
    return [
        `${label.toUpperCase()}:`,
        `orders=${metric.orderCount}`,
        `fills=${metric.fillCount}`,
        `volume=${metric.baseVolume.toFixed(8)}`,
        `amount=${metric.quoteVolume.toFixed(8)}`,
        `fee=${metric.fee.toFixed(8)}`,
        `net=${metric.netQuote.toFixed(8)}`,
    ].join(" ");
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
        text: "Select report period:",
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

    const state = pendingReport.get(tgUserId);
    if (!state || isExpired(state)) {
        pendingReport.delete(tgUserId);
        await safeSend(ctx, { step: "report.cb.expired", text: "Report flow expired. Use /report again." });
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "period" && (value === "daily" || value === "weekly" || value === "monthly")) {
        pendingReport.set(tgUserId, {
            step: "exchange",
            period: value,
            updatedAt: Date.now(),
        });
        await safeSend(ctx, {
            step: "report.select_exchange",
            text: `Period: ${periodLabel(value)}\nSelect exchange:`,
            replyMarkup: buildExchangeKeyboard(),
        });
        return true;
    }

    if (action === "exchange" && (value === "nonkyc" || value === "dextrade" || value === "nestex")) {
        const period = state.period;
        if (!period) {
            pendingReport.delete(tgUserId);
            await safeSend(ctx, { step: "report.cb.missing_period", text: "Missing period selection. Use /report again." });
            await sendMainMenu(ctx);
            return true;
        }

        pendingReport.delete(tgUserId);
        try {
            const exchange = value as ReportExchange;
            const result = await getStrategyReport(tgUserId, period, exchange);
            const report = result.report;

            console.log(
                `[trade-bot] report.generate userId=${tgUserId} period=${period} exchange=${exchange} totals=${JSON.stringify({
                    dca: report.dca.quoteVolume,
                    grid: report.grid.quoteVolume,
                    mm: report.mm.quoteVolume,
                    devmm: report.devmm.quoteVolume,
                    total: report.total.quoteVolume,
                })}`
            );

            const lines = [
                `Report ${periodLabel(period)} | ${exchangeLabel(exchange)} | bucket=${result.bucket}`,
                "",
                formatMetricLine("dca", report.dca),
                formatMetricLine("grid", report.grid),
                formatMetricLine("mm", report.mm),
                formatMetricLine("devmm", report.devmm),
                "",
                formatMetricLine("total", report.total),
            ];

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
