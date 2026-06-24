import { Context, InlineKeyboard } from "grammy";
import { ApiError, setDcaConfig, startDca, stopDca, getDcaStatus, cancelStrategyOrders } from "../api.js";
import { renderMenu } from "../utils/menu.js";
import { logTelegramError, safeSend } from "../utils/telegram.js";
import { safeLower } from "../utils/strings.js";
import {
    ExchangeName,
    formatPairDisplay,
    formatPairLabel,
    getAllowedPairs,
    isExperimental,
} from "../lib/markets.js";
import { getRegistryPromptHelpers } from "../lib/registryPrompt.js";
import { sendMainMenu } from "./mainMenu.js";

const DCA_STATE_TTL_MS = 15 * 60 * 1000;
const DCA_CALLBACK_MAX_BYTES = 64;

type DcaWizardState = {
    step: "exchange" | "pair" | "budget" | "interval" | "budget_cap" | "duration_cap";
    exchange?: ExchangeName;
    symbol?: string;
    quoteAsset?: "BNB" | "USDT";
    budget?: number;
    intervalMin?: number;
    maxTotalSpend?: number;
    runForMinutes?: number;
    updatedAt: number;
};

const pendingDca = new Map<string, DcaWizardState>();

type SafeWizardOptions = {
    step: string;
    text: string;
    preferEdit?: boolean;
    replyMarkup?: InlineKeyboard;
};

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function formatInterval(sec: number): string {
    if (sec < 60) return `${sec} sec`;
    if (sec < 3600) return `${Math.floor(sec / 60)} min`;
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
}

function formatDateTime(ts: number | null | undefined): string {
    if (!ts || !Number.isFinite(ts)) return "-";
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function trimNumberString(value: string): string {
    return value.replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

function formatPrice(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
    const abs = Math.abs(value);
    if (abs < 1e-8) return value.toExponential(6);
    return trimNumberString(value.toPrecision(12));
}

function formatQuantity(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    if (abs < 1e-8) return value.toExponential(6);
    return trimNumberString(value.toPrecision(10));
}

function isExpired(state: DcaWizardState): boolean {
    return Date.now() - state.updatedAt > DCA_STATE_TTL_MS;
}

function exchangeLabel(exchange: ExchangeName): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade (Unavailable)";
    return "NestEx";
}

type DcaConfigSummary = {
    id: number;
    exchange: string;
    pair: string;
    symbol: string;
    quoteCcy: string;
    budget: number;
    intervalSec: number;
    enabled: boolean;
    tradeMode: string;
    strategy: string;
    lastRunAt: number | null;
    maxTotalSpend?: number | null;
    endsAt?: number | null;
};

function getPairDisplay(config: DcaConfigSummary): string {
    if (config.pair) return config.pair;
    const exchangeName = config.exchange as ExchangeName;
    return formatPairDisplay(exchangeName, config.symbol);
}

function buildConfigLabel(config: DcaConfigSummary): string {
    const exchangeDisplay =
        config.exchange === "nonkyc" || config.exchange === "dextrade" || config.exchange === "nestex"
            ? exchangeLabel(config.exchange as ExchangeName)
            : config.exchange;
    return `${exchangeDisplay} ${getPairDisplay(config)} (${config.tradeMode})`;
}

function formatConfigSummary(config: DcaConfigSummary): string[] {
    const exchangeDisplay =
        config.exchange === "nonkyc" || config.exchange === "dextrade" || config.exchange === "nestex"
            ? exchangeLabel(config.exchange as ExchangeName)
            : config.exchange;
    return [
        `Exchange: ${exchangeDisplay}`,
        `Pair: ${getPairDisplay(config)}`,
        `Mode: ${config.tradeMode}`,
        `Budget: ${formatQuantity(config.budget)} ${config.quoteCcy}`,
        `Interval: ${formatInterval(config.intervalSec)}`,
        `Status: ${config.enabled ? "ACTIVE" : "STOPPED"}`,
        `Max Spend: ${config.maxTotalSpend ? formatQuantity(config.maxTotalSpend) + " " + config.quoteCcy : "Unlimited"}`,
        `Ends At: ${config.endsAt ? formatDateTime(config.endsAt) : "Unlimited"}`,
        `Last run: ${formatDateTime(config.lastRunAt)}`,
    ];
}

function buildCallbackData(action: string, value: string): string {
    const data = `dca:${action}:${value}`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > DCA_CALLBACK_MAX_BYTES) {
        console.error(`[dca_wizard] callback_data too long: bytes=${bytes} data=${data}`);
        return "dca:invalid";
    }
    return data;
}

