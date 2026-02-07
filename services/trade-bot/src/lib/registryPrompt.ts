import { getExchangeRegistry } from "../api.js";
import { ExchangeName, getPromptHelpers } from "./markets.js";

type PromptRule = {
    quoteAsset: "USDT" | "BNB";
    minNotional: number;
    minLabel: string;
    exampleLabel: string;
};

let cache: { ts: number; data: Awaited<ReturnType<typeof getExchangeRegistry>> | null } = {
    ts: 0,
    data: null,
};

function normalizePair(pair: string): string {
    const p = String(pair || "").toUpperCase();
    if (p.includes("/")) return p;
    if (p.includes("_")) return p.replace("_", "/");
    if (p.endsWith("USDT")) return `${p.slice(0, -4)}/USDT`;
    if (p.endsWith("BNB")) return `${p.slice(0, -3)}/BNB`;
    return p;
}

function toPrompt(minNotional: number, quoteAsset: "USDT" | "BNB"): PromptRule {
    const minLabel = `${minNotional} ${quoteAsset}`;
    const example = quoteAsset === "USDT"
        ? Number((minNotional <= 1 ? minNotional + 0.05 : minNotional * 1.1).toFixed(2))
        : Number((minNotional + 0.0004).toFixed(4));
    return {
        quoteAsset,
        minNotional,
        minLabel,
        exampleLabel: `e.g. ${example} ${quoteAsset}`,
    };
}

export async function getRegistryPromptHelpers(exchange: ExchangeName, pair: string): Promise<PromptRule> {
    const fallback = getPromptHelpers(exchange, pair);
    const canonicalPair = normalizePair(pair);
    const now = Date.now();

    try {
        if (!cache.data || now - cache.ts > 15_000) {
            cache.data = await getExchangeRegistry();
            cache.ts = now;
        }
        const ex = cache.data.exchanges.find((x) => x.exchangeId === exchange);
        const limits = ex?.limits?.byPair?.[canonicalPair];
        if (!limits) return fallback;
        const quoteAsset = canonicalPair.endsWith("/BNB") ? "BNB" : "USDT";
        return toPrompt(limits.minQuotePerOrder, quoteAsset);
    } catch {
        return fallback;
    }
}
