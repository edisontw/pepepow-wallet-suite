import { Context } from "grammy";
import { ApiError, getPrice } from "../api.js";
import { safeSend } from "../utils/telegram.js";

type PriceEntry = {
    exchange: "NonKYC" | "Dex-Trade" | "NestEX";
    pair: string;
    price: number | null;
    volume24h: number | null;
    quote: "USD" | "BNB";
    volumeNote?: "not_provided";
};

function formatPriceDecimal(price: number | null): string {
    if (price === null || !Number.isFinite(price) || price <= 0) return "N/A";
    const fixed = price.toFixed(12);
    const trimmed = fixed
        .replace(/(\.\d*?[1-9])0+$/, "$1")
        .replace(/\.0+$/, "");
    return trimmed;
}

function findEntry(entries: PriceEntry[], exchange: PriceEntry["exchange"], pair: string): PriceEntry | null {
    return entries.find((entry) => entry.exchange === exchange && entry.pair === pair) || null;
}

export async function handlePrice(ctx: Context): Promise<void> {
    try {
        const data = await getPrice();

        if (!data.ok) {
            console.error("[price] API /v1/price status=200 message=ok=false");
            await safeSend(ctx, { step: "price.api_error", text: "Failed to fetch prices. Please try again later." });
            return;
        }

        const entries = data.prices || [];
        const nonKycBnb = findEntry(entries, "NonKYC", "PEPEW/BNB");
        const nonKycUsdt = findEntry(entries, "NonKYC", "PEPEW/USDT");
        const dexTrade = findEntry(entries, "Dex-Trade", "PEPEW/USDT");
        const nestEx = findEntry(entries, "NestEX", "PEPEW/USDT");

        const message = [
            "💱 PEPEW Price",
            "--------------------",
            `• NonKYC (PEPEW/BNB): ${formatPriceDecimal(nonKycBnb?.price ?? null)} BNB`,
            `• NonKYC: ${formatPriceDecimal(nonKycUsdt?.price ?? null)} USD`,
            `• Dex-Trade: ${formatPriceDecimal(dexTrade?.price ?? null)} USD`,
            `• NestEx: ${formatPriceDecimal(nestEx?.price ?? null)} USD`,
        ].join("\n");

        await safeSend(ctx, { step: "price.success", text: message });
    } catch (err: any) {
        if (err instanceof ApiError) {
            console.error(`[price] API ${err.path} status=${err.status ?? "n/a"} message=${err.message}`);
        } else {
            console.error(`[price] Error: ${err?.message || err}`);
        }
        await safeSend(ctx, { step: "price.error", text: "Failed to fetch prices. Please try again later." });
    }
}