async function safeWizardMessage(ctx: Context, options: SafeWizardOptions): Promise<void> {
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? ctx.callbackQuery?.from?.id;

    const attempt = async (
        action: "editMessageText" | "sendMessage",
        fn: () => Promise<unknown>,
        text?: string
    ): Promise<{ ok: boolean }> => {
        try {
            await fn();
            return { ok: true };
        } catch (err: any) {
            const desc = safeLower(err?.description || err?.message || "");
            if (desc.includes("message is not modified")) {
                return { ok: true };
            }
            logTelegramError(err, { action, step: options.step, chatId, text });
            return { ok: false };
        }
    };

    if (options.preferEdit && ctx.callbackQuery?.message) {
        const res = await attempt(
            "editMessageText",
            () =>
                ctx.editMessageText(options.text, {
                    reply_markup: options.replyMarkup,
                }),
            options.text
        );
        if (res.ok) return;
    }

    await safeSend(ctx, { step: options.step, text: options.text, replyMarkup: options.replyMarkup });
}

async function safeAnswerCallbackQuery(ctx: Context, step: string): Promise<void> {
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? ctx.callbackQuery?.from?.id;
    try {
        await ctx.answerCallbackQuery();
    } catch (err: any) {
        logTelegramError(err, { action: "answerCallbackQuery", step, chatId });
    }
}

export async function handleDca(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "dca.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    pendingDca.set(tgUserId, { step: "exchange", updatedAt: Date.now() });

    const keyboard = new InlineKeyboard()
        .text("NonKYC", buildCallbackData("exchange", "nonkyc"))
        .text("NestEx", buildCallbackData("exchange", "nestex"));

    await safeSend(ctx, {
        step: "dca.exchange",
        text: renderMenu("🏦 Select Exchange", "DCA setup\nNonKYC / NestEx"),
        replyMarkup: keyboard,
    });
}

export async function handleDcaSet(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "dca_set.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 3) {
        await safeSend(ctx, {
            step: "dca_set.usage",
            text: [
                "❓ Usage: /dca_set <amount> <BNB|USDT> <interval_min>",
                "",
                "Examples:",
                "• /dca_set 1.05 USDT 10 — Buy with 1.05 USDT every 10 min",
            ].join("\n"),
        });
        return;
    }

    const budget = parseFloat(parts[0]);
    const mode = parts[1].toUpperCase();
    const intervalMin = parseInt(parts[2], 10);
    const tradeMode = "REAL"; // Fixed to REAL

    const helpers = await getRegistryPromptHelpers("nonkyc", parts[1]); // Quote CCY is actually the second part when normalized
    const minVal = helpers.minNotional;
    const minLabel = helpers.minLabel;
    const suggest = helpers.exampleLabel;

    if (isNaN(budget) || budget <= minVal) {
        await safeSend(ctx, { step: "dca_set.invalid_amount", text: `❌ NonKYC minimum order is > ${minLabel}. Suggest > ${suggest}.` });
        return;
    }

    if (mode !== "BNB" && mode !== "USDT") {
        await safeSend(ctx, { step: "dca_set.invalid_mode", text: "❌ Mode must be BNB or USDT." });
        return;
    }

    // tradeMode validation removed, fixed to REAL

    if (isNaN(intervalMin) || intervalMin < 1) {
        await safeSend(ctx, { step: "dca_set.invalid_interval", text: "❌ Interval must be at least 1 minute." });
        return;
    }

    const intervalSec = intervalMin * 60;

    try {
        const result = await setDcaConfig({
            tgUserId,
            mode: mode as "BNB" | "USDT",
            intervalSec,
            budget,
            tradeMode: tradeMode as "REAL",
            enabled: true,
        });

        if (!result.ok) {
            console.error(`[dca_set] API /v1/dca/config status=200 message=${result.error || "ok=false"}`);
            await safeSend(ctx, {
                step: "dca_set.api_error",
                text: `❌ Failed: ${result.error || "Unknown error"}`,
            });
            await sendMainMenu(ctx);
            return;
        }

        const cfg = result.config;
        const exchangeName = cfg.exchange as ExchangeName;
        const exchangeDisplay =
            exchangeName === "nonkyc" || exchangeName === "dextrade" || exchangeName === "nestex"
                ? exchangeLabel(exchangeName)
                : cfg.exchange;
        const pairDisplay = formatPairDisplay(exchangeName, cfg.symbol);

        const messageLines = [
            cfg.enabled ? "DCA created and started." : "DCA saved.",
            `Exchange: ${exchangeDisplay}`,
            `Pair: ${pairDisplay}`,
            `Budget: ${cfg.budget} ${cfg.quoteCcy} per order`,
            `Interval: ${formatInterval(cfg.intervalSec)}`,
            `Mode: ${cfg.tradeMode}`,
            `Status: ${cfg.enabled ? "ACTIVE" : "STOPPED"}`,
        ];

        if (!cfg.enabled) {
            messageLines.push("", "Use /dca_start to begin DCA.");
        }

        const message = messageLines.join("\n");

        await safeSend(ctx, { step: "dca_set.success", text: message });
        await sendMainMenu(ctx);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[dca_set] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[dca_set] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, {
            step: "dca_set.error",
            text: "❌ Failed to update config. Please try again.",
        });
        await sendMainMenu(ctx);
    }
}

