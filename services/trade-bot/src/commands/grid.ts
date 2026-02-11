import { Context, InlineKeyboard } from "grammy";
import { ApiError, enableStrategyConfig, disableStrategyConfig, getStrategyStatus, upsertStrategyConfig, getKeysStatus, checkStrategyFunds, cancelStrategyOrders } from "../api.js";
import { renderMenu } from "../utils/menu.js";
import { logTelegramError, safeSend } from "../utils/telegram.js";
import { ExchangeName, formatPairDisplay, formatPairLabel, getAllowedPairs } from "../lib/markets.js";
import { getRegistryPromptHelpers } from "../lib/registryPrompt.js";
import { sendMainMenu } from "./mainMenu.js";

const GRID_STATE_TTL_MS = 15 * 60 * 1000;
const GRID_CALLBACK_MAX_BYTES = 64;
const GRID_LEVEL_OPTIONS = [1, 2, 3, 5, 7, 10];
const GRID_STEP_OPTIONS = [1, 2, 3, 5, 10, 20, 30, 50, 100];
const GRID_NONKYC_BNB_QUOTE_OPTIONS = [0.0017, 0.002, 0.004, 0.006, 0.008, 0.01, 0.02, 0.05, 0.1];
const GRID_QUOTE_OPTIONS: Record<ExchangeName, number[]> = {
    nonkyc: [1.05, 3, 5, 10, 20, 35, 50, 100],
    dextrade: [5.1, 7, 10, 15, 20, 35, 50, 100],
    nestex: [0.5, 1, 3, 5, 10, 20, 35, 50, 100],
};

type GridWizardState = {
    step: "exchange" | "pair" | "levels" | "step" | "budget";
    exchange?: ExchangeName;
    symbol?: string;
    levels?: number;
    stepPct?: number;
    quotePerOrder?: number;
    updatedAt: number;
};

type GridConfigTarget = {
    id: number;
    exchange?: string;
    pair?: string;
};

const pendingGrid = new Map<string, GridWizardState>();

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function isExpired(state: GridWizardState): boolean {
    return Date.now() - state.updatedAt > GRID_STATE_TTL_MS;
}

function exchangeLabel(exchange: ExchangeName): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade";
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

function gridTargetLabel(target: GridConfigTarget): string {
    const exchange = toKnownExchange(target.exchange);
    const exchangeText = exchange ? exchangeLabel(exchange) : (target.exchange || "UnknownExchange");
    return `${exchangeText} ${target.pair || "UnknownPair"}`.trim();
}

function buildCallbackData(action: string, value: string): string {
    const data = `grid:${action}:${value}`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > GRID_CALLBACK_MAX_BYTES) {
        console.error(`[grid_wizard] callback_data too long: bytes=${bytes} data=${data}`);
        return "grid:invalid";
    }
    return data;
}

function buildLevelKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    GRID_LEVEL_OPTIONS.forEach((value, idx) => {
        keyboard.text(String(value), buildCallbackData("levels", String(value)));
        if ((idx + 1) % 3 === 0 && idx < GRID_LEVEL_OPTIONS.length - 1) {
            keyboard.row();
        }
    });
    return keyboard;
}

function buildStepKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    GRID_STEP_OPTIONS.forEach((value, idx) => {
        keyboard.text(`${value}%`, buildCallbackData("step", String(value)));
        if ((idx + 1) % 3 === 0 && idx < GRID_STEP_OPTIONS.length - 1) {
            keyboard.row();
        }
    });
    return keyboard;
}

function isNonKycBnbPair(exchange: ExchangeName, symbol?: string): boolean {
    if (exchange !== "nonkyc") return false;
    const normalized = String(symbol || "").toUpperCase();
    return normalized.endsWith("/BNB") || normalized.endsWith("_BNB") || normalized.endsWith("BNB");
}

function buildQuoteKeyboard(exchange: ExchangeName, symbol?: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const options = isNonKycBnbPair(exchange, symbol) ? GRID_NONKYC_BNB_QUOTE_OPTIONS : GRID_QUOTE_OPTIONS[exchange];
    options.forEach((value, idx) => {
        keyboard.text(String(value), buildCallbackData("quote", String(value)));
        if ((idx + 1) % 3 === 0 && idx < options.length - 1) {
            keyboard.row();
        }
    });
    return keyboard;
}

