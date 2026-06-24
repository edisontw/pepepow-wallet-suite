import { Context, InlineKeyboard } from "grammy";
import { ApiError, enableStrategyConfig, disableStrategyConfig, getStrategyStatus, upsertStrategyConfig, getKeysStatus, checkStrategyFunds, cancelStrategyOrders } from "../api.js";
import { renderMenu } from "../utils/menu.js";
import { logTelegramError, safeSend } from "../utils/telegram.js";
import { ExchangeName, formatPairDisplay, formatPairLabel, getAllowedPairs } from "../lib/markets.js";
import { getRegistryPromptHelpers } from "../lib/registryPrompt.js";
import { sendMainMenu } from "./mainMenu.js";

const MM_STATE_TTL_MS = 15 * 60 * 1000;
const MM_CALLBACK_MAX_BYTES = 64;
const MM_NESTEX_MIN_QUOTE = 0.0015;
const MM_NONKYC_BNB_QUOTE_OPTIONS = [0.0017, 0.002, 0.004, 0.006, 0.008, 0.01, 0.02, 0.05, 0.1];
const MM_QUOTE_OPTIONS: Record<ExchangeName, number[]> = {
    nonkyc: [1.05, 3, 5, 10, 20, 35, 50, 100],
    dextrade: [5.1, 7, 10, 15, 20, 35, 50, 100],
    nestex: [0.5, 1, 3, 5, 10, 20, 35, 50, 100],
};

type MmWizardState = {
    step: "exchange" | "pair" | "spread" | "order" | "orders_per_side";
    exchange?: ExchangeName;
    symbol?: string;
    spreadPct?: number;
    orderQuote?: number;
    ordersPerSide?: number;
    pendingConfigId?: number;
    updatedAt: number;
};

const pendingMm = new Map<string, MmWizardState>();

type MmPromptHelpers = {
    quoteAsset: "USDT" | "BNB";
    minNotional: number;
    minLabel: string;
    exampleLabel: string;
};

type MmConfigTarget = {
    id: number;
    exchange?: string;
    pair?: string;
};

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function isExpired(state: MmWizardState): boolean {
    return Date.now() - state.updatedAt > MM_STATE_TTL_MS;
}

function exchangeLabel(exchange: ExchangeName): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade (Unavailable)";
    return "NestEx";
}

function formatDateTime(ts: number | null | undefined): string {
    if (!ts || !Number.isFinite(ts)) return "-";
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function trimNumberString(value: string): string {
    return value.replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

function formatQuantity(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    if (abs < 1e-8) return value.toExponential(6);
    return trimNumberString(value.toPrecision(10));
}

function toKnownExchange(value: string | undefined): ExchangeName | null {
    if (value === "nonkyc" || value === "dextrade" || value === "nestex") return value;
    return null;
}

function mmTargetLabel(target: MmConfigTarget): string {
    const exchange = toKnownExchange(target.exchange);
    const exchangeText = exchange ? exchangeLabel(exchange) : (target.exchange || "UnknownExchange");
    return `${exchangeText} ${target.pair || "UnknownPair"}`.trim();
}

function buildSpreadKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("1%", buildCallbackData("spread", "1"))
        .text("2%", buildCallbackData("spread", "2"))
        .text("3%", buildCallbackData("spread", "3"))
        .row()
        .text("4%", buildCallbackData("spread", "4"))
        .text("5%", buildCallbackData("spread", "5"));
}

function isNonKycBnbPair(exchange: ExchangeName, symbol?: string): boolean {
    if (exchange !== "nonkyc") return false;
    const normalized = String(symbol || "").toUpperCase();
    return normalized.endsWith("/BNB") || normalized.endsWith("_BNB") || normalized.endsWith("BNB");
}

function buildQuoteKeyboard(exchange: ExchangeName, symbol?: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const options = isNonKycBnbPair(exchange, symbol) ? MM_NONKYC_BNB_QUOTE_OPTIONS : MM_QUOTE_OPTIONS[exchange];
    options.forEach((value, idx) => {
        keyboard.text(String(value), buildCallbackData("quote", String(value)));
        if ((idx + 1) % 3 === 0 && idx < options.length - 1) {
            keyboard.row();
        }
    });
    return keyboard;
}

function formatApiErrorText(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.message) {
        return `❌ ${err.message}`;
    }
    return fallback;
}