export async function handleDcaStart(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "dca_start.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const status = await getDcaStatus(tgUserId);
        if (!status.ok) {
            console.error("[dca_start] API /v1/dca/status status=200 message=ok=false");
            await safeSend(ctx, {
                step: "dca_start",
                text: "❌ Failed to fetch configs. Please try again.",
            });
            return;
        }

        const configs = status.configs as DcaConfigSummary[];
        if (!configs || configs.length === 0) {
            await safeSend(ctx, {
                step: "dca_start.no_config",
                text: "No DCA config found. Use /dca to create one.",
            });
            await sendMainMenu(ctx);
            return;
        }

        if (configs.length === 1) {
            const cfg = configs[0];
            const result = await startDca({ tgUserId, configId: cfg.id });
            if (!result.ok) {
                console.error(`[dca_start] API /v1/dca/start status=200 message=${result.error || "ok=false"}`);
                await safeSend(ctx, {
                    step: "dca_start",
                    text: `❌ Failed: ${result.error || "Unknown error"}.`,
                });
                return;
            }

            const selected = (result.config || { ...cfg, enabled: true }) as DcaConfigSummary;
            const messageLines = ["DCA started.", ...formatConfigSummary(selected)];
            if (isExperimental(selected.exchange as ExchangeName, selected.symbol)) {
                messageLines.push("Note: Experimental / low liquidity. Use small amounts.");
            }

            await safeSend(ctx, {
                step: "dca_start",
                text: messageLines.join("\n"),
            });
            await sendMainMenu(ctx);
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const cfg of configs) {
            keyboard.text(buildConfigLabel(cfg), buildCallbackData("start", String(cfg.id))).row();
        }

        await safeSend(ctx, {
            step: "dca_start.select",
            text: "Select which DCA config to start:",
            replyMarkup: keyboard,
        });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[dca_start] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            const statusLabel = err.status ?? "n/a";
            await safeSend(ctx, {
                step: "dca_start",
                text: `❌ Failed (HTTP ${statusLabel}). ${err.message}`,
            });
            await sendMainMenu(ctx);
        } else {
            console.error(`[dca_start] Error: ${err?.message || err}`);
            await safeSend(ctx, {
                step: "dca_start",
                text: "❌ Failed (HTTP n/a).",
            });
            await sendMainMenu(ctx);
        }
    }
}

