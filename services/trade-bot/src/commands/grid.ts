import { Context, InlineKeyboard } from "grammy";
import { ApiError, enableStrategyConfig, disableStrategyConfig, getStrategyStatus, upsertStrategyConfig, getKeysStatus, checkStrategyFunds, cancelStrategyOrders } from "../api.js";
import { logTelegramError, safeSend } from "../utils/telegram.js";
import { ExchangeName, formatPairDisplay, formatPairLabel, getAllowedPairs } from "../lib/markets.js";
import { getRegistryPromptHelpers } from "../lib/registryPrompt.js";

const GRID_STATE_TTL_MS = 15 * 60 * 1000;
const GRID_CALLBACK_MAX_BYTES = 64;

type GridWizardState = {
    step: "exchange" | "pair" | "levels" | "step" | "budget";
    exchange?: ExchangeName;
    symbol?: string;
    levels?: number;
    stepPct?: number;
    quotePerOrder?: number;
    updatedAt: number;
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

function buildCallbackData(action: string, value: string): string {
    const data = `grid:${action}:${value}`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > GRID_CALLBACK_MAX_BYTES) {
        console.error(`[grid_wizard] callback_data too long: bytes=${bytes} data=${data}`);
        return "grid:invalid";
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

export async function handleGrid(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "grid.no_user", text: "❌ Could not identify user." });
        return;
    }

    pendingGrid.set(tgUserId, { step: "exchange", updatedAt: Date.now() });

    const keyboard = new InlineKeyboard()
        .text("NonKYC", buildCallbackData("exchange", "nonkyc"))
        .text("Dex-Trade", buildCallbackData("exchange", "dextrade"))
        .text("NestEx", buildCallbackData("exchange", "nestex"));

    await safeSend(ctx, { step: "grid.exchange", text: "⚙️ Select exchange for GRID:", replyMarkup: keyboard });
}

export async function handleGridStart(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "grid_start.no_user", text: "❌ Could not identify user." });
        return;
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const gridConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "GRID");

        if (!gridConfigs.length) {
            await safeSend(ctx, { step: "grid_start.none", text: "No GRID config found. Use /grid to create one." });
            return;
        }

        const inactive = gridConfigs.filter((cfg) => !cfg.enabled);
        if (inactive.length === 1) {
            await enableStrategyConfig(inactive[0].id, tgUserId);
            await safeSend(ctx, { step: "grid_start.ok", text: "✅ GRID started." });
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
        await safeSend(ctx, { step: "grid_start.error", text: "❌ Failed to start GRID. Please try again." });
    }
}

export async function handleGridStop(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "grid_stop.no_user", text: "❌ Could not identify user." });
        return;
    }

    try {
        const status = await getStrategyStatus(tgUserId);
        const gridConfigs = (status.configs || []).filter((cfg) => cfg.strategy === "GRID");
        const active = gridConfigs.filter((cfg) => cfg.enabled);

        if (!active.length) {
            await safeSend(ctx, { step: "grid_stop.none", text: "No active GRID config found." });
            return;
        }

        if (active.length === 1) {
            await disableStrategyConfig(active[0].id, tgUserId);
            // Also trigger exchange order cancellation
            let stats = "";
            try {
                const res = await cancelStrategyOrders(active[0].id, tgUserId);
                if (res.ok) {
                    stats = ` ${res.message || ""}`;
                }
            } catch (err) {
                console.warn(`[grid_stop] failed to trigger exchange cancel: ${err}`);
            }
            await safeSend(ctx, { step: "grid_stop.ok", text: `🛑 GRID stopped.${stats}` });
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const cfg of active) {
            const label = `${exchangeLabel(cfg.exchange as ExchangeName)} ${cfg.pair} (${cfg.tradeMode})`;
            keyboard.text(label, buildCallbackData("stop", String(cfg.id))).row();
        }

        await safeSend(ctx, { step: "grid_stop.select", text: "Select GRID config to stop:", replyMarkup: keyboard });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[grid_stop] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[grid_stop] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "grid_stop.error", text: "❌ Failed to stop GRID. Please try again." });
    }
}

