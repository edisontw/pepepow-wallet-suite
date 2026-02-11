import { Context, InlineKeyboard, Keyboard } from "grammy";
import { safeLower, safeText } from "./strings.js";

type TelegramErrorInfo = {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
};

export type SafeSendOptions = {
    step: string;
    text: string;
    replyMarkup?: InlineKeyboard | Keyboard;
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

/**
 * Send long text by splitting it into multiple messages if it exceeds maxLen.
 * Priority splitting by double newline (paragraphs), then single newline, then hard cut.
 */
export async function sendLongText(
    ctx: Context,
    text: string,
    options: { maxLen?: number; step?: string; replyMarkup?: InlineKeyboard | Keyboard } = {}
): Promise<void> {
    const maxLen = options.maxLen || 3000;
    const step = options.step || "send_long_text";

    if (text.length <= maxLen) {
        await safeSend(ctx, { step, text, replyMarkup: options.replyMarkup });
        return;
    }

    console.log(`[tg] sendLongText: splitting message of length ${text.length} into parts of max ${maxLen}`);

    const parts: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            parts.push(remaining);
            break;
        }

        // Try to find a good split point
        let splitIndex = -1;
        const chunk = remaining.slice(0, maxLen);

        // 1. Try double newline
        splitIndex = chunk.lastIndexOf("\n\n");

        // 2. Try single newline
        if (splitIndex < maxLen * 0.5) {
            const lastNewline = chunk.lastIndexOf("\n");
            if (lastNewline > maxLen * 0.7) {
                splitIndex = lastNewline;
            }
        }

        // 3. Fallback to hard cut if no good newline found
        if (splitIndex === -1 || splitIndex < maxLen * 0.3) {
            splitIndex = maxLen;
        }

        parts.push(remaining.slice(0, splitIndex).trim());
        remaining = remaining.slice(splitIndex).trim();
    }

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        await safeSend(ctx, {
            step: `${step}_part${i + 1}`,
            text: parts[i],
            // Only attach keyboard to the last message if provided
            replyMarkup: isLast ? options.replyMarkup : undefined,
        });
        // Tiny delay to avoid hitting rate limits or message order issues
        if (!isLast) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}