export async function handleDcaStop(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "dca_stop.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const status = await getDcaStatus(tgUserId);
        if (!status.ok) {
            console.error("[dca_stop] API /v1/dca/status status=200 message=ok=false");
            await safeSend(ctx, {
                step: "dca_stop.api_error",
                text: "❌ Failed to fetch configs. Please try again.",
            });
            return;
        }

        const configs = (status.configs || []) as DcaConfigSummary[];
        if (configs.length === 0) {
            await safeSend(ctx, {
                step: "dca_stop.no_config",
                text: "No DCA config found. Use /dca to create one.",
            });
            await sendMainMenu(ctx);
            return;
        }

        const activeConfigs = configs.filter((cfg) => cfg.enabled);
        if (activeConfigs.length === 0) {
            await safeSend(ctx, {
                step: "dca_stop.none_active",
                text: "No active DCA configs. Use /dca_start to begin.",
            });
            await sendMainMenu(ctx);
            return;
        }

        if (activeConfigs.length === 1) {
            const cfg = activeConfigs[0];
            const result = await stopDca({ tgUserId, configId: cfg.id });
            if (!result.ok) {
                console.error(`[dca_stop] API /v1/dca/stop status=200 message=${result.error || "ok=false"}`);
                await safeSend(ctx, {
                    step: "dca_stop.api_error",
                    text: "❌ Failed to stop DCA. Please try again.",
                });
                return;
            }

            const selected = (result.config || { ...cfg, enabled: false }) as DcaConfigSummary;

            let stats = "";
            try {
                const res = await cancelStrategyOrders(cfg.id, tgUserId);
                if (res.ok) {
                    stats = `\n${res.message || ""}`;
                }
            } catch (err) {
                console.warn(`[dca_stop] failed to trigger exchange cancel: ${err}`);
            }

            const messageLines = ["DCA stopped.", ...formatConfigSummary(selected), stats];
            await safeSend(ctx, {
                step: "dca_stop.success",
                text: messageLines.filter(Boolean).join("\n"),
            });
            await sendMainMenu(ctx);
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const cfg of activeConfigs) {
            keyboard.text(buildConfigLabel(cfg), buildCallbackData("stop", String(cfg.id))).row();
        }

        await safeSend(ctx, {
            step: "dca_stop.select",
            text: "Select which DCA config to stop:",
            replyMarkup: keyboard,
        });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[dca_stop] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[dca_stop] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, {
            step: "dca_stop.error",
            text: "❌ Failed to stop DCA. Please try again.",
        });
        await sendMainMenu(ctx);
    }
}