async function getMmPromptHelpers(exchange: ExchangeName, pair: string): Promise<MmPromptHelpers> {
    const helpers = await getRegistryPromptHelpers(exchange, pair) as MmPromptHelpers;
    if (exchange !== "nestex") {
        return helpers;
    }
    return {
        ...helpers,
        quoteAsset: "USDT",
        minNotional: MM_NESTEX_MIN_QUOTE,
        minLabel: `${MM_NESTEX_MIN_QUOTE} USDT`,
        exampleLabel: "e.g. 0.002 USDT",
    };
}

async function stopMmConfigs(ctx: Context, tgUserId: string, configs: MmConfigTarget[]): Promise<void> {
    if (!configs.length) {
        await safeSend(ctx, { step: "mm_stop.none", text: "No active MM config found." });
        await sendMainMenu(ctx);
        return;
    }

    await safeSend(ctx, { step: "mm_stop.stopping", text: "🛑 MM stopping... cancelling orders" });

    let stoppedCount = 0;
    const stoppedLines: string[] = [];
    const failedLines: string[] = [];

    for (const cfg of configs) {
        const label = mmTargetLabel(cfg);
        try {
            await disableStrategyConfig(cfg.id, tgUserId, "STOPPING");
            stoppedCount += 1;
        } catch (disableErr: any) {
            console.warn(`[mm_stop] disable failed id=${cfg.id}: ${disableErr?.message}`);
            failedLines.push(`${label}: disable failed (${disableErr?.message || "unknown"})`);
            continue;
        }

        try {
            const cancelResult = await cancelStrategyOrders(cfg.id, tgUserId);
            const cancelText = cancelResult.queued
                ? "cancel queued"
                : `cancelled ${cancelResult.cancelledCount ?? 0}`;
            stoppedLines.push(`${label} (${cancelText})`);
        } catch (cancelErr: any) {
            console.warn(`[mm_stop] cancel orders failed id=${cfg.id}: ${cancelErr?.message}`);
            stoppedLines.push(`${label} (cancel failed)`);
            failedLines.push(`${label}: cancel failed (${cancelErr?.message || "unknown"})`);
        }
    }

    const lines = [`🛑 MM stop completed: ${stoppedCount}/${configs.length} stopped.`];
    if (stoppedLines.length) {
        lines.push("Stopped configs:", ...stoppedLines.map((line) => `- ${line}`));
    }
    if (failedLines.length) {
        lines.push("Failed configs:", ...failedLines.map((line) => `- ${line}`));
    }

    await safeSend(ctx, { step: "mm_stop.summary", text: lines.join("\n") });
    await sendMainMenu(ctx);
}

function buildCallbackData(action: string, value: string): string {
    const data = `mm:${action}:${value}`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MM_CALLBACK_MAX_BYTES) {
        console.error(`[mm_wizard] callback_data too long: bytes=${bytes} data=${data}`);
        return "mm:invalid";
    }
    return data;
}

async function safeAnswerCallbackQuery(ctx: Context, step: string): Promise<void> {
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? ctx.callbackQuery?.from?.id;
    try {
        await ctx.answerCallbackQuery();
    } catch (err: any) {
        logTelegramError(err, { action: "answerCallbackQuery", step, chatId });
    }
}

export async function handleMm(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "mm.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    pendingMm.set(tgUserId, { step: "exchange", updatedAt: Date.now() });

    const keyboard = new InlineKeyboard()
        .text("NonKYC", buildCallbackData("exchange", "nonkyc"))
        .text("NestEx", buildCallbackData("exchange", "nestex"));

    await safeSend(ctx, {
        step: "mm.exchange",
        text: renderMenu("🏦 Select Exchange", "MM setup\nNonKYC / NestEx"),
        replyMarkup: keyboard,
    });
}

