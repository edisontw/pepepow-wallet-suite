import { Context } from "grammy";
import { safeSend } from "../utils/telegram.js";

const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PDep1ZNhCyqyRwjnQif8K6tPGsE7TvhyT6";

export async function handleDonate(ctx: Context): Promise<void> {
    const message = [
        "🎁 Support PEPEPOW Development",
        "",
        "Thank you for considering a donation!",
        "",
        "PEPEW Donate Address:",
        `${DONATE_ADDRESS}`,
        "",
        "Your support helps keep this bot running and free for everyone!",
    ].join("\n");

    await safeSend(ctx, { step: "donate", text: message });
}