export async function handleDcaStatus(ctx: Context): Promise<void> {
    const rawTgUserId = ctx.from?.id;
    if (!rawTgUserId) {
        await safeSend(ctx, {
            step: "dca_status.no_user",
            text: "❌ Could not identify user (missing Telegram ID).",
        });
        await sendMainMenu(ctx);
        return;
    }
    const tgUserId = String(rawTgUserId);

    try {
        const data = await getDcaStatus(tgUserId);

        if (!data.ok) {
            console.error("[dca_status] API /v1/dca/status status=200 message=ok=false");
            await safeSend(ctx, {
                step: "dca_status.api_error",
                text: "❌ Failed to fetch status. Please try again.",
            });
            await sendMainMenu(ctx);
            return;
        }

        if (!data.configs || data.configs.length === 0) {
            await safeSend(ctx, {
                step: "dca_status.no_config",
                text: "No DCA config found. Use /dca to create one.",
            });
            await sendMainMenu(ctx);
            return;
        }

        const configs = data.configs as DcaConfigSummary[];
        const lines: string[] = ["Your DCA configurations:", ""];

        configs.forEach((cfg, index) => {
            const exchangeDisplay =
                cfg.exchange === "nonkyc" || cfg.exchange === "dextrade" || cfg.exchange === "nestex"
                    ? exchangeLabel(cfg.exchange as ExchangeName)
                    : cfg.exchange;
            lines.push(
                `${index + 1}) Exchange: ${exchangeDisplay}`,
                `   Pair: ${getPairDisplay(cfg)}`,
                `   Mode: ${cfg.tradeMode}`,
                `   Budget: ${formatQuantity(cfg.budget)} ${cfg.quoteCcy}`,
                `   Interval: ${formatInterval(cfg.intervalSec)}`,
                `   Status: ${cfg.enabled ? "ACTIVE" : "STOPPED"}`,
                `   Limit: ${cfg.maxTotalSpend ? "max " + formatQuantity(cfg.maxTotalSpend) + " " + cfg.quoteCcy : "no limit"}`,
                `   Ends: ${cfg.endsAt ? formatDateTime(cfg.endsAt) : "no limit"}`,
                `   Last run: ${formatDateTime(cfg.lastRunAt)}`,
                ""
            );
        });

        const orders = data.recentOrders || [];
        if (orders.length === 0) {
            lines.push("Recent orders (last 10):", "- None");
        } else {
            lines.push("Recent orders (last 10):");
            for (const order of orders.slice(0, 10)) {
                const pair = order.pair || formatPairDisplay(order.exchange as ExchangeName, order.symbol);
                const quoteCcy = pair.includes("/") ? pair.split("/")[1] : "";
                const amount = quoteCcy ? `${formatQuantity(order.quoteAmount)} ${quoteCcy}` : formatQuantity(order.quoteAmount);
                const exchangeDisplay =
                    order.exchange === "nonkyc" || order.exchange === "dextrade" || order.exchange === "nestex"
                        ? exchangeLabel(order.exchange as ExchangeName)
                        : order.exchange;
                lines.push(
                    `- [${exchangeDisplay} ${pair}] ${order.side} ${amount} @ ${formatPrice(order.price)}`
                );
            }
        }

        await safeSend(ctx, { step: "dca_status.success", text: lines.join("\n") });
        await sendMainMenu(ctx);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[dca_status] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
            const statusLabel = err.status ?? "n/a";
            const reason = err.message ? ` Reason: ${err.message}` : "";
            let hint = "";
            if (err.status === 400) {
                hint = " Hint: trade-api requires ?tgUserId=... on /v1/dca/status.";
            } else if (err.status === 404) {
                hint = " Hint: check trade-api route /v1/dca/status is deployed.";
            }
            await safeSend(ctx, {
                step: "dca_status.http_error",
                text: `❌ Failed to fetch status (HTTP ${statusLabel}).${reason}${hint}`,
            });
            await sendMainMenu(ctx);
            return;
        }
        console.error(`[dca_status] Error: ${err?.message || err}`);
        await safeSend(ctx, {
            step: "dca_status.error",
            text: "❌ Failed to fetch status. Please try again.",
        });
        await sendMainMenu(ctx);
    }
}

