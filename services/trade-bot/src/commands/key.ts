import { Context, InlineKeyboard } from "grammy";
import { safeSend } from "../utils/telegram.js";
import { handleKeys, handleKeysClear, handleKeysStatus } from "./keys.js";
import { sendMainMenu } from "./mainMenu.js";

function getTgUserId(ctx: Context): string {
    return String(ctx.from?.id || "");
}

function buildKeyMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("Set", "key:set")
        .text("Status", "key:status")
        .row()
        .text("Clear", "key:clear");
}

export async function handleKey(ctx: Context): Promise<void> {
    await safeSend(ctx, {
        step: "key.menu",
        text: "Key shortcuts:",
        replyMarkup: buildKeyMenuKeyboard(),
    });
}

export async function handleKeyCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("key:")) return false;

    const tgUserId = getTgUserId(ctx);
    const action = data.slice("key:".length);
    console.log(
        `[trade-bot] callback userId=${tgUserId || "unknown"} action=key:${action || "unknown"} exchange=n/a strategy=n/a params=n/a`
    );
    await ctx.answerCallbackQuery().catch(() => { });

    if (action === "set") {
        await handleKeys(ctx);
        return true;
    }
    if (action === "status") {
        await handleKeysStatus(ctx);
        return true;
    }
    if (action === "clear") {
        await handleKeysClear(ctx);
        return true;
    }

    await safeSend(ctx, { step: "key.cb.unknown", text: "Unknown key action." });
    await sendMainMenu(ctx);
    return true;
}