async function safeAnswerCallbackQuery(ctx: Context, step: string): Promise<void> {
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? ctx.callbackQuery?.from?.id;
    try {
        await ctx.answerCallbackQuery();
    } catch (err: any) {
        logTelegramError(err, { action: "answerCallbackQuery", step, chatId });
    }
}

async function stopGridConfigs(ctx: Context, tgUserId: string, configs: GridConfigTarget[]): Promise<void> {
    if (!configs.length) {
        await safeSend(ctx, { step: "grid_stop.none", text: "No active GRID config found." });
        await sendMainMenu(ctx);
        return;
    }

    let stoppedCount = 0;
    const stoppedLines: string[] = [];
    const failedLines: string[] = [];

    for (const cfg of configs) {
        const label = gridTargetLabel(cfg);
        try {
            await disableStrategyConfig(cfg.id, tgUserId, "STOPPING");
            stoppedCount += 1;
        } catch (disableErr: any) {
            failedLines.push(`${label}: disable failed (${disableErr?.message || "unknown"})`);
            continue;
        }

        try {
            const cancelRes = await cancelStrategyOrders(cfg.id, tgUserId);
            const cancelText = cancelRes.queued
                ? "cancel queued"
                : `cancelled ${cancelRes.cancelledCount ?? 0}`;
            stoppedLines.push(`${label} (${cancelText})`);
        } catch (cancelErr: any) {
            stoppedLines.push(`${label} (cancel failed)`);
            failedLines.push(`${label}: cancel failed (${cancelErr?.message || "unknown"})`);
        }
    }

    const lines = [`🛑 GRID stop completed: ${stoppedCount}/${configs.length} stopped.`];
    if (stoppedLines.length > 0) {
        lines.push("Stopped configs:", ...stoppedLines.map((line) => `- ${line}`));
    }
    if (failedLines.length > 0) {
        lines.push("Failed configs:", ...failedLines.map((line) => `- ${line}`));
    }
    await safeSend(ctx, { step: "grid_stop.summary", text: lines.join("\n") });
    await sendMainMenu(ctx);
}

export async function handleGrid(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "grid.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    pendingGrid.set(tgUserId, { step: "exchange", updatedAt: Date.now() });

    const keyboard = new InlineKeyboard()
        .text("NonKYC", buildCallbackData("exchange", "nonkyc"))
        .text("Dex-Trade", buildCallbackData("exchange", "dextrade"))
        .text("NestEx", buildCallbackData("exchange", "nestex"));

    await safeSend(ctx, {
        step: "grid.exchange",
        text: renderMenu("🏦 Select Exchange", "GRID setup\nNonKYC / Dex-Trade / NestEx"),
        replyMarkup: keyboard,
    });
}

export async function handleGridStart(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "grid_start.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const gridConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "GRID");

        if (!gridConfigs.length) {
            await safeSend(ctx, { step: "grid_start.none", text: "No GRID config found. Use /grid to create one." });
            await sendMainMenu(ctx);
            return;
        }

        const inactive = gridConfigs.filter((cfg) => !cfg.enabled);
        if (inactive.length === 1) {
            await enableStrategyConfig(inactive[0].id, tgUserId);
            await safeSend(ctx, { step: "grid_start.ok", text: "✅ GRID started." });
            await sendMainMenu(ctx);
            return;
        }

        const keyboard = new InlineKeyboard();
        const list = inactive.length ? inactive : gridConfigs;
        for (const cfg of list) {
            const label = `${exchangeLabel(cfg.exchange as ExchangeName)} ${cfg.pair} (${cfg.tradeMode})`;
            keyboard.text(label, buildCallbackData("start", String(cfg.id))).row();
        }

        await safeSend(ctx, { step: "grid_start.select", text: "Select GRID config to start:", replyMarkup: keyboard });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[grid_start] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[grid_start] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "grid_start.error", text: err instanceof ApiError ? `❌ ${err.message}` : "❌ Failed to start GRID. Please try again." });
        await sendMainMenu(ctx);
    }
}

