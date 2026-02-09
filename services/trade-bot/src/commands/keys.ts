import { Context, InlineKeyboard } from "grammy";
import { ApiError, setExchangeKeys, clearExchangeKeys, getKeysStatus } from "../api.js";
import { safeSend } from "../utils/telegram.js";
import { safeText, truncateText } from "../utils/strings.js";
import { ExchangeName } from "../lib/markets.js";
import { sendMainMenu } from "./mainMenu.js";

const KEY_STATE_TTL_MS = 15 * 60 * 1000;

type KeysState = {
    step: "exchange" | "apiKey" | "apiSecret";
    exchange?: ExchangeName;
    apiKey?: string;
    updatedAt: number;
};

const pendingKeys = new Map<string, KeysState>();

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function exchangeLabel(exchange: ExchangeName): string {
    if (exchange === "nonkyc") return "NonKYC";
    if (exchange === "dextrade") return "Dex-Trade";
    return "NestEx";
}

function isExpired(state: KeysState): boolean {
    return Date.now() - state.updatedAt > KEY_STATE_TTL_MS;
}

export async function handleKeys(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "keys.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    pendingKeys.set(tgUserId, { step: "exchange", updatedAt: Date.now() });

    const keyboard = new InlineKeyboard()
        .text("NonKYC", "keys:exchange:nonkyc")
        .text("Dex-Trade", "keys:exchange:dextrade")
        .text("NestEx", "keys:exchange:nestex");

    await safeSend(ctx, {
        step: "keys.exchange",
        text: "🔐 Select exchange to set API keys:\n\nSecurity note: Use trade-only keys. IP whitelist is recommended if your exchange supports it.",
        replyMarkup: keyboard,
    });
}

export async function handleKeysStatus(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "keys_status.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    try {
        const data = await getKeysStatus(tgUserId, undefined, true);
        if (!data.ok) {
            await safeSend(ctx, { step: "keys_status.api_error", text: "❌ Failed to fetch keys status." });
            await sendMainMenu(ctx);
            return;
        }

        const knownExchanges: ExchangeName[] = ["nonkyc", "dextrade", "nestex"];
        const keyMap = new Map<string, { updatedAt: number | null; validation?: { ok: boolean; reason?: string; message?: string } }>();
        for (const entry of data.keys || []) {
            keyMap.set(entry.exchange, { updatedAt: entry.updatedAt || null, validation: entry.validation });
        }

        let message = "🔐 API Keys Status\n\n";
        for (const exchange of knownExchanges) {
            const entry = keyMap.get(exchange);
            const updated = entry?.updatedAt ? new Date(entry.updatedAt).toISOString() : "Not set";
            message += `• ${exchangeLabel(exchange)}: ${entry?.updatedAt ? "✅ Set" : "❌ Not set"}`;
            message += `\n  Updated: ${updated}`;
            if (entry?.validation) {
                if (entry.validation.ok) {
                    message += `\n  Status: OK`;
                } else {
                    const reason = entry.validation.reason || "ERROR";
                    const detail = entry.validation.message ? truncateText(safeText(entry.validation.message), 120) : "";
                    message += `\n  Status: ${reason}${detail ? ` - ${detail}` : ""}`;
                }
            }
            message += "\n";
        }

        await safeSend(ctx, { step: "keys_status.success", text: message });
        await sendMainMenu(ctx);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[keys_status] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[keys_status] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "keys_status.error", text: "❌ Failed to fetch keys status." });
        await sendMainMenu(ctx);
    }
}

export async function handleKeysClear(ctx: Context): Promise<void> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await safeSend(ctx, { step: "keys_clear.no_user", text: "❌ Could not identify user." });
        await sendMainMenu(ctx);
        return;
    }

    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/).slice(1);
    const exchangeArg = parts[0]?.toLowerCase();

    if (exchangeArg === "nonkyc" || exchangeArg === "dextrade" || exchangeArg === "nestex") {
        await clearKeysForExchange(ctx, tgUserId, exchangeArg as ExchangeName);
        return;
    }

    const keyboard = new InlineKeyboard()
        .text("NonKYC", "keys:clear:nonkyc")
        .text("Dex-Trade", "keys:clear:dextrade")
        .text("NestEx", "keys:clear:nestex");

    await safeSend(ctx, {
        step: "keys_clear.exchange",
        text: "🧹 Select exchange to clear keys:",
        replyMarkup: keyboard,
    });
}

async function clearKeysForExchange(ctx: Context, tgUserId: string, exchange: ExchangeName): Promise<void> {
    try {
        const result = await clearExchangeKeys(tgUserId, exchange);
        if (!result.ok) {
            await safeSend(ctx, { step: "keys_clear.api_error", text: "❌ Failed to clear keys." });
            await sendMainMenu(ctx);
            return;
        }

        await safeSend(ctx, { step: "keys_clear.success", text: `✅ ${exchangeLabel(exchange)} keys cleared.` });
        await sendMainMenu(ctx);
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[keys_clear] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[keys_clear] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "keys_clear.error", text: "❌ Failed to clear keys." });
        await sendMainMenu(ctx);
    }
}

