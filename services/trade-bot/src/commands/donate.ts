import { Context } from "grammy";
import { safeSend } from "../utils/telegram.js";
import { sendMainMenu } from "./mainMenu.js";

const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PL8s5WjXUGhHVSo743dwEXGtsifV5YpdcD";

export async function handleDonate(ctx: Context): Promise<void> {
    const message = [
        "💖 Donation",
        "──────────",
        "Donation Address:",
        `(PEPEW) ${DONATE_ADDRESS}`,
        "",
        "⚠️ Only send PEPEW to this address",
    ].join("\n");

    await safeSend(ctx, { step: "donate", text: message });
    await sendMainMenu(ctx);
}
