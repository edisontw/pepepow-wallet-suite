import { getExchangeSpec, getExchangeSymbol as registryExchangeSymbol, normalizeExchangeId } from "../registry/exchanges.js";
import { toCanonicalPair } from "../registry/pairs.js";
import { CanonicalPair, ExchangeId } from "../registry/types.js";

export type ExchangeName = ExchangeId;
export type QuoteAsset = "BNB" | "USDT";

export type MarketInfo = {
    symbol: string;
    baseAsset: "PEPEW";
    quoteAsset: QuoteAsset;
    display: CanonicalPair;
    displayLabel: string;
    experimental: boolean;
    defaultBudget: number;
    aliases: string[];
    priceSource: ExchangeName;
    exchangeSymbol?: string;
};

const DEFAULT_BUDGETS: Record<CanonicalPair, number> = {
    "PEPEW/USDT": 1.05,
    "PEPEW/BNB": 0.002,
};

function buildMarketInfo(exchange: ExchangeName, canonicalPair: CanonicalPair): MarketInfo {
    const quoteAsset = canonicalPair.endsWith("/BNB") ? "BNB" : "USDT";
    const exchangeSymbol = registryExchangeSymbol(exchange, canonicalPair);
    const experimental = exchange !== "dextrade";
    const displayLabel = experimental ? `${canonicalPair} (Experimental - use small amounts)` : canonicalPair;
    return {
        symbol: canonicalPair.replace("/", "_"),
        baseAsset: "PEPEW",
        quoteAsset,
        display: canonicalPair,
        displayLabel,
        experimental,
        defaultBudget: DEFAULT_BUDGETS[canonicalPair],
        aliases: [canonicalPair, canonicalPair.replace("/", "_"), canonicalPair.replace("/", "")],
        priceSource: exchange,
        exchangeSymbol,
    };
}

export function normalizePairSymbol(exchange: ExchangeName, pair: string | undefined | null): string | null {
    if (!pair) return null;
    try {
        const canonicalPair = toCanonicalPair(pair);
        const spec = getExchangeSpec(exchange);
        if (!spec.pairs.includes(canonicalPair)) return null;
        return canonicalPair.replace("/", "_");
    } catch {
        return null;
    }
}

export function getMarketInfo(exchange: ExchangeName, pair: string | undefined | null): MarketInfo | null {
    if (!pair) return null;
    try {
        const canonicalPair = toCanonicalPair(pair);
        const spec = getExchangeSpec(exchange);
        if (!spec.pairs.includes(canonicalPair)) return null;
        return buildMarketInfo(exchange, canonicalPair);
    } catch {
        return null;
    }
}

export function getAllowedPairs(exchange: ExchangeName): MarketInfo[] {
    const spec = getExchangeSpec(exchange);
    return spec.pairs.map((pair) => buildMarketInfo(exchange, pair));
}

export function getQuoteUnit(exchange: ExchangeName, pair: string): QuoteAsset | null {
    const market = getMarketInfo(exchange, pair);
    return market ? market.quoteAsset : null;
}

export function getDefaultBudget(exchange: ExchangeName, pair: string): number | null {
    const market = getMarketInfo(exchange, pair);
    return market ? market.defaultBudget : null;
}

export function isExperimental(exchange: ExchangeName, pair: string): boolean {
    const market = getMarketInfo(exchange, pair);
    return market ? market.experimental : false;
}

export function validatePair(exchange: ExchangeName, pair: string): boolean {
    return Boolean(getMarketInfo(exchange, pair));
}

export function formatPairDisplay(exchange: ExchangeName, pair: string): string {
    const market = getMarketInfo(exchange, pair);
    return market ? market.display : pair;
}

export function formatPairLabel(exchange: ExchangeName, pair: string): string {
    const market = getMarketInfo(exchange, pair);
    return market ? market.displayLabel : pair;
}

export function getPriceSource(exchange: ExchangeName, pair: string): ExchangeName | null {
    const market = getMarketInfo(exchange, pair);
    return market ? market.priceSource : null;
}

export function getBaseAsset(exchange: ExchangeName, pair: string): string | null {
    const market = getMarketInfo(exchange, pair);
    return market ? market.baseAsset : null;
}

export function getCanonicalPair(pair: string): CanonicalPair {
    return toCanonicalPair(pair);
}

export function getExchangeSymbol(exchange: ExchangeName, pair: string): string {
    const canonicalPair = toCanonicalPair(pair);
    const spec = getExchangeSpec(exchange);
    if (!spec.pairs.includes(canonicalPair)) {
        throw new Error(`UNSUPPORTED_PAIR: exchangeId=${exchange} canonicalPair=${canonicalPair}`);
    }
    return registryExchangeSymbol(exchange, canonicalPair);
}

export function normalizeExchangeName(input: string): ExchangeName {
    return normalizeExchangeId(input);
}
