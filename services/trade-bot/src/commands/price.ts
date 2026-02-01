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

function formatSignificant(value: number, digits: number): string {
    const abs = Math.abs(value);
    if (abs === 0) return "0";
    const log10 = Math.log10(abs);
    const decimals = digits - Math.floor(log10) - 1;
    if (decimals >= 0) {
        return value.toFixed(decimals);
    }
    const factor = Math.pow(10, -decimals);
    return (Math.round(value / factor) * factor).toFixed(0);
}

function formatPrice(price: number | null): string {
    if (price === null) return "N/A";
    if (price < 0.000001) return price.toExponential(2);
    return formatSignificant(price, 8);
}

function formatVolume(volume: number | null, note?: "not_provided"): string {
    if (volume === null) return note === "not_provided" ? "N/A (not provided)" : "N/A";
    if (volume >= 1) return volume.toFixed(0);
    if (volume >= 0.01) return volume.toFixed(2);
    return volume.toExponential(2);
}

function withUnit(value: string, unit: string): string {
    if (value.startsWith("N/A")) return value;
    return `${value} ${unit}`;
}

function formatLine(label: string, value: string): string {
    const width = 24;
    return `${label.padEnd(width)}${value}`;
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
            "PEPEPOW Price Overview:",
            "",
            formatLine(
                "NonKYC (PEPEW/BNB):",
                withUnit(formatPrice(nonKycBnb?.price ?? null), nonKycBnb?.quote || "BNB")
            ),
            formatLine(
                "NonKYC (PEPEW/USDT):",
                withUnit(formatPrice(nonKycUsdt?.price ?? null), nonKycUsdt?.quote || "USD")
            ),
            formatLine(
                "Dex-Trade (PEPEW/USDT):",
                withUnit(formatPrice(dexTrade?.price ?? null), dexTrade?.quote || "USD")
            ),
            formatLine(
                "NestEX (PEPEW/USDT):",
                withUnit(formatPrice(nestEx?.price ?? null), nestEx?.quote || "USD")
            ),
            "",
            "24h Volume:",
            formatLine(
                "NonKYC (PEPEW/USDT):",
                withUnit(formatVolume(nonKycUsdt?.volume24h ?? null, nonKycUsdt?.volumeNote), "USD")
            ),
            formatLine(
                "Dex-Trade (PEPEW/USDT):",
                withUnit(formatVolume(dexTrade?.volume24h ?? null, dexTrade?.volumeNote), "USD")
            ),
            formatLine(
                "NestEX (PEPEW/USDT):",
                withUnit(formatVolume(nestEx?.volume24h ?? null, nestEx?.volumeNote), "USD")
            ),
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