export async function handleMmStart(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "mm_start.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const mmConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "MM");

        if (!mmConfigs.length) {
            await safeSend(ctx, { step: "mm_start.none", text: "No MM config found. Use /mm to create one." });
            await sendMainMenu(ctx);
            return;
        }

        const inactive = mmConfigs.filter((cfg) => !cfg.enabled);
        if (inactive.length === 1) {
            await enableStrategyConfig(inactive[0].id, tgUserId);
            await safeSend(ctx, { step: "mm_start.ok", text: "✅ MM started." });
            await sendMainMenu(ctx);
            return;
        }

        const keyboard = new InlineKeyboard();
        const list = inactive.length ? inactive : mmConfigs;
        for (const cfg of list) {
            const label = `${exchangeLabel(cfg.exchange as ExchangeName)} ${cfg.pair} (${cfg.tradeMode})`;
            keyboard.text(label, buildCallbackData("start", String(cfg.id))).row();
        }

        await safeSend(ctx, { step: "mm_start.select", text: "Select MM config to start:", replyMarkup: keyboard });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[mm_start] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[mm_start] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "mm_start.error", text: formatApiErrorText(err, "❌ Failed to start MM. Please try again.") });
        await sendMainMenu(ctx);
    }
}

export async function handleMmStop(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "mm_stop.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const mmConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "MM");
        const active = mmConfigs.filter((cfg) => cfg.enabled);

        if (!active.length) {
            await safeSend(ctx, { step: "mm_stop.none", text: "No active MM config found." });
            await sendMainMenu(ctx);
            return;
        }

        if (active.length === 1) {
            await stopMmConfigs(ctx, tgUserId, [{
                id: active[0].id,
                exchange: active[0].exchange,
                pair: active[0].pair,
            }]);
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const cfg of active) {
            const label = `${exchangeLabel(cfg.exchange as ExchangeName)} ${cfg.pair}`;
            keyboard.text(label, buildCallbackData("stop", String(cfg.id))).row();
        }
        keyboard.text("Stop All", buildCallbackData("stopall", "all"));

        await safeSend(ctx, { step: "mm_stop.select", text: "Select MM config to stop:", replyMarkup: keyboard });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[mm_stop] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[mm_stop] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "mm_stop.error", text: "❌ Failed to stop MM. Please try again." });
        await sendMainMenu(ctx);
    }
}

