import { Context, InlineKeyboard } from "grammy";
import {
    ApiError,
    cancelStrategyOrders,
    devmmStop,
    disableStrategyConfig,
    getDcaStatus,
    getStrategyStatus,
    stopDca,
} from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { renderMenu } from "../utils/menu.js";
import { sendMainMenu, withMenuNav } from "./mainMenu.js";

type ExchangeName = "nonkyc" | "dextrade" | "nestex";
type StopTarget = ExchangeName | "all";

type StopSummary = {
    exchange: ExchangeName;
    dcaStopped: number;
    gridStopped: number;
    mmStopped: number;
    devmmStopped: boolean;
    devmmUnknownVisible: number;
    cancelQueued: number;
    cancelFailed: number;
    retryCount: number;
    errors: string[];
};

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function exchangeLabel(exchange: ExchangeName): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade";
    return "NestEx";
}

function buildStopKeyboard(): InlineKeyboard {
    return withMenuNav(new InlineKeyboard()
        .text("NonKYC", "stop:exchange:nonkyc")
        .text("Dex-Trade", "stop:exchange:dextrade")
        .text("NestEx", "stop:exchange:nestex")
        .row()
        .text("Stop All", "stop:exchange:all"));
}

async function queueCancelWithRetry(configId: number, tgUserId: string): Promise<{ ok: boolean; retry: boolean; error?: string }> {
    try {
        await cancelStrategyOrders(configId, tgUserId);
        return { ok: true, retry: false };
    } catch (err: any) {
        try {
            await cancelStrategyOrders(configId, tgUserId);
            return { ok: true, retry: true };
        } catch (retryErr: any) {
            return { ok: false, retry: true, error: retryErr?.message || err?.message || "cancel failed" };
        }
    }
}

async function stopByExchange(tgUserId: string, exchange: ExchangeName): Promise<StopSummary> {
    const summary: StopSummary = {
        exchange,
        dcaStopped: 0,
        gridStopped: 0,
        mmStopped: 0,
        devmmStopped: false,
        devmmUnknownVisible: 0,
        cancelQueued: 0,
        cancelFailed: 0,
        retryCount: 0,
        errors: [],
    };

    try {
        const dca = await getDcaStatus(tgUserId);
        const activeDca = (dca.configs || []).filter((cfg) => cfg.enabled && cfg.exchange === exchange);
        for (const cfg of activeDca) {
            try {
                const res = await stopDca({ tgUserId, configId: cfg.id });
                if (res.ok) {
                    summary.dcaStopped += 1;
                } else {
                    summary.errors.push(`DCA#${cfg.id} stop failed: ${res.error || "unknown"}`);
                }
            } catch (err: any) {
                summary.errors.push(`DCA#${cfg.id} stop failed: ${err?.message || err}`);
            }
        }
    } catch (err: any) {
        summary.errors.push(`DCA status failed: ${err?.message || err}`);
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const active = (status.configs || []).filter((cfg) => cfg.enabled && cfg.exchange === exchange);
        const activeGrid = active.filter((cfg) => cfg.strategy === "GRID");
        const activeMm = active.filter((cfg) => cfg.strategy === "MM");

        for (const cfg of activeGrid) {
            try {
                await disableStrategyConfig(cfg.id, tgUserId, "STOPPING");
                summary.gridStopped += 1;
                const cancel = await queueCancelWithRetry(cfg.id, tgUserId);
                if (cancel.ok) {
                    summary.cancelQueued += 1;
                } else {
                    summary.cancelFailed += 1;
                    summary.errors.push(`GRID#${cfg.id} cancel failed: ${cancel.error || "unknown"}`);
                }
                if (cancel.retry) summary.retryCount += 1;
            } catch (err: any) {
                summary.errors.push(`GRID#${cfg.id} disable failed: ${err?.message || err}`);
            }
        }

        for (const cfg of activeMm) {
            try {
                await disableStrategyConfig(cfg.id, tgUserId, "STOPPING");
                summary.mmStopped += 1;
                const cancel = await queueCancelWithRetry(cfg.id, tgUserId);
                if (cancel.ok) {
                    summary.cancelQueued += 1;
                } else {
                    summary.cancelFailed += 1;
                    summary.errors.push(`MM#${cfg.id} cancel failed: ${cancel.error || "unknown"}`);
                }
                if (cancel.retry) summary.retryCount += 1;
            } catch (err: any) {
                summary.errors.push(`MM#${cfg.id} disable failed: ${err?.message || err}`);
            }
        }
    } catch (err: any) {
        summary.errors.push(`Strategy status failed: ${err?.message || err}`);
    }

    try {
        const res = await devmmStop(exchange);
        if (res.ok) {
            summary.devmmStopped = true;
            summary.devmmUnknownVisible = Math.max(0, Number(res.unknownOrdersVisible || 0));
        } else {
            summary.errors.push(`DEVMM stop failed: ${res.error || "unknown"}`);
        }
        console.log(
            `[trade-bot] stop.devmm exchange=${exchange} attempted=${res.ordersAttempted ?? 0} cancelled=${res.ordersCancelled ?? 0} failed=${res.ordersFailed ?? 0} unknownVisible=${res.unknownOrdersVisible ?? 0}`
        );
    } catch (err: any) {
        summary.errors.push(`DEVMM stop failed: ${err?.message || err}`);
    }

    console.log(
        `[trade-bot] stop.exchange exchange=${exchange} stopped={dca:${summary.dcaStopped},grid:${summary.gridStopped},mm:${summary.mmStopped},devmm:${summary.devmmStopped}} cancel={queued:${summary.cancelQueued},failed:${summary.cancelFailed},retry:${summary.retryCount}} errors=${summary.errors.length}`
    );
    return summary;
}

