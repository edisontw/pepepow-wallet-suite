export type ExchangeKey = "nonkyc" | "dextrade" | "nestex";
export type ExchangeDisplay = "NonKYC" | "Dex-Trade" | "NestEX";
export type QuoteUnit = "USD" | "BNB";
export type PriceSource = "last" | "mid" | "bid" | "ask";

export interface NormalizedTicker {
    exchange: ExchangeKey;
    symbol: string;
    last: number | null;
    bid: number | null;
    ask: number | null;
    volumeQuote: number | null;
    volumeBase?: number | null;
    volumeUsdEst?: number | null;
    ts: number | null;
}

export interface PriceEntry {
    exchange: ExchangeDisplay;
    pair: string;
    price: number | null;
    volume24h: number | null;
    quote: QuoteUnit;
    volumeNote?: "not_provided";
}

export interface PriceOverview {
    ok: boolean;
    ts: number;
    prices: PriceEntry[];
    sources?: {
        nonKycBnb?: NormalizedTicker;
        nonKycUsdt?: NormalizedTicker;
        dexTrade?: NormalizedTicker;
        nestEx?: NormalizedTicker;
    };
    debug?: {
        rawNonKycBnb?: string;
        rawNonKycUsdt?: string;
        rawDexTrade?: string;
        rawNestEx?: string;
    };
}
