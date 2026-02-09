import { Context, InlineKeyboard } from "grammy";
import { safeSend } from "../utils/telegram.js";

export function buildMainMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("Strategy", "menu:strategy")
        .text("Status", "menu:status").row()
        .text("Report", "menu:report")
        .text("Stop", "menu:stop").row()
        .text("Key", "menu:key")
        .text("Help", "menu:help");
}

export async function sendMainMenu(ctx: Context, note?: string): Promise<void> {
    const text = note
        ? `${note}\n\nMain menu:`
        : "Main menu:";
    await safeSend(ctx, {
        step: "main_menu",
        text,
        replyMarkup: buildMainMenuKeyboard(),
    });
}
