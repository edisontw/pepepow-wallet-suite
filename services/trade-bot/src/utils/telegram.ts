import { Context, InlineKeyboard } from "grammy";
import { safeLower, safeText } from "./strings.js";

type TelegramErrorInfo = {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
};

export type SafeSendOptions = {
    step: string;
    text: string;
    replyMarkup?: InlineKeyboard;
};

function extractTelegramError(err: any): TelegramErrorInfo {
    const apiError = err?.error ?? err?.response ?? err;
    const parameters = apiError?.parameters ?? err?.parameters ?? apiError?.response?.parameters;
    return {
        error_code: apiError?.error_code ?? err?.error_code ?? err?.code,
        description: apiError?.description ?? err?.description ?? err?.message,
        parameters: parameters,
    };
}

export function logTelegramError(
    err: any,
    meta: { action: string; step: string; chatId?: number | string; text?: string }
): void {
    const info = extractTelegramError(err);
    const code = info.error_code ?? "n/a";
    const desc = safeText(info.description ?? "n/a");
    const retryAfter = info.parameters?.retry_after;
    const chatId = meta.chatId ?? "n/a";

    console.error(`[tg] ${meta.action} failed: code=${code} desc=${desc} chatId=${chatId} step=${meta.step}`);
    console.error(`[tg] ${meta.action} error=${JSON.stringify({ error_code: info.error_code, description: info.description, parameters: info.parameters })}`);
    if (retryAfter !== undefined) {
        console.error(`[tg] ${meta.action} retry_after=${retryAfter} chatId=${chatId} step=${meta.step}`);
    }
    if (safeLower(desc).includes("parse entities")) {
        console.error(`[tg] ${meta.action} parse_error: parse_mode=none text_len=${meta.text?.length ?? 0} chatId=${chatId} step=${meta.step}`);
    }
}

function getChatId(ctx: Context): number | string | undefined {
    return ctx.chat?.id ?? ctx.from?.id ?? ctx.callbackQuery?.from?.id;
}

export async function safeSend(ctx: Context, options: SafeSendOptions): Promise<void> {
    const chatId = getChatId(ctx);
    if (!chatId) {
        console.error(`[tg] sendMessage skipped: missing chatId step=${options.step}`);
        return;
    }

    const sendOptions = options.replyMarkup ? { reply_markup: options.replyMarkup } : undefined;

    try {
        await ctx.api.sendMessage(chatId, options.text, sendOptions);
        return;
    } catch (err: any) {
        logTelegramError(err, {
            action: "sendMessage",
            step: options.step,
            chatId,
            text: options.text,
        });
    }

    try {
        await ctx.reply(options.text, sendOptions);
    } catch (err: any) {
        logTelegramError(err, {
            action: "reply",
            step: options.step,
            chatId,
            text: options.text,
        });
    }
}
