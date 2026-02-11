import { Context } from "grammy";
import { safeSend } from "../utils/telegram.js";
import { handleHelp } from "./start.js";
import { handleStrategyMenu, handleStatus, handleDebug } from "./strategy.js";
import { handleReport } from "./report.js";
import { handleStop } from "./stop.js";
import { handleKey } from "./key.js";
import { handleDonate } from "./donate.js";
import { handlePrice } from "./price.js";
import { MAIN_MENU_BUTTONS, sendMainMenu } from "./mainMenu.js";

type MenuAction =
    | "strategy"
    | "status"
    | "debug"
    | "price"
    | "report"
    | "stop"
    | "key"
    | "help"
    | "donation"
    | "home";

async function runMenuAction(ctx: Context, action: MenuAction): Promise<void> {
    if (action === "strategy") {
        await handleStrategyMenu(ctx);
        return;
    }
    if (action === "status") {
        await handleStatus(ctx);
        return;
    }
    if (action === "debug") {
        await handleDebug(ctx);
        return;
    }
    if (action === "price") {
        await handlePrice(ctx);
        return;
    }
    if (action === "report") {
        await handleReport(ctx);
        return;
    }
    if (action === "stop") {
        await handleStop(ctx);
        return;
    }
    if (action === "key") {
        await handleKey(ctx);
        return;
    }
    if (action === "help") {
        await handleHelp(ctx);
        return;
    }
    if (action === "donation") {
        await handleDonate(ctx);
        return;
    }
    if (action === "home") {
        await sendMainMenu(ctx);
    }
}

function resolveMenuActionFromText(text: string): MenuAction | null {
    const normalized = text.trim().toLowerCase();
    if (normalized === MAIN_MENU_BUTTONS.status.toLowerCase()) return "status";
    if (normalized === MAIN_MENU_BUTTONS.debug.toLowerCase()) return "debug";
    if (normalized === MAIN_MENU_BUTTONS.price.toLowerCase()) return "price";
    if (normalized === MAIN_MENU_BUTTONS.strategy.toLowerCase()) return "strategy";
    if (normalized === MAIN_MENU_BUTTONS.report.toLowerCase()) return "report";
    if (normalized === MAIN_MENU_BUTTONS.stop.toLowerCase()) return "stop";
    if (normalized === MAIN_MENU_BUTTONS.keys.toLowerCase()) return "key";
    if (normalized === MAIN_MENU_BUTTONS.donation.toLowerCase()) return "donation";
    return null;
}

export async function handleMainMenuCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("menu:")) return false;

    const userId = String(ctx.from?.id || "");
    const action = data.slice("menu:".length);
    console.log(
        `[trade-bot] callback userId=${userId || "unknown"} action=menu:${action || "unknown"} exchange=n/a strategy=n/a params=n/a`
    );
    await ctx.answerCallbackQuery().catch(() => { });

    if (
        action === "strategy" ||
        action === "status" ||
        action === "debug" ||
        action === "price" ||
        action === "report" ||
        action === "stop" ||
        action === "key" ||
        action === "help" ||
        action === "donation" ||
        action === "back"
    ) {
        const normalizedAction: MenuAction = action === "back" ? "home" : action as MenuAction;
        await runMenuAction(ctx, normalizedAction);
        return true;
    }

    await safeSend(ctx, { step: "menu.unknown", text: "Unknown menu action." });
    return true;
}

export async function handleMainMenuText(ctx: Context): Promise<boolean> {
    const text = ctx.message?.text || "";
    if (!text || text.startsWith("/")) return false;

    const action = resolveMenuActionFromText(text);
    if (!action) return false;

    await runMenuAction(ctx, action);
    return true;
}