export async function handleGridStop(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "grid_stop.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const gridConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "GRID");
        const active = gridConfigs.filter((cfg) => cfg.enabled);

        if (!active.length) {
            await safeSend(ctx, { step: "grid_stop.none", text: "No active GRID config found." });
            await sendMainMenu(ctx);
            return;
        }

        if (active.length === 1) {
            await stopGridConfigs(ctx, tgUserId, [{
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

        await safeSend(ctx, { step: "grid_stop.select", text: "Select GRID config to stop:", replyMarkup: keyboard });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[grid_stop] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[grid_stop] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "grid_stop.error", text: "❌ Failed to stop GRID. Please try again." });
        await sendMainMenu(ctx);
    }
}

export async function handleGridCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("grid:")) return false;

    const tgUserId = getTgUserId(ctx);
    const parts = data.split(":");
    const action = parts[1];
    const value = parts[2];
    const maybeExchange = value === "nonkyc" || value === "dextrade" || value === "nestex" ? value : "n/a";
    console.log(
        `[trade-bot] callback userId=${tgUserId || "unknown"} action=grid:${action || "unknown"} exchange=${maybeExchange} strategy=GRID params=${value || "n/a"}`
    );

    if (!tgUserId) {
        await safeSend(ctx, { step: "grid.cb.no_user", text: "❌ Could not identify user." });
        await safeAnswerCallbackQuery(ctx, "grid.cb.no_user");
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "start" && value) {
        try {
            await enableStrategyConfig(Number(value), tgUserId);
            await safeAnswerCallbackQuery(ctx, "grid.cb.start");
            await safeSend(ctx, { step: "grid.cb.start_msg", text: "✅ GRID started." });
            await sendMainMenu(ctx);
        } catch (err: any) {
            if (err instanceof ApiError) {
                console.error(`[grid.cb.start] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            } else {
                console.error(`[grid.cb.start] Error: ${err?.message || err}`);
            }
            await safeAnswerCallbackQuery(ctx, "grid.cb.start_error");
            await safeSend(ctx, { step: "grid.cb.start_error_msg", text: err instanceof ApiError ? `❌ ${err.message}` : "❌ Failed to start GRID. Please try again." });
            await sendMainMenu(ctx);
        }
        return true;
    }

    if (action === "stop" && value) {
        try {
            await safeAnswerCallbackQuery(ctx, "grid.cb.stop");
            const status = await getStrategyStatus(tgUserId);
            const active = (status.configs || []).filter((cfg) => cfg.strategy === "GRID" && cfg.enabled);
            const selected = active.find((cfg) => cfg.id === Number(value));
            await stopGridConfigs(ctx, tgUserId, [{
                id: Number(value),
                exchange: selected?.exchange,
                pair: selected?.pair,
            }]);
        } catch (err: any) {
            console.error(`[grid.cb.stop] Error: ${err?.message || err}`);
            await safeSend(ctx, { step: "grid.cb.stop_error_msg", text: err instanceof ApiError ? `❌ ${err.message}` : "❌ Failed to stop GRID. Please try again." });
            await sendMainMenu(ctx);
        }
        return true;
    }

    if (action === "stopall") {
        try {
            await safeAnswerCallbackQuery(ctx, "grid.cb.stopall");
            const status = await getStrategyStatus(tgUserId);
            const active = (status.configs || []).filter((cfg) => cfg.strategy === "GRID" && cfg.enabled);
            const targets = active.map((cfg) => ({ id: cfg.id, exchange: cfg.exchange, pair: cfg.pair }));
            await stopGridConfigs(ctx, tgUserId, targets);
        } catch (err: any) {
            console.error(`[grid.cb.stopall] Error: ${err?.message || err}`);
            await safeSend(ctx, { step: "grid.cb.stopall_error_msg", text: err instanceof ApiError ? `❌ ${err.message}` : "❌ Failed to stop GRID. Please try again." });
            await sendMainMenu(ctx);
        }
        return true;
    }

    const state = pendingGrid.get(tgUserId);
    if (!state || isExpired(state)) {
        pendingGrid.delete(tgUserId);
        await safeAnswerCallbackQuery(ctx, "grid.cb.expired");
        await safeSend(ctx, { step: "grid.cb.expired_msg", text: "GRID wizard expired. Use /grid to start again." });
        await sendMainMenu(ctx);
        return true;
    }

    if (action === "exchange" && value) {
        state.exchange = value as ExchangeName;
        state.step = "pair";
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);

        const keyboard = new InlineKeyboard();
        const pairs = getAllowedPairs(state.exchange);
        pairs.forEach((pair) => {
            const label = formatPairLabel(state.exchange as ExchangeName, pair.symbol);
            keyboard.text(label, buildCallbackData("pair", pair.symbol)).row();
        });

        await safeSend(ctx, {
            step: "grid.pair",
            text: renderMenu("🧩 Select Pair", "GRID pair selection"),
            replyMarkup: keyboard,
        });
        await safeAnswerCallbackQuery(ctx, "grid.cb.exchange");
        return true;
    }

    if (action === "pair" && value) {
        state.symbol = value;
        state.step = "levels";
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);

        const pairDisplay = state.exchange ? formatPairDisplay(state.exchange, value) : value;

        await safeSend(ctx, {
            step: "grid.levels",
            text: `Select grid levels for ${pairDisplay}:`,
            replyMarkup: buildLevelKeyboard(),
        });
        await safeAnswerCallbackQuery(ctx, "grid.cb.pair");
        return true;
    }

    if (action === "levels" && value) {
        const levels = Number(value);
        if (!GRID_LEVEL_OPTIONS.includes(levels)) {
            await safeAnswerCallbackQuery(ctx, "grid.cb.levels.invalid");
            return true;
        }
        state.levels = levels;
        state.step = "step";
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);
        await safeSend(ctx, {
            step: "grid.step",
            text: "Select grid step percentage:",
            replyMarkup: buildStepKeyboard(),
        });
        await safeAnswerCallbackQuery(ctx, "grid.cb.levels");
        return true;
    }

    if (action === "step" && value) {
        const step = Number(value);
        if (!GRID_STEP_OPTIONS.includes(step)) {
            await safeAnswerCallbackQuery(ctx, "grid.cb.step.invalid");
            return true;
        }
        state.stepPct = step / 100;
        state.step = "budget";
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);
        await safeSend(ctx, {
            step: "grid.budget",
            text: `Select quote per order for ${exchangeLabel(state.exchange!)}:`,
            replyMarkup: buildQuoteKeyboard(state.exchange!, state.symbol),
        });
        await safeAnswerCallbackQuery(ctx, "grid.cb.step");
        return true;
    }

    if (action === "quote" && value) {
        const quotePerOrder = Number(value);
        await safeAnswerCallbackQuery(ctx, "grid.cb.quote");
        return completeGridConfig(ctx, tgUserId, state, quotePerOrder);
    }

    // Callback action "mode" removed, fixed to REAL
    // Callback action "real_confirm" and "real_cancel" removed (direct start)

    await safeAnswerCallbackQuery(ctx, "grid.cb.unknown");
    return true;
}

async function completeGridConfig(ctx: Context, tgUserId: string, state: GridWizardState, quotePerOrder: number): Promise<boolean> {
    const helpers = await getRegistryPromptHelpers(state.exchange!, state.symbol!);
    if (!Number.isFinite(quotePerOrder) || quotePerOrder <= helpers.minNotional) {
        const label = exchangeLabel(state.exchange!);
        await safeSend(ctx, { step: "grid.budget.invalid", text: `❌ ${label} minimum order is > ${helpers.minLabel}. Suggest > ${helpers.exampleLabel}.` });
        return true;
    }

    const levels = state.levels || 1;
    const params = {
        base_price: 0,
        grid_levels: levels,
        grid_step_pct: state.stepPct,
        quote_per_order: quotePerOrder,
        per_order_quote: quotePerOrder, // compatibility
        refresh_sec: 30,
        allow_sell: true,
        inventory_base: 0,
    };

    try {
        const keysStatus = await getKeysStatus(tgUserId, state.exchange!);
        const hasKeys = keysStatus.ok && keysStatus.keys && keysStatus.keys.some(k => k.exchange === state.exchange && k.updatedAt);
        if (!hasKeys) {
            pendingGrid.delete(tgUserId);
            await safeSend(ctx, {
                step: "grid.real.no_keys",
                text: `❌ No API keys set for ${exchangeLabel(state.exchange!)}. Use /keys first.`,
            });
            await sendMainMenu(ctx);
            return true;
        }
    } catch (err: any) {
        console.error(`[grid_wizard] keys check error: ${err?.message || err}`);
    }

    if (state.exchange === "nonkyc") {
        try {
            const fundsResult = await checkStrategyFunds(tgUserId, state.exchange, state.symbol!, "GRID", params);
            if (fundsResult.ok && fundsResult.status === "FAIL") {
                pendingGrid.delete(tgUserId);
                const lines = ["❌ Insufficient funds for GRID REAL mode:", "", ...(fundsResult.messages || []), "", "Please deposit more funds and try again."];
                await safeSend(ctx, { step: "grid.real.insufficient_funds", text: lines.join("\n") });
                await sendMainMenu(ctx);
                return true;
            }
        } catch (err: any) {
            console.warn(`[grid_wizard] funds check failed: ${err?.message || err}`);
        }
    }

    try {
        const resp = await upsertStrategyConfig({
            tgUserId,
            exchange: state.exchange!,
            pair: state.symbol!,
            tradeMode: "REAL",
            strategy: "GRID",
            enabled: true,
            params,
        });

        pendingGrid.delete(tgUserId);

        if (!resp.ok || !resp.config) {
            await safeSend(ctx, { step: "grid.create.failed", text: "❌ Failed to create GRID config." });
            await sendMainMenu(ctx);
            return true;
        }

        const pairDisplay = formatPairDisplay(state.exchange!, state.symbol!);
        const lines = [
            "✅ GRID created and started:",
            `Exchange: ${exchangeLabel(state.exchange!)}`,
            `Pair: ${pairDisplay}`,
            "Mode: REAL",
            `Levels: ${levels}`,
            `Step: ${formatQuantity(state.stepPct! * 100)}%`,
            `Quote/order: ${formatQuantity(quotePerOrder)} ${(await getRegistryPromptHelpers(state.exchange!, state.symbol!)).quoteAsset}`,
            "Status: ACTIVE",
        ];
        await safeSend(ctx, { step: "grid.create.ok", text: lines.join("\n") });
        await sendMainMenu(ctx);
        return true;
    } catch (err: any) {
        pendingGrid.delete(tgUserId);
        console.error(`[grid_wizard] Error: ${err?.message || err}`);
        await safeSend(ctx, { step: "grid.create.error", text: err instanceof ApiError ? `❌ ${err.message}` : "❌ Failed to create GRID config. Please try again." });
        await sendMainMenu(ctx);
        return true;
    }
}

export async function handleGridTextInput(ctx: Context): Promise<boolean> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) return false;

    const state = pendingGrid.get(tgUserId);
    if (!state) return false;
    if (isExpired(state)) {
        pendingGrid.delete(tgUserId);
        await safeSend(ctx, { step: "grid.expired", text: "GRID wizard expired. Use /grid to start again." });
        await sendMainMenu(ctx);
        return true;
    }

    const text = (ctx.message?.text || "").trim();
    if (!text) return false;

    if (state.step === "levels") {
        const levels = Number(text);
        if (!Number.isFinite(levels) || levels <= 0 || !Number.isInteger(levels)) {
            await safeSend(ctx, { step: "grid.levels.invalid", text: "❌ Levels must be a positive integer." });
            return true;
        }
        state.levels = levels;
        state.step = "step";
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);
        await safeSend(ctx, {
            step: "grid.step",
            text: "Select grid step percentage (or type a number like 1 for 1%):",
            replyMarkup: buildStepKeyboard(),
        });
        return true;
    }

    if (state.step === "step") {
        const raw = text.replace(/%/g, "");
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            await safeSend(ctx, { step: "grid.step.invalid", text: "❌ Step must be a positive number." });
            return true;
        }
        // User input is percentage (e.g., 1 means 1%), store as ratio (0.01)
        const stepPct = value / 100;
        state.stepPct = stepPct;
        state.step = "budget"; // Fix: missing step advance
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);
        const helpers = await getRegistryPromptHelpers(state.exchange!, state.symbol!);
        await safeSend(ctx, {
            step: "grid.budget",
            text: `Select quote per order (or type manually, > ${helpers.minLabel}):`,
            replyMarkup: buildQuoteKeyboard(state.exchange!, state.symbol),
        });
        return true;
    }

    if (state.step === "budget") {
        const quotePerOrder = Number(text);
        return completeGridConfig(ctx, tgUserId, state, quotePerOrder);
    }

    return false;
}
