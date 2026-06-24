import { Context, InlineKeyboard } from "grammy";
import { ApiError, devmmStatus, DevmmStatusEntry, getStrategyStatus, StrategyConfig } from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { renderMenu } from "../utils/menu.js";
import { truncateText } from "../utils/strings.js";
import { ExchangeName } from "../lib/markets.js";
import { handleDca } from "./dca.js";
import { handleGrid } from "./grid.js";
import { handleMm } from "./mm.js";
import { handleDevmm } from "./devmm.js";
import { sendMainMenu, withMenuNav } from "./mainMenu.js";

const STRATEGY_CALLBACK_PREFIX = "strategy:";
const STRATEGY_CALLBACK_MAX_BYTES = 64;
const EXCHANGE_ORDER: ExchangeName[] = ["nonkyc", "dextrade", "nestex"];

type NumericFormatOptions = {
    maxDecimals?: number;
    minDecimals?: number;
    group?: boolean;
};

function exchangeLabel(exchange: string): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade" || exchange === "dex-trade") return "Dex-Trade (Unavailable)";
    if (exchange === "nestex") return "NestEX";
    return exchange;
}

function normalizeExchange(value: string | null | undefined): ExchangeName | null {
    if (!value) return null;
    const normalized = value.toLowerCase();
    if (normalized === "nonkyc" || normalized === "dextrade" || normalized === "nestex") {
        return normalized;
    }
    return null;
}

function formatTimeHHmm(ts: number | null | undefined): string {
    if (!ts || !Number.isFinite(ts)) return "-";
    return new Date(ts).toISOString().slice(11, 16);
}