export async function handleDcaCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("dca:")) return false;

    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await ctx.answerCallbackQuery();
        return true;
    }

    const parts = data.split(":");
    const action = parts[1];
    const value = parts[2];

    if (action === "start" || action === "stop") {
        const configId = Number(value);
        if (!Number.isFinite(configId) || configId <= 0) {
            await safeAnswerCallbackQuery(ctx, `dca_${action}.invalid`);
            return true;
        }

        try {
            const result =
                action === "start"
                    ? await startDca({ tgUserId, configId })
                    : await stopDca({ tgUserId, configId });

            if (!result.ok) {
                await safeWizardMessage(ctx, {
                    step: `dca_${action}.api_error`,
                    text: `Failed to ${action} DCA: ${result.error || "Unknown error"}`,
                    preferEdit: true,
                });
                await safeAnswerCallbackQuery(ctx, `dca_${action}.api_error`);
                return true;
            }

            const cfg = result.config as DcaConfigSummary | undefined;

            let stats = "";
            if (action === "stop") {
                try {
                    const res = await cancelStrategyOrders(configId, tgUserId);
                    if (res.ok) {
                        stats = `\n${res.message || ""}`;
                    }
                } catch (err) {
                    console.warn(`[dca.cb.stop] failed to trigger exchange cancel: ${err}`);
                }
            }

            const messageLines = [
                action === "start" ? "DCA started." : "DCA stopped.",
                ...(cfg ? formatConfigSummary(cfg) : []),
                stats
            ];

            await safeWizardMessage(ctx, {
                step: `dca_${action}.done`,
                text: messageLines.filter(Boolean).join("\n"),
                preferEdit: true,
            });
            await safeAnswerCallbackQuery(ctx, `dca_${action}.done`);
            await sendMainMenu(ctx);
            return true;
        } catch (err: any) {
            if (err instanceof ApiError) {
                console.error(`[dca_${action}] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
                await safeWizardMessage(ctx, {
                    step: `dca_${action}.error`,
                    text: `Failed to ${action} DCA: ${err.message}`,
                    preferEdit: true,
                });
                await safeAnswerCallbackQuery(ctx, `dca_${action}.error`);
                await sendMainMenu(ctx);
                return true;
            } else {
                console.error(`[dca_${action}] Error: ${err?.message || err}`);
            }
            await safeWizardMessage(ctx, {
                step: `dca_${action}.error`,
                text: `Failed to ${action} DCA. Please try again.`,
                preferEdit: true,
            });
            await safeAnswerCallbackQuery(ctx, `dca_${action}.error`);
            await sendMainMenu(ctx);
            return true;
        }
    }

    const state = pendingDca.get(tgUserId);
    if (!state || isExpired(state)) {
        pendingDca.delete(tgUserId);
        await safeSend(ctx, {
            step: "dca_wizard.expired",
            text: "⌛ DCA setup expired. Please run /dca again.",
        });
        await ctx.answerCallbackQuery();
        return true;
    }

    if (action === "exchange") {
        if (value !== "nonkyc" && value !== "dextrade" && value !== "nestex") {
            await ctx.answerCallbackQuery({ text: "Invalid exchange" });
            return true;
        }

        const exchange = value as ExchangeName;
        pendingDca.set(tgUserId, { step: "pair", exchange, updatedAt: Date.now() });

        const keyboard = new InlineKeyboard();
        for (const pair of getAllowedPairs(exchange)) {
            keyboard.text(formatPairLabel(exchange, pair.symbol), buildCallbackData("pair", pair.symbol));
        }

        await safeSend(ctx, {
            step: "dca_wizard.pair",
            text: renderMenu("🧩 Select Pair", `Exchange: ${exchangeLabel(exchange)}`),
            replyMarkup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return true;
    }

    if (action === "pair") {
        const exchange = state.exchange;
        if (!exchange) {
            await safeSend(ctx, {
                step: "dca_wizard.missing_exchange",
                text: "❌ Missing exchange. Please run /dca again.",
            });
            await ctx.answerCallbackQuery();
            return true;
        }

        const pair = getAllowedPairs(exchange).find((item) => item.symbol === value);
        if (!pair) {
            await ctx.answerCallbackQuery({ text: "Invalid pair" });
            return true;
        }

        pendingDca.set(tgUserId, {
            step: "budget",
            exchange,
            symbol: pair.symbol,
            quoteAsset: pair.quoteAsset,
            updatedAt: Date.now(),
        });

        const helpers = await getRegistryPromptHelpers(state.exchange, pair.symbol);

        await safeSend(ctx, {
            step: "dca_wizard.budget",
            text: `Enter quote per order (> ${helpers.minLabel}, ${helpers.exampleLabel}):`,
        });
        await ctx.answerCallbackQuery();
        return true;
    }
    await ctx.answerCallbackQuery();
    return true;
}

export async function handleDcaTextInput(ctx: Context): Promise<boolean> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) return false;

    const text = ctx.message?.text || "";
    if (!text || text.startsWith("/")) return false;

    const state = pendingDca.get(tgUserId);
    if (!state) return false;

    if (isExpired(state)) {
        pendingDca.delete(tgUserId);
        await safeSend(ctx, {
            step: "dca_text.expired",
            text: "⌛ DCA setup expired. Please run /dca again.",
        });
        await sendMainMenu(ctx);
        return true;
    }

    if (state.step === "budget") {
        const budget = parseFloat(text.trim());
        const helpers = await getRegistryPromptHelpers(state.exchange!, state.symbol!);

        if (isNaN(budget) || budget <= helpers.minNotional) {
            const label = exchangeLabel(state.exchange!);
            await safeSend(ctx, {
                step: "dca_text.invalid_budget",
                text: `❌ ${label} minimum order is > ${helpers.minLabel}. Suggest > ${helpers.exampleLabel}.`,
            });
            return true;
        }

        pendingDca.set(tgUserId, {
            ...state,
            step: "interval",
            budget,
            updatedAt: Date.now(),
        });

        await safeSend(ctx, {
            step: "dca_text.interval_prompt",
            text: "Enter interval in minutes (e.g. 10):",
        });
        return true;
    }

    if (state.step === "interval") {
        const intervalMin = parseInt(text.trim(), 10);
        if (isNaN(intervalMin) || intervalMin < 1) {
            await safeSend(ctx, {
                step: "dca_text.invalid_interval",
                text: "❌ Interval must be at least 1 minute.",
            });
            return true;
        }

        pendingDca.set(tgUserId, {
            ...state,
            step: "budget_cap",
            intervalMin,
            updatedAt: Date.now(),
        });

        await safeSend(ctx, {
            step: "dca_text.budget_cap_prompt",
            text: "Enter max total spend (USDT), or 0 for unlimited:",
        });
        return true;
    }

    if (state.step === "budget_cap") {
        const maxTotalSpend = parseFloat(text.trim());
        if (isNaN(maxTotalSpend)) {
            await safeSend(ctx, { step: "dca_text.invalid_budget_cap", text: "❌ Invalid number. Enter 0 for unlimited." });
            return true;
        }

        pendingDca.set(tgUserId, {
            ...state,
            step: "duration_cap",
            maxTotalSpend: maxTotalSpend > 0 ? maxTotalSpend : undefined,
            updatedAt: Date.now(),
        });

        await safeSend(ctx, {
            step: "dca_text.duration_cap_prompt",
            text: "Run for how many minutes? (0 = unlimited):",
        });
        return true;
    }

    if (state.step === "duration_cap") {
        const runForMinutes = parseInt(text.trim(), 10);
        if (isNaN(runForMinutes)) {
            await safeSend(ctx, { step: "dca_text.invalid_duration_cap", text: "❌ Invalid number. Enter 0 for unlimited." });
            return true;
        }

        const intervalSec = state.intervalMin! * 60;
        try {
            const result = await setDcaConfig({
                tgUserId,
                exchange: state.exchange!,
                symbol: state.symbol!,
                quoteAsset: state.quoteAsset!,
                intervalSec,
                budget: state.budget!,
                maxTotalSpend: state.maxTotalSpend,
                runForMinutes: runForMinutes > 0 ? runForMinutes : undefined,
                tradeMode: "REAL",
                enabled: true,
            });

            pendingDca.delete(tgUserId);

            if (!result.ok) {
                await safeSend(ctx, {
                    step: "dca_wizard.final",
                    text: `❌ Failed to save DCA config (API error: ${result.error || "Unknown error"}).`,
                });
                await sendMainMenu(ctx);
                return true;
            }

            const cfg = result.config;
            const exchangeName = cfg.exchange as ExchangeName;
            const exchangeDisplay = exchangeLabel(exchangeName);
            const pairDisplay = formatPairDisplay(exchangeName, cfg.symbol);

            const message = [
                `✅ DCA created and started`,
                `Exchange: ${exchangeDisplay}`,
                `Pair: ${pairDisplay}`,
                `Budget: ${cfg.budget} ${cfg.quoteCcy}`,
                `Interval: ${formatInterval(cfg.intervalSec)}`,
                `Execution: ALL-IN`,
                `Status: ACTIVE`,
            ].join("\n");

            await safeSend(ctx, {
                step: "dca_wizard.final",
                text: message,
            });
            await sendMainMenu(ctx);
            return true;
        } catch (err: any) {
            pendingDca.delete(tgUserId);
            console.error(`[dca_wizard] Error: ${err?.message || err}`);
            await safeSend(ctx, {
                step: "dca_wizard.final",
                text: err instanceof ApiError ? `❌ ${err.message}` : "❌ Failed to save DCA config. Please try again.",
            });
            await sendMainMenu(ctx);
            return true;
        }
    }

    return false;
}

export function clearDcaState(tgUserId: string): void {
    pendingDca.delete(tgUserId);
}
