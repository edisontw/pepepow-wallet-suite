import { Context } from "grammy";
import { safeSend } from "../utils/telegram.js";
import { handleHelp } from "./start.js";
import { handleStrategyMenu, handleStatus } from "./strategy.js";
import { handleReport } from "./report.js";
import { handleStop } from "./stop.js";
import { handleKey } from "./key.js";

export async function handleMainMenuCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("menu:")) return false;

    const userId = String(ctx.from?.id || "");
    const action = data.slice("menu:".length);
    console.log(
        `[trade-bot] callback userId=${userId || "unknown"} action=menu:${action || "unknown"} exchange=n/a strategy=n/a params=n/a`
    );
    await ctx.answerCallbackQuery().catch(() => { });

    if (action === "strategy") {
        await handleStrategyMenu(ctx);
        return true;
    }
    if (action === "status") {
        await handleStatus(ctx);
        return true;
    }
    if (action === "report") {
        await handleReport(ctx);
        return true;
    }
    if (action === "stop") {
        await handleStop(ctx);
        return true;
    }
    if (action === "key") {
        await handleKey(ctx);
        return true;
    }
    if (action === "help") {
        await handleHelp(ctx);
        return true;
    }

    await safeSend(ctx, { step: "menu.unknown", text: "Unknown menu action." });
    return true;
}