function renderStopSummary(items: StopSummary[]): string {
    const lines: string[] = ["🛑 Stop summary"];
    let shown = 0;
    for (const item of items) {
        const details: string[] = [];
        if (item.dcaStopped > 0) details.push(`DCA ${item.dcaStopped}`);
        if (item.gridStopped > 0) details.push(`GRID ${item.gridStopped}`);
        if (item.mmStopped > 0) details.push(`MM ${item.mmStopped}`);
        if (item.devmmStopped) details.push("DevMM 1");
        if (item.cancelQueued > 0) details.push(`Cancel queued ${item.cancelQueued}`);
        if (item.cancelFailed > 0) details.push(`Cancel failed ${item.cancelFailed}`);
        if (item.retryCount > 0) details.push(`Retries ${item.retryCount}`);
        if (item.devmmUnknownVisible > 0) details.push(`Unknown orders ${item.devmmUnknownVisible}`);

        const hasIssue = item.errors.length > 0 || item.cancelFailed > 0 || item.devmmUnknownVisible > 0;
        const icon = hasIssue ? "⚠️" : (details.length > 0 ? "✅" : "ℹ️");
        const summaryText = details.length > 0 ? details.join(" · ") : "No active strategies";
        lines.push(`${icon} ${exchangeLabel(item.exchange)}: ${summaryText}`);
        shown += 1;

        if (item.errors.length > 0) {
            lines.push(`  errors: ${item.errors.slice(0, 2).join(" | ")}`);
        }
    }
    if (shown === 0) {
        lines.push("ℹ️ No active strategies");
    }
    return lines.join("\n");
}

export async function handleStop(ctx: Context): Promise<void> {
    await safeSend(ctx, {
        step: "stop.menu",
        text: renderMenu("🏦 Select Exchange", "Choose scope to stop strategies:"),
        replyMarkup: buildStopKeyboard(),
    });
}

async function runStopAction(ctx: Context, target: StopTarget, tgUserId: string): Promise<void> {
    const exchanges: ExchangeName[] = target === "all"
        ? ["nonkyc", "dextrade", "nestex"]
        : [target];

    const results: StopSummary[] = [];
    for (const exchange of exchanges) {
        results.push(await stopByExchange(tgUserId, exchange));
    }

    await safeSend(ctx, {
        step: "stop.result",
        text: renderStopSummary(results),
    });
    await sendMainMenu(ctx);
}

export async function handleStopCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("stop:")) return false;

    const tgUserId = getTgUserId(ctx);
    const parts = data.split(":");
    const action = parts[1] || "";
    const value = parts[2] || "";
    const maybeExchange = value === "nonkyc" || value === "dextrade" || value === "nestex" || value === "all"
        ? value
        : "n/a";
    console.log(
        `[trade-bot] callback userId=${tgUserId || "unknown"} action=stop:${action} exchange=${maybeExchange} strategy=all params=${value || "n/a"}`
    );

    await ctx.answerCallbackQuery().catch(() => { });

    if (!tgUserId) {
        await safeSend(ctx, { step: "stop.cb.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "exchange" && (value === "nonkyc" || value === "dextrade" || value === "nestex" || value === "all")) {
        await runStopAction(ctx, value as StopTarget, tgUserId);
        return true;
    }

    await safeSend(ctx, { step: "stop.cb.unknown", text: "Unknown stop action." });
    await sendMainMenu(ctx);
    return true;
}