export async function handleKeysCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("keys:")) {
        return false;
    }

    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) {
        await ctx.answerCallbackQuery();
        return true;
    }

    const parts = data.split(":");
    const action = parts[1];
    const exchange = parts[2] as ExchangeName | undefined;

    if (!exchange || (exchange !== "nonkyc" && exchange !== "dextrade" && exchange !== "nestex")) {
        await ctx.answerCallbackQuery({ text: "Invalid exchange" });
        return true;
    }

    if (action === "exchange") {
        pendingKeys.set(tgUserId, { step: "apiKey", exchange, updatedAt: Date.now() });
        await safeSend(ctx, {
            step: "keys.api_key",
            text: `Enter ${exchangeLabel(exchange)} API Key:`,
        });
        await ctx.answerCallbackQuery();
        return true;
    }

    if (action === "clear") {
        await clearKeysForExchange(ctx, tgUserId, exchange);
        await ctx.answerCallbackQuery();
        return true;
    }

    await ctx.answerCallbackQuery();
    return true;
}

export async function handleKeysTextInput(ctx: Context): Promise<boolean> {
    const tgUserId = getTgUserId(ctx);
    if (!tgUserId) return false;

    const text = ctx.message?.text || "";
    if (!text || text.startsWith("/")) return false;

    const state = pendingKeys.get(tgUserId);
    if (!state) return false;

    if (isExpired(state)) {
        pendingKeys.delete(tgUserId);
        await safeSend(ctx, { step: "keys_text.expired", text: "⌛ Key setup expired. Please run /keys again." });
        await sendMainMenu(ctx);
        return true;
    }

    if (state.step === "apiKey") {
        pendingKeys.set(tgUserId, {
            step: "apiSecret",
            exchange: state.exchange,
            apiKey: text.trim(),
            updatedAt: Date.now(),
        });
        await safeSend(ctx, { step: "keys_text.secret_prompt", text: "Enter API Secret:" });
        return true;
    }

    if (state.step === "apiSecret") {
        const exchange = state.exchange;
        const apiKey = state.apiKey || "";
        const apiSecret = text.trim();

        if (!exchange || !apiKey || !apiSecret) {
            pendingKeys.delete(tgUserId);
            await safeSend(ctx, { step: "keys_text.missing_data", text: "❌ Missing key data. Please run /keys again." });
            return true;
        }

        try {
            const validate = exchange === "dextrade" || exchange === "nestex";
            const result = await setExchangeKeys(tgUserId, exchange, apiKey, apiSecret, validate);
            pendingKeys.delete(tgUserId);

            if (!result.ok) {
                await safeSend(ctx, { step: "keys_text.api_error", text: "❌ Failed to save keys. Please try again." });
                await sendMainMenu(ctx);
                return true;
            }

            let message = `✅ ${exchangeLabel(exchange)} keys set/updated.`;
            if (validate) {
                if (result.validation?.ok === false) {
                    message += `\n❌ Validation failed: ${result.validation.error || "unknown error"}`;
                } else if (result.validation?.ok) {
                    message += `\n✅ Validation success.`;
                    if (result.validation.details?.assets) {
                        message += `\nDetected assets: ${result.validation.details.assets.join(", ")}`;
                    }
                }
                if (exchange === "nestex") {
                    message += "\nNote: NestEx Private API is Experimental. Use small amounts.";
                }
            }
            await safeSend(ctx, { step: "keys_text.success", text: message });
            await sendMainMenu(ctx);
            return true;
        } catch (err: any) {
            pendingKeys.delete(tgUserId);
            if (err instanceof ApiError) {
                console.error(`[keys_set] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);

                // Parse error code and show user-friendly, safe message
                const errCode = err.message;
                let userMessage = "❌ Failed to save keys. Please try again.";

                if (errCode === "MISSING_KEYS_ENC_KEY") {
                    userMessage = "❌ Key storage is not configured. Please contact admin.";
                } else if (errCode === "SQLITE_ERROR") {
                    userMessage = "❌ Database error. Please contact admin.";
                } else if (errCode === "VALIDATION_ERROR") {
                    userMessage = "❌ Invalid input. Please check your API key format.";
                }

                await safeSend(ctx, { step: "keys_text.error", text: userMessage });
                await sendMainMenu(ctx);
                return true;
            } else {
                console.error(`[keys_set] Error: ${err?.message || err}`);
            }
            await safeSend(ctx, { step: "keys_text.error", text: "❌ Failed to save keys. Please try again." });
            await sendMainMenu(ctx);
            return true;
        }
    }

    return false;
}

export function clearKeysState(tgUserId: string): void {
    pendingKeys.delete(tgUserId);
}