export async function handleMmCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("mm:")) return false;

    const tgUserId = getTgUserId(ctx);
    const parts = data.split(":");
    const action = parts[1];
    const value = parts[2];
    const maybeExchange = value === "nonkyc" || value === "dextrade" || value === "nestex" ? value : "n/a";
    console.log(
        `[trade-bot] callback userId=${tgUserId || "unknown"} action=mm:${action || "unknown"} exchange=${maybeExchange} strategy=MM params=${value || "n/a"}`
    );

    if (!tgUserId) {
        await safeSend(ctx, { step: "mm.cb.no_user", text: "❌ Could not identify user." });
        await safeAnswerCallbackQuery(ctx, "mm.cb.no_user");
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "start" && value) {
        try {
            await enableStrategyConfig(Number(value), tgUserId);
            await safeAnswerCallbackQuery(ctx, "mm.cb.start");
            await safeSend(ctx, { step: "mm.cb.start_msg", text: "✅ MM started." });
            await sendMainMenu(ctx);
        } catch (err: any) {
            if (err instanceof ApiError) {
                console.error(`[mm.cb.start] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            } else {
                console.error(`[mm.cb.start] Error: ${err?.message || err}`);
            }
            await safeAnswerCallbackQuery(ctx, "mm.cb.start_error");
            await safeSend(ctx, { step: "mm.cb.start_error_msg", text: formatApiErrorText(err, "❌ Failed to start MM. Please try again.") });
            await sendMainMenu(ctx);
        }
        return true;
    }

    if (action === "stop" && value) {
        try {
            await safeAnswerCallbackQuery(ctx, "mm.cb.stop");
            const status = await getStrategyStatus(tgUserId);
            const mmConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "MM" && cfg.enabled);
            const selected = mmConfigs.find((cfg) => cfg.id === Number(value));
            await stopMmConfigs(ctx, tgUserId, [{
                id: Number(value),
                exchange: selected?.exchange,
                pair: selected?.pair,
            }]);
        } catch (err: any) {
            if (err instanceof ApiError) {
                console.error(`[mm.cb.stop] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            } else {
                console.error(`[mm.cb.stop] Error: ${err?.message || err}`);
            }
            await safeSend(ctx, { step: "mm.cb.stop_error_msg", text: formatApiErrorText(err, "❌ Failed to stop MM. Please try again.") });
        }
        return true;
    }

    if (action === "stopall") {
        try {
            await safeAnswerCallbackQuery(ctx, "mm.cb.stopall");
            const status = await getStrategyStatus(tgUserId);
            const mmConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "MM" && cfg.enabled);
            const targets = mmConfigs.map((cfg) => ({ id: cfg.id, exchange: cfg.exchange, pair: cfg.pair }));
            await stopMmConfigs(ctx, tgUserId, targets);
        } catch (err: any) {
            if (err instanceof ApiError) {
                console.error(`[mm.cb.stopall] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            } else {
                console.error(`[mm.cb.stopall] Error: ${err?.message || err}`);
            }
            await safeSend(ctx, { step: "mm.cb.stopall_error_msg", text: formatApiErrorText(err, "❌ Failed to stop MM. Please try again.") });
        }
        return true;
    }

    const state = pendingMm.get(tgUserId);
    if (!state || isExpired(state)) {
        pendingMm.delete(tgUserId);
        await safeAnswerCallbackQuery(ctx, "mm.cb.expired");
        await safeSend(ctx, { step: "mm.cb.expired_msg", text: "MM wizard expired. Use /mm to start again." });
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "exchange" && value) {
        state.exchange = value as ExchangeName;
        state.step = "pair";
        state.updatedAt = Date.now();
        pendingMm.set(tgUserId, state);

        const keyboard = new InlineKeyboard();
        const pairs = getAllowedPairs(state.exchange);
        pairs.forEach((pair) => {
            const label = formatPairLabel(state.exchange as ExchangeName, pair.symbol);
            keyboard.text(label, buildCallbackData("pair", pair.symbol)).row();
        });

        await safeSend(ctx, {
            step: "mm.pair",
            text: renderMenu("🧩 Select Pair", "MM pair selection"),
            replyMarkup: keyboard,
        });
        await safeAnswerCallbackQuery(ctx, "mm.cb.exchange");
        return true;
    }

    if (action === "pair" && value) {
        state.symbol = value;
        state.step = "spread";
        state.updatedAt = Date.now();
        pendingMm.set(tgUserId, state);

        const pairDisplay = state.exchange ? formatPairDisplay(state.exchange, value) : value;

        await safeSend(ctx, {
            step: "mm.spread",
            text: `Select spread percentage for ${pairDisplay}:`,
            replyMarkup: buildSpreadKeyboard(),
        });
        await safeAnswerCallbackQuery(ctx, "mm.cb.pair");
        return true;
    }

    if (action === "spread" && value) {
        const spreadValue = Number(value);
        if (![1, 2, 3, 4, 5].includes(spreadValue)) {
            await safeAnswerCallbackQuery(ctx, "mm.cb.invalid_spread");
            return true;
        }

        state.spreadPct = spreadValue / 100;
        state.step = "order";
        state.updatedAt = Date.now();
        pendingMm.set(tgUserId, state);

        const helpers = await getMmPromptHelpers(state.exchange!, state.symbol!);
        await safeSend(ctx, {
            step: "mm.order",
            text: `Select quote per order for ${exchangeLabel(state.exchange!)} (${helpers.minLabel} minimum):`,
            replyMarkup: buildQuoteKeyboard(state.exchange!, state.symbol),
        });
        await safeAnswerCallbackQuery(ctx, "mm.cb.spread");
        return true;
    }

    if (action === "quote" && value) {
        const orderQuote = Number(value);
        const helpers = await getMmPromptHelpers(state.exchange!, state.symbol!);
        if (!Number.isFinite(orderQuote) || orderQuote <= helpers.minNotional) {
            await safeSend(ctx, {
                step: "mm.quote.invalid",
                text: `❌ ${exchangeLabel(state.exchange!)} minimum order is > ${helpers.minLabel}.`,
            });
            return true;
        }
        state.orderQuote = orderQuote;
        state.step = "orders_per_side";
        state.updatedAt = Date.now();
        pendingMm.set(tgUserId, state);

        const keyboard = new InlineKeyboard()
            .text("1", buildCallbackData("ops", "1"))
            .text("3", buildCallbackData("ops", "3"))
            .text("5", buildCallbackData("ops", "5"));
        await safeSend(ctx, {
            step: "mm.orders_per_side",
            text: "Select max orders per side (1 = simple, 3/5 = ladder):",
            replyMarkup: keyboard,
        });
        await safeAnswerCallbackQuery(ctx, "mm.cb.quote");
        return true;
    }

    if (action === "ops" && value) {
        const ordersPerSide = Number(value);
        if (![1, 3, 5].includes(ordersPerSide)) {
            await safeAnswerCallbackQuery(ctx, "mm.cb.invalid_ops");
            return true;
        }

        state.ordersPerSide = ordersPerSide;
        state.updatedAt = Date.now();
        pendingMm.set(tgUserId, state);

        if (!state.exchange || !state.symbol || !state.spreadPct || !state.orderQuote || !state.ordersPerSide) {
            pendingMm.delete(tgUserId);
            await safeSend(ctx, { step: "mm.missing", text: "❌ MM wizard missing data. Please try /mm again." });
            await safeAnswerCallbackQuery(ctx, "mm.cb.missing");
            await sendMainMenu(ctx);
            return true;
        }

        const params = {
            mid_source: "exchange",
            spread_pct: state.spreadPct,
            quote_per_order: state.orderQuote,
            order_quote: state.orderQuote, // Keep for backward compatibility
            orders_per_side: state.ordersPerSide,
            refresh_sec: 15,
            max_position_base: 0,
            inventory_base: 0,
            inventory_quote: state.orderQuote * 10,
        };

        // Fixed to REAL mode, check keys
        try {
            const keysStatus = await getKeysStatus(tgUserId, state.exchange);
            const hasKeys = keysStatus.ok && keysStatus.keys && keysStatus.keys.some(k => k.exchange === state.exchange && k.updatedAt);
            if (!hasKeys) {
                pendingMm.delete(tgUserId);
                await safeSend(ctx, {
                    step: "mm.real.no_keys",
                    text: `❌ No API keys set for ${exchangeLabel(state.exchange!)}. Use /keys first.`,
                });
                await safeAnswerCallbackQuery(ctx, "mm.cb.no_keys");
                await sendMainMenu(ctx);
                return true;
            }
        } catch (err: any) {
            console.error(`[mm.ops] keys check error: ${err?.message || err}`);
        }

        // Perform funds check
        if (state.exchange === "nonkyc") {
            try {
                const fundsResult = await checkStrategyFunds(tgUserId, state.exchange, state.symbol, "MM", params);
                if (fundsResult.ok && fundsResult.status === "FAIL") {
                    pendingMm.delete(tgUserId);
                    const lines = ["❌ Insufficient funds for MM REAL mode:", "", ...(fundsResult.messages || []), "", "Please deposit more funds and try again."];
                    await safeSend(ctx, { step: "mm.real.insufficient_funds", text: lines.join("\n") });
                    await safeAnswerCallbackQuery(ctx, "mm.cb.insufficient_funds");
                    await sendMainMenu(ctx);
                    return true;
                }
            } catch (err: any) {
                console.warn(`[mm.ops] funds check failed: ${err?.message || err}`);
            }
        }

        try {
            const resp = await upsertStrategyConfig({
                tgUserId,
                exchange: state.exchange,
                pair: state.symbol,
                tradeMode: "REAL",
                strategy: "MM",
                enabled: true,
                params,
            });

            pendingMm.delete(tgUserId);

            if (!resp.ok || !resp.config) {
                await safeSend(ctx, { step: "mm.create.failed", text: "❌ Failed to create MM config." });
                await safeAnswerCallbackQuery(ctx, "mm.cb.create_failed");
                await sendMainMenu(ctx);
                return true;
            }

            const pairDisplay = formatPairDisplay(state.exchange, state.symbol);
            const helpers = await getMmPromptHelpers(state.exchange!, state.symbol!);
            const lines = [
                "✅ MM config created and started:",
                `Exchange: ${exchangeLabel(state.exchange)}`,
                `Pair: ${pairDisplay}`,
                "Mode: REAL",
                `Spread: ${formatQuantity(state.spreadPct * 100)}%`,
                `Quote/order: ${formatQuantity(state.orderQuote)} ${helpers.quoteAsset}`,
                `Orders/side: ${state.ordersPerSide}`,
                "Status: ACTIVE",
            ];
            await safeSend(ctx, { step: "mm.create.ok", text: lines.join("\n") });
            await safeAnswerCallbackQuery(ctx, "mm.cb.created");
            await sendMainMenu(ctx);
            return true;
        } catch (err: any) {
            pendingMm.delete(tgUserId);
            console.error(`[mm.ops] Error: ${err?.message || err}`);
            await safeSend(ctx, { step: "mm.create.error", text: formatApiErrorText(err, "❌ Failed to create MM config. Please try again.") });
            await safeAnswerCallbackQuery(ctx, "mm.cb.create_error");
            await sendMainMenu(ctx);
            return true;
        }
    }

    // Callback action "mode" removed, fixed to REAL
    // Callback action "real_confirm" and "real_cancel" removed (direct start)

    await safeAnswerCallbackQuery(ctx, "mm.cb.unknown");
    return true;
}

export async function handleMmTextInput(ctx: Context): Promise<boolean> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) return false;

    const state = pendingMm.get(tgUserId);
    if (!state) return false;
    if (isExpired(state)) {
        pendingMm.delete(tgUserId);
        await safeSend(ctx, { step: "mm.expired", text: "MM wizard expired. Use /mm to start again." });
        return true;
    }

    const text = (ctx.message?.text || "").trim();
    if (!text) return false;

    if (state.step === "spread") {
        await safeSend(ctx, { step: "mm.spread.text_disabled", text: "Use spread buttons (1%-5%) to continue." });
        return true;
    }

    if (state.step === "order") {
        const orderQuote = Number(text);
        const helpers = await getMmPromptHelpers(state.exchange!, state.symbol!);
        if (!Number.isFinite(orderQuote) || orderQuote <= helpers.minNotional) {
            const label = exchangeLabel(state.exchange!);
            await safeSend(ctx, {
                step: "mm.order.invalid",
                text: `❌ ${label} minimum order is > ${helpers.minLabel}. Suggest > ${helpers.exampleLabel}.`
            });
            return true;
        }

        state.orderQuote = orderQuote;
        state.step = "orders_per_side";
        state.updatedAt = Date.now();
        pendingMm.set(tgUserId, state);

        const keyboard = new InlineKeyboard()
            .text("1", buildCallbackData("ops", "1"))
            .text("3", buildCallbackData("ops", "3"))
            .text("5", buildCallbackData("ops", "5"));

        await safeSend(ctx, {
            step: "mm.orders_per_side",
            text: "Select max orders per side (1 = simple, 3/5 = ladder):",
            replyMarkup: keyboard,
        });
        return true;
    }

    return false;
}
