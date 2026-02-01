export type ExchangeName = "nonkyc" | "dextrade" | "nestex";
export type QuoteAsset = "BNB" | "USDT";

export type MarketInfo = {
    symbol: string;
    baseAsset: "PEPEW";
    quoteAsset: QuoteAsset;
    display: string;
    displayLabel: string;
    experimental: boolean;
    defaultBudget: number;
    aliases: string[];
    priceSource: "nonkyc" | "dextrade" | "nestex";
    exchangeSymbol?: string;
};

const MARKETS: Record<ExchangeName, Record<string, MarketInfo>> = {
    nonkyc: {
        PEPEW_BNB: {
            symbol: "PEPEW_BNB",
            baseAsset: "PEPEW",
            quoteAsset: "BNB",
            display: "PEPEW/BNB",
            displayLabel: "PEPEW/BNB",
            experimental: false,
            defaultBudget: 0.005,
            aliases: ["PEPEW_BNB", "PEPEW/BNB", "PEPEWBNB"],
            priceSource: "nonkyc",
            exchangeSymbol: "PEPEW_BNB",
        },
        PEPEW_USDT: {
            symbol: "PEPEW_USDT",
            baseAsset: "PEPEW",
            quoteAsset: "USDT",
            display: "PEPEW/USDT",
            displayLabel: "PEPEW/USDT (Experimental — use small amounts)",
            experimental: true,
            defaultBudget: 1,
            aliases: ["PEPEW_USDT", "PEPEW/USDT", "PEPEWUSDT"],
            priceSource: "nonkyc",
            exchangeSymbol: "PEPEW_USDT",
        },
    },
    dextrade: {
        PEPEWUSDT: {
            symbol: "PEPEWUSDT",
            baseAsset: "PEPEW",
            quoteAsset: "USDT",
            display: "PEPEW/USDT",
            displayLabel: "PEPEW/USDT",
            experimental: false,
            defaultBudget: 1,
            aliases: ["PEPEWUSDT", "PEPEW_USDT", "PEPEW/USDT"],
            priceSource: "dextrade",
            exchangeSymbol: "PEPEWUSDT",
        },
    },
    nestex: {
        PEPEW_USDT: {
            symbol: "PEPEW_USDT",
            baseAsset: "PEPEW",
            quoteAsset: "USDT",
            display: "PEPEW/USDT",
            displayLabel: "PEPEW/USDT (Experimental — use small amounts)",
            experimental: true,
            defaultBudget: 1,
            aliases: ["PEPEW_USDT", "PEPEWUSDT", "PEPEW/USDT"],
            priceSource: "nestex",
            exchangeSymbol: "PEPEW",
        },
    },
};

const ALIAS_MAP: Record<ExchangeName, Map<string, string>> = {
    nonkyc: new Map<string, string>(),
    dextrade: new Map<string, string>(),
    nestex: new Map<string, string>(),
};

function normalizeKey(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, "");
}

for (const exchange of Object.keys(MARKETS) as ExchangeName[]) {
    for (const market of Object.values(MARKETS[exchange])) {
        const canonical = market.symbol;
        const normalizedSymbol = normalizeKey(canonical);
        ALIAS_MAP[exchange].set(normalizedSymbol, canonical);
        for (const alias of market.aliases) {
            ALIAS_MAP[exchange].set(normalizeKey(alias), canonical);
        }
    }
}

export function normalizePairSymbol(exchange: ExchangeName, pair: string | undefined | null): string | null {
    if (!pair) return null;
    const normalized = normalizeKey(pair);
    return ALIAS_MAP[exchange].get(normalized) || null;
}

export function getMarketInfo(exchange: ExchangeName, pair: string | undefined | null): MarketInfo | null {
    const normalized = normalizePairSymbol(exchange, pair) || (pair ? pair.toUpperCase() : null);
    if (!normalized) return null;
    return MARKETS[exchange]?.[normalized] || null;
}

export function getAllowedPairs(exchange: ExchangeName): MarketInfo[] {
    return Object.values(MARKETS[exchange] || {});
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

export function getPriceSource(exchange: ExchangeName, pair: string): "nonkyc" | "dextrade" | "nestex" | null {
    const market = getMarketInfo(exchange, pair);
    return market ? market.priceSource : null;
}

export function getBaseAsset(exchange: ExchangeName, pair: string): string | null {
    const market = getMarketInfo(exchange, pair);
    return market ? market.baseAsset : null;
}

export function getExchangeSymbol(exchange: ExchangeName, pair: string): string | null {
    const market = getMarketInfo(exchange, pair);
    return market ? (market.exchangeSymbol || market.symbol) : null;
}