export async function handleGridCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("grid:")) return false;

    const tgUserId = getTgUserId(ctx);
    const parts = data.split(":");
    const action = parts[1];
    const value = parts[2];

    if (!tgUserId) {
        await safeSend(ctx, { step: "grid.cb.no_user", text: "❌ Could not identify user." });
        await safeAnswerCallbackQuery(ctx, "grid.cb.no_user");
        return true;
    }

    if (action === "start" && value) {
        await enableStrategyConfig(Number(value), tgUserId);
        await safeAnswerCallbackQuery(ctx, "grid.cb.start");
        await safeSend(ctx, { step: "grid.cb.start_msg", text: "✅ GRID started." });
        return true;
    }

    if (action === "stop" && value) {
        await disableStrategyConfig(Number(value), tgUserId);
        let stats = "";
        try {
            const res = await cancelStrategyOrders(Number(value), tgUserId);
            if (res.ok) {
                stats = ` ${res.message || ""}`;
            }
        } catch (err) {
            console.warn(`[grid.cb.stop] failed to trigger exchange cancel: ${err}`);
        }
        await safeAnswerCallbackQuery(ctx, "grid.cb.stop");
        await safeSend(ctx, { step: "grid.cb.stop_msg", text: `🛑 GRID stopped.${stats}` });
        return true;
    }

    const state = pendingGrid.get(tgUserId);
    if (!state || isExpired(state)) {
        pendingGrid.delete(tgUserId);
        await safeAnswerCallbackQuery(ctx, "grid.cb.expired");
        await safeSend(ctx, { step: "grid.cb.expired_msg", text: "GRID wizard expired. Use /grid to start again." });
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

        await safeSend(ctx, { step: "grid.pair", text: "Select pair for GRID:", replyMarkup: keyboard });
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
            text: `Enter grid levels for ${pairDisplay} (e.g. 10):`,
        });
        await safeAnswerCallbackQuery(ctx, "grid.cb.pair");
        return true;
    }

    // Callback action "mode" removed, fixed to REAL
    // Callback action "real_confirm" and "real_cancel" removed (direct start)

    await safeAnswerCallbackQuery(ctx, "grid.cb.unknown");
    return true;
}

export async function handleGridTextInput(ctx: Context): Promise<boolean> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) return false;

    const state = pendingGrid.get(tgUserId);
    if (!state) return false;
    if (isExpired(state)) {
        pendingGrid.delete(tgUserId);
        await safeSend(ctx, { step: "grid.expired", text: "GRID wizard expired. Use /grid to start again." });
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
        await safeSend(ctx, { step: "grid.step", text: "Enter grid step percentage (e.g. 1 for 1%):" });
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
        await safeSend(ctx, { step: "grid.budget", text: `Enter quote per order (> ${helpers.minLabel}, ${helpers.exampleLabel}):` });
        return true;
    }

    if (state.step === "budget") {
        const quotePerOrder = Number(text);
        const helpers = await getRegistryPromptHelpers(state.exchange!, state.symbol!);
        if (!Number.isFinite(quotePerOrder) || quotePerOrder <= helpers.minNotional) {
            const label = exchangeLabel(state.exchange!);
            await safeSend(ctx, { step: "grid.budget.invalid", text: `❌ ${label} minimum order is > ${helpers.minLabel}. Suggest > ${helpers.exampleLabel}.` });
            return true;
        }

        const levels = state.levels || 1;
        state.quotePerOrder = quotePerOrder;
        state.updatedAt = Date.now();
        pendingGrid.set(tgUserId, state);

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

        // Fixed to REAL mode, check keys
        try {
            const keysStatus = await getKeysStatus(tgUserId, state.exchange!);
            const hasKeys = keysStatus.ok && keysStatus.keys && keysStatus.keys.some(k => k.exchange === state.exchange && k.updatedAt);
            if (!hasKeys) {
                pendingGrid.delete(tgUserId);
                await safeSend(ctx, {
                    step: "grid.real.no_keys",
                    text: `❌ No API keys set for ${exchangeLabel(state.exchange!)}. Use /keys first.`,
                });
                return true;
            }
        } catch (err: any) {
            console.error(`[grid_wizard] keys check error: ${err?.message || err}`);
        }

        // Perform funds check before creating
        if (state.exchange === "nonkyc") {
            try {
                const fundsResult = await checkStrategyFunds(tgUserId, state.exchange, state.symbol!, "GRID", params);
                if (fundsResult.ok && fundsResult.status === "FAIL") {
                    pendingGrid.delete(tgUserId);
                    const lines = ["❌ Insufficient funds for GRID REAL mode:", "", ...(fundsResult.messages || []), "", "Please deposit more funds and try again."];
                    await safeSend(ctx, { step: "grid.real.insufficient_funds", text: lines.join("\n") });
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
                return true;
            }

            const pairDisplay = formatPairDisplay(state.exchange!, state.symbol!);
            const lines = [
                "✅ GRID created and started (REAL):",
                `Exchange: ${exchangeLabel(state.exchange!)}`,
                `Pair: ${pairDisplay}`,
                "Mode: REAL",
                `Levels: ${levels}`,
                `Step: ${formatQuantity(state.stepPct! * 100)}%`,
                `Quote/order: ${formatQuantity(quotePerOrder)} ${(await getRegistryPromptHelpers(state.exchange!, state.symbol!)).quoteAsset}`,
                "Status: ACTIVE",
            ];
            await safeSend(ctx, { step: "grid.create.ok", text: lines.join("\n") });
            return true;
        } catch (err: any) {
            pendingGrid.delete(tgUserId);
            console.error(`[grid_wizard] Error: ${err?.message || err}`);
            await safeSend(ctx, { step: "grid.create.error", text: "❌ Failed to create GRID config. Please try again." });
            return true;
        }
    }

    return false;
}
