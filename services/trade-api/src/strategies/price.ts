import { getPriceOverview } from "../lib/price/aggregator.js";
import { fetchNonKycTicker, fetchDexTradeTicker, fetchNestExTicker } from "../routes/price.js";
import { ExchangeName, getPriceSource, normalizePairSymbol } from "../lib/markets.js";

export type PriceResult = {
    price: number;
    source: "last" | "mid" | "bid" | "ask" | "agg";
    exchange: string;
};

function selectPrice(ticker: { last: number | null; bid: number | null; ask: number | null }): PriceResult | null {
    if (ticker.last !== null && ticker.last > 0) {
        return { price: ticker.last, source: "last", exchange: "" };
    }
    if (ticker.bid !== null && ticker.ask !== null && ticker.bid > 0 && ticker.ask > 0) {
        return { price: (ticker.bid + ticker.ask) / 2, source: "mid", exchange: "" };
    }
    if (ticker.bid !== null && ticker.bid > 0) {
        return { price: ticker.bid, source: "bid", exchange: "" };
    }
    if (ticker.ask !== null && ticker.ask > 0) {
        return { price: ticker.ask, source: "ask", exchange: "" };
    }
    return null;
}

export async function fetchExchangePrice(exchange: ExchangeName, pair: string): Promise<PriceResult | null> {
    const symbol = normalizePairSymbol(exchange, pair) || pair;
    const priceSource = getPriceSource(exchange, symbol);
    if (!priceSource) {
        console.error(`[strategy] Unsupported market: exchange=${exchange} pair=${pair}`);
        return null;
    }

    try {
        if (priceSource === "nonkyc") {
            const normalized = normalizePairSymbol(exchange, symbol);
            if (normalized !== "PEPEW_BNB" && normalized !== "PEPEW_USDT") {
                console.error(`[strategy] Unsupported NonKYC symbol: ${symbol}`);
                return null;
            }
            const result = await fetchNonKycTicker(normalized);
            const selected = selectPrice(result.ticker);
            return selected ? { ...selected, exchange: priceSource } : null;
        }
        if (priceSource === "dextrade") {
            const result = await fetchDexTradeTicker();
            const selected = selectPrice(result.ticker);
            return selected ? { ...selected, exchange: priceSource } : null;
        }
        if (priceSource === "nestex") {
            const result = await fetchNestExTicker();
            if (result.ticker.last === null && result.ticker.bid === null && result.ticker.ask === null) {
                console.error("[strategy] price fetch failed for exchange=nestex (no provider or ticker unavailable)");
                return null;
            }
            const selected = selectPrice(result.ticker);
            return selected ? { ...selected, exchange: priceSource } : null;
        }

        console.error(`[strategy] Unknown exchange: ${exchange}`);
        return null;
    } catch (err: any) {
        console.error(`[strategy] Price fetch failed for ${exchange}: ${err?.message || err}`);
        if (exchange === "dextrade") {
            throw err;
        }
        return null;
    }
}

export async function fetchAggregatedPrice(pair: string): Promise<PriceResult | null> {
    const overview = await getPriceOverview();
    if (!overview.ok || !overview.prices) {
        return null;
    }
    const prices = overview.prices
        .filter((entry) => entry.pair === pair && typeof entry.price === "number" && entry.price > 0)
        .map((entry) => entry.price as number);

    if (!prices.length) return null;
    const avg = prices.reduce((sum, value) => sum + value, 0) / prices.length;
    return { price: avg, source: "agg", exchange: "aggregated" };
}
