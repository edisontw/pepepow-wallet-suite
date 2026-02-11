import { Context, InlineKeyboard, Keyboard } from "grammy";
import { safeSend } from "../utils/telegram.js";
import { renderMenu } from "../utils/menu.js";

export const MAIN_MENU_BUTTONS = {
    status: "📊 Status",
    debug: "🛠 Debug",
    price: "💱 Price",
    strategy: "⚙️ Strategy",
    report: "📈 Report",
    stop: "🛑 Stop",
    keys: "🔑 API Keys",
    donation: "💖 Donation",
} as const;

export function buildMainMenuKeyboard(): Keyboard {
    return new Keyboard()
        .text(MAIN_MENU_BUTTONS.status)
        .text(MAIN_MENU_BUTTONS.debug).row()
        .text(MAIN_MENU_BUTTONS.price)
        .text(MAIN_MENU_BUTTONS.strategy)
        .text(MAIN_MENU_BUTTONS.report).row()
        .text(MAIN_MENU_BUTTONS.stop)
        .text(MAIN_MENU_BUTTONS.keys)
        .text(MAIN_MENU_BUTTONS.donation)
        .resized()
        .persistent();
}

export function withMenuNav(keyboard: InlineKeyboard): InlineKeyboard {
    return keyboard;
}

export async function sendMainMenu(ctx: Context, note?: string): Promise<void> {
    const text = note || renderMenu("🏠 PEPEPOW Trade Menu", "Select an option below:");
    await safeSend(ctx, {
        step: "main_menu",
        text,
        replyMarkup: buildMainMenuKeyboard(),
    });
}