function addThousandsSeparators(value: string): string {
    const [intPart, fracPart] = value.split(".");
    const sign = intPart.startsWith("-") ? "-" : "";
    const digits = sign ? intPart.slice(1) : intPart;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fracPart ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`;
}

function formatNumber(value: number | null | undefined, options: NumericFormatOptions = {}): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    const maxDecimals = options.maxDecimals ?? 4;
    const minDecimals = Math.max(0, Math.min(options.minDecimals ?? 0, maxDecimals));
    const group = options.group ?? false;
    const fixed = value.toFixed(maxDecimals);
    const [intPart, fracPart = ""] = fixed.split(".");
    let trimmedFrac = fracPart;
    while (trimmedFrac.length > minDecimals && trimmedFrac.endsWith("0")) {
        trimmedFrac = trimmedFrac.slice(0, -1);
    }
    const raw = trimmedFrac.length > 0 ? `${intPart}.${trimmedFrac}` : intPart;
    const normalized = raw === "-0" ? "0" : raw;
    return group ? addThousandsSeparators(normalized) : normalized;
}

function formatPrice(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    return value.toFixed(8);
}

function formatInterval(sec: number | null | undefined): string {
    if (!sec || !Number.isFinite(sec) || sec <= 0) return "-";
    if (sec < 60) return `${Math.floor(sec)}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function getQuoteFromPair(pair: string): string {
    const parts = pair.split("/");
    return parts.length > 1 ? parts[1] : "";
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function formatConfigNumber(value: unknown, maxDecimals = 2, group = false): string {
    const num = toFiniteNumber(value);
    if (num === null) return "?";
    return formatNumber(num, { maxDecimals, group });
}

function sanitizeReason(value: unknown, maxLen = 60): string {
    if (!value) return "";
    const text = String(value).replace(/\s+/g, " ").trim();
    if (!text) return "";
    return truncateText(text, maxLen);
}

function formatPepewBalance(value: number | null | undefined): string {
    const numeric = toFiniteNumber(value);
    if (numeric === null) return "-";
    const abs = Math.abs(numeric);
    if (abs >= 1) return formatNumber(numeric, { maxDecimals: 0, group: true });
    return formatNumber(numeric, { maxDecimals: 4, minDecimals: 0, group: false });
}

function formatStrategyParams(config: StrategyConfig): string {
    const params = (config.params || {}) as Record<string, any>;
    const quote = getQuoteFromPair(config.pair);

    if (config.strategy === "DCA") {
        const budget = formatConfigNumber(params.budget, 2, false);
        const intervalSec = toFiniteNumber(params.intervalSec) ?? toFiniteNumber(params.interval_sec) ?? 600;
        return `budget ${budget} ${quote} · every ${formatInterval(intervalSec)}`;
    }

    if (config.strategy === "GRID") {
        const levels = params.grid_levels ?? "?";
        const stepPct = toFiniteNumber(params.grid_step_pct);
        const step = stepPct === null ? "?" : `${formatNumber(stepPct * 100, { maxDecimals: 2 })}%`;
        const budget = formatConfigNumber(params.total_quote_budget, 2, false);
        return `levels ${levels} · step ${step} · budget ${budget} ${quote}`;
    }

    if (config.strategy === "MM") {
        const spreadPct = toFiniteNumber(params.spread_pct);
        const spread = spreadPct === null ? "?" : `${formatNumber(spreadPct * 100, { maxDecimals: 2 })}%`;
        const ordersPerSide = params.orders_per_side ?? 1;
        const refresh = toFiniteNumber(params.refresh_sec) ?? 15;
        return `spread ${spread} · orders ${ordersPerSide} · refresh ${formatInterval(refresh)}`;
    }

    return "configured";
}

function getStrategyRuntimeStatus(config: StrategyConfig): { icon: string; text: string } {
    if (config.disabledReason) {
        return { icon: "⛔", text: `AUTO-STOPPED (${sanitizeReason(config.disabledReason, 32)})` };
    }
    if (config.backoff && config.backoff.remainingSec > 0) {
        return { icon: "⏳", text: `BACKOFF ${formatInterval(config.backoff.remainingSec)}` };
    }
    return config.enabled ? { icon: "✅", text: "ACTIVE" } : { icon: "⏸️", text: "STOPPED" };
}

function getDevmmStatusIcon(status: DevmmStatusEntry["status"] | string): string {
    if (status === "ACTIVE") return "🟢";
    if (status === "DEGRADED") return "⚠️";
    if (status === "PAUSED") return "⏸";
    return "⏹️";
}

function countTrackedOrders(entry: DevmmStatusEntry): number {
    return (entry.orders?.buyOrderId ? 1 : 0) + (entry.orders?.sellOrderId ? 1 : 0);
}

function resolveManagedOpenOrders(entry: DevmmStatusEntry): number {
    if (typeof entry.openOrdersManaged === "number") return entry.openOrdersManaged;
    const fromBySide = entry.openOrdersManagedBySide || entry.openOrdersBySide;
    if (fromBySide) return (fromBySide.buy || 0) + (fromBySide.sell || 0);
    return countTrackedOrders(entry);
}

function resolveRawOpenOrders(entry: DevmmStatusEntry): number {
    if (typeof entry.openOrdersRaw === "number") return entry.openOrdersRaw;
    if (typeof entry.openOrdersManaged === "number") return entry.openOrdersManaged;
    return countTrackedOrders(entry);
}

function resolveUnmanagedOpenOrders(entry: DevmmStatusEntry): number {
    if (typeof entry.openOrdersUnmanaged === "number") return entry.openOrdersUnmanaged;
    const raw = resolveRawOpenOrders(entry);
    const managed = resolveManagedOpenOrders(entry);
    return Math.max(0, raw - managed);
}

function resolveManagedBySide(entry: DevmmStatusEntry): { buy: number; sell: number } {
    if (entry.openOrdersManagedBySide) {
        return {
            buy: entry.openOrdersManagedBySide.buy || 0,
            sell: entry.openOrdersManagedBySide.sell || 0,
        };
    }
    if (entry.openOrdersBySide) {
        return {
            buy: entry.openOrdersBySide.buy || 0,
            sell: entry.openOrdersBySide.sell || 0,
        };
    }
    return {
        buy: entry.orders?.buyOrderId ? 1 : 0,
        sell: entry.orders?.sellOrderId ? 1 : 0,
    };
}

function normalizeIssueLabel(value: string): string {
    return value.replace(/^F\d+_/, "").replace(/_/g, " ").trim();
}

function getTopIssues(entry: DevmmStatusEntry, maxItems = 2): string[] {
    const results: string[] = [];
    const push = (v: string | null | undefined) => {
        if (!v) return;
        const text = sanitizeReason(v, 80);
        if (!text) return;
        if (!results.includes(text)) results.push(text);
    };

    const issueCodes = String(entry.issueCode || "")
        .split("|")
        .map((v) => v.trim())
        .filter(Boolean);
    for (const code of issueCodes) {
        if (code === "F07_ZERO_SPREAD_LOOP") {
            const source = entry.bookSource && entry.bookSource.includes("ticker")
                ? "ticker fallback"
                : "orderbook";
            push(`Spread=0 (${source})`);
            continue;
        }
        if (code === "F08_UNKNOWN_ORDERS_PRESENT") {
            const unmanaged = resolveUnmanagedOpenOrders(entry);
            push(`Unmanaged orders (${unmanaged})`);
            continue;
        }
        push(normalizeIssueLabel(code));
    }

    if (entry.pauseReason === "TICKER_FALLBACK_BOOK" && !results.some(v => v.toLowerCase().includes("fallback"))) {
        push("Data fallback");
    }
    if (!results.length && entry.statusHint) push(entry.statusHint);
    if (!results.length) push(entry.pauseReason || null);
    if (!results.length) push(entry.lastErrorCode || null);
    if (!results.length) push(entry.lastError || null);

    return results.slice(0, maxItems);
}

function formatDevmmOrdersInline(entry: DevmmStatusEntry): string | null {
    const managed = resolveManagedOpenOrders(entry);
    const raw = resolveRawOpenOrders(entry);
    const unmanaged = resolveUnmanagedOpenOrders(entry);
    const bySide = resolveManagedBySide(entry);
    if (unmanaged > 0) {
        return `Orders ${managed} managed / ${raw} on exchange (⚠️ unmanaged)`;
    }
    if (managed > 0) {
        return `Orders ${managed} (${bySide.buy}B/${bySide.sell}S)`;
    }
    if (raw > 0) {
        return `Orders ${raw} on exchange`;
    }
    return null;
}

function formatDevmmSummaryLine(entry: DevmmStatusEntry | null, exchange: ExchangeName): string {
    const label = exchangeLabel(exchange);
    if (!entry) {
        return `• ${label} ⏹️ STOPPED`;
    }
    const status = entry.status || "STOPPED";
    const icon = getDevmmStatusIcon(status);
    const parts: string[] = [`${label} ${icon} ${status}`];
    const orderPart = formatDevmmOrdersInline(entry);
    if (orderPart) parts.push(orderPart);
    if (entry.market?.mid && Number.isFinite(entry.market.mid)) {
        parts.push(`Mid ${formatPrice(entry.market.mid)}`);
    }
    const issues = getTopIssues(entry, 1);
    if (issues.length > 0) {
        const text = issues[0].toLowerCase().includes("spread=0")
            ? `${issues[0]}, paused quoting`
            : issues[0];
        parts.push(text);
    }
    return `• ${parts.join(" · ")}`;
}

function formatDebugSection(entry: DevmmStatusEntry | null, exchange: ExchangeName): string[] {
    const label = exchangeLabel(exchange);
    if (!entry) {
        return [label, "• status          STOPPED (no data)"];
    }

    const decision = sanitizeReason(entry.lastDecision || entry.lastAction || "N/A", 120);
    const managed = resolveManagedOpenOrders(entry);
    const raw = resolveRawOpenOrders(entry);
    const unmanaged = resolveUnmanagedOpenOrders(entry);
    const issues = getTopIssues(entry, 2);
    const issueText = issues.length > 0 ? issues.join(" | ") : "-";

    const inventoryText = entry.inventory && !("status" in entry.inventory)
        ? `USDT ${formatNumber(entry.inventory.usdtBalance, { maxDecimals: 4 })} | PEPEW ${formatPepewBalance(entry.inventory.pepewBalance)} | ${(entry.inventory.usdtShare ?? 0) * 100 > 0 ? `${formatNumber((entry.inventory.usdtShare ?? 0) * 100, { maxDecimals: 2 })}% USDT` : "-"}`
        : entry.inventory && "status" in entry.inventory
            ? `unavailable (${sanitizeReason(entry.inventory.reason || "unknown", 30)})`
            : "-";

    const turnover = entry.turnover
        ? (entry.turnover.hourUsdt > 0 || entry.turnover.capHourUsdt > 0
            ? `${formatNumber(entry.turnover.hourUsdt, { maxDecimals: 4 })} / ${formatNumber(entry.turnover.capHourUsdt, { maxDecimals: 4 })}`
            : "—")
        : "—";

    return [
        label,
        `• status          ${entry.status || "STOPPED"}`,
        `• mid / bid / ask ${formatPrice(entry.market?.mid)} / ${formatPrice(entry.market?.bid)} / ${formatPrice(entry.market?.ask)}`,
        `• turnover (1h)   ${turnover}`,
        `• inventory       ${inventoryText}`,
        `• open orders     ${managed} managed / ${raw} on exchange${unmanaged > 0 ? " (⚠️ unmanaged)" : ""}`,
        `• decision        ${decision}`,
        `• issueCode       ${entry.issueCode || "-"}`,
        `• issues          ${issueText}`,
        `• market source   ${entry.bookSource || "-"}`,
    ];
}

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
        if (!data.ok) {
            await safeSend(ctx, { step: "status.api_error", text: "❌ Failed to fetch status. Please try again." });
            await sendMainMenu(ctx);
            return;
        }

        let devmmEntries: DevmmStatusEntry[] = [];
        try {
            const devmm = await devmmStatus();
            if (devmm.ok && devmm.exchanges) devmmEntries = devmm.exchanges;
        } catch (devmmErr: any) {
            console.warn(`[status] failed to fetch devmm status: ${devmmErr?.message || devmmErr}`);
        }

        const devmmMap = new Map<ExchangeName, DevmmStatusEntry>();
        for (const entry of devmmEntries) {
            const normalized = normalizeExchange(entry.exchange);
            if (normalized) devmmMap.set(normalized, entry);
        }

        const tsCandidates: number[] = [];
        const lines: string[] = [
            "📊 Trade Status — PEPEPOW",
            "────────────────────",
            "",
            "🏦 Balances",
        ];

        const balancesMap = new Map<string, any>();
        for (const bal of data.balances || []) {
            balancesMap.set(bal.exchange, bal);
        }

        for (const exchange of EXCHANGE_ORDER) {
            const label = exchangeLabel(exchange).padEnd(9, " ");
            const bal = balancesMap.get(exchange);
            if (!bal) {
                lines.push(`• ${label} ⚪ no data`);
                continue;
            }
            if (bal.ok) {
                const snap = bal.snapshot;
                const usdtFree = snap?.assets?.USDT?.free ?? bal.assets?.USDT ?? 0;
                const bnbFree = snap?.assets?.BNB?.free ?? bal.assets?.BNB ?? 0;
                const pepewFree = snap?.assets?.PEPEW?.free ?? bal.assets?.PEPEW ?? 0;
                const updatedTs = snap?.ts || bal.lastOkTs;
                if (updatedTs) tsCandidates.push(updatedTs);

                const parts = [
                    `USDT ${formatNumber(usdtFree, { maxDecimals: 2, minDecimals: 2 })}`,
                ];
                if (exchange === "nonkyc") {
                    parts.push(`BNB ${formatNumber(bnbFree, { maxDecimals: 4, minDecimals: 4 })}`);
                }
                parts.push(`PEPEW ${formatPepewBalance(pepewFree)}`);
                lines.push(`• ${label} ${parts.join(" | ")}`);
            } else {
                const reason = sanitizeReason(bal.errCode || bal.reason || "BALANCE_FETCH_FAILED", 42);
                if (bal.lastOkTs) tsCandidates.push(bal.lastOkTs);
                lines.push(`• ${label} ⚠️ unavailable (${reason})`);
            }
        }

        lines.push("", "⚙️ Active Strategies");
        const realConfigs = (data.configs || []).filter(c => c.tradeMode === "REAL" && c.enabled);
        const activeStrategies = realConfigs.filter((cfg) => getStrategyRuntimeStatus(cfg).text === "ACTIVE");
        if (activeStrategies.length === 0) {
            lines.push("• None active");
        } else {
            for (const cfg of activeStrategies) {
                const exchangeDisplay = exchangeLabel(cfg.exchange || "");
                lines.push(`• ${cfg.strategy} ${exchangeDisplay} ${cfg.pair} · ${formatStrategyParams(cfg)}`);
                if (cfg.lastRunAt) tsCandidates.push(cfg.lastRunAt);
            }
        }

        lines.push("", "🤖 DevMM Summary");
        const devmmDisplayRows = EXCHANGE_ORDER
            .map((exchange) => ({ exchange, entry: devmmMap.get(exchange) || null }))
            .filter(({ entry }) => {
                if (!entry) return false;
                const raw = resolveRawOpenOrders(entry);
                return entry.status !== "STOPPED" || raw > 0 || !!entry.isEnabled;
            });
        if (devmmDisplayRows.length === 0) {
            lines.push("• None active");
        }
        for (const { exchange, entry } of devmmDisplayRows) {
            lines.push(formatDevmmSummaryLine(entry, exchange));
            if (entry?.updatedAt) tsCandidates.push(entry.updatedAt);
            if (entry?.lastActionAt) tsCandidates.push(entry.lastActionAt);
        }
        const degradedSummary = devmmDisplayRows
            .filter(({ entry }) => !!entry && (entry.status === "DEGRADED" || entry.status === "PAUSED"))
            .map(({ exchange }) => exchangeLabel(exchange));
        if (degradedSummary.length > 0) {
            lines.push(`⚠️ Degraded: ${degradedSummary.join(", ")}`);
        }

        const lastUpdateTs = tsCandidates.length > 0 ? Math.max(...tsCandidates) : Date.now();
        lines.push("", `⏱ Last update: ${formatTimeHHmm(lastUpdateTs)}`);

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

export async function handleDebug(ctx: Context): Promise<void> {
    const rawTgUserId = ctx.from?.id;
    if (!rawTgUserId) {
        await safeSend(ctx, { step: "debug.no_user", text: "❌ Could not identify user (missing Telegram ID)." });
        await sendMainMenu(ctx);
        return;
    }
    const tgUserId = String(rawTgUserId);

    try {
        const statusData = await getStrategyStatus(tgUserId);
        if (!statusData.ok) {
            await safeSend(ctx, { step: "debug.status_error", text: "❌ Failed to fetch debug data." });
            await sendMainMenu(ctx);
            return;
        }

        const devmm = await devmmStatus();
        if (!devmm.ok) {
            await safeSend(ctx, { step: "debug.devmm_error", text: "❌ Failed to fetch DevMM debug data." });
            await sendMainMenu(ctx);
            return;
        }

        const devmmMap = new Map<ExchangeName, DevmmStatusEntry>();
        for (const entry of devmm.exchanges || []) {
            const normalized = normalizeExchange(entry.exchange);
            if (normalized) devmmMap.set(normalized, entry);
        }

        const lines: string[] = [
            "🛠 Debug — DevMM Details",
            "────────────────────",
        ];

        if (statusData.debug) {
            lines.push(
                "",
                `balance source: ${statusData.debug.balance_source || "-"}`,
                `cache age ms: ${formatNumber(statusData.debug.cacheAgeMs, { maxDecimals: 0, group: true })}`
            );
        }

        for (const exchange of EXCHANGE_ORDER) {
            lines.push("");
            lines.push(...formatDebugSection(devmmMap.get(exchange) || null, exchange));
        }

        await safeSend(ctx, { step: "debug.success", text: lines.join("\n") });
        await sendMainMenu(ctx);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[debug] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[debug] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "debug.error", text: "❌ Failed to fetch debug data. Please try again." });
        await sendMainMenu(ctx);
    }
}

export async function handleStrategyMenu(ctx: Context): Promise<void> {
    const keyboard = withMenuNav(new InlineKeyboard()
        .text("DCA", buildStrategyCallback("open", "dca"))
        .text("GRID", buildStrategyCallback("open", "grid")).row()
        .text("MM", buildStrategyCallback("open", "mm"))
        .text("DEVMM", buildStrategyCallback("open", "devmm")));

    await safeSend(ctx, {
        step: "strategy.menu",
        text: renderMenu("⚙ Strategy Control", "Choose what to manage:"),
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
