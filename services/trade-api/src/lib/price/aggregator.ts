import { PriceEntry, PriceOverview, PriceSource, NormalizedTicker } from "./types.js";
import { fetchNonKycTicker } from "./sources/nonkyc.js";
import { fetchDexTradeTicker } from "./sources/dextrade.js";
import { fetchNestExTicker } from "./sources/nestex.js";

function selectPrice(ticker: NormalizedTicker): { price: number | null; source: PriceSource | null } {
    if (ticker.last !== null && ticker.last > 0) return { price: ticker.last, source: "last" };
    if (ticker.bid !== null && ticker.ask !== null && ticker.bid > 0 && ticker.ask > 0) {
        return { price: (ticker.bid + ticker.ask) / 2, source: "mid" };
    }
    if (ticker.bid !== null && ticker.bid > 0) return { price: ticker.bid, source: "bid" };
    if (ticker.ask !== null && ticker.ask > 0) return { price: ticker.ask, source: "ask" };
    return { price: null, source: null };
}

function buildEntry(params: {
    exchange: PriceEntry["exchange"];
    pair: string;
    quote: PriceEntry["quote"];
    ticker: NormalizedTicker;
    volume24h?: number | null;
    volumeProvided?: boolean;
}): PriceEntry {
    const { price } = selectPrice(params.ticker);
    const volume24h = params.volume24h ?? params.ticker.volumeQuote ?? null;
    const entry: PriceEntry = {
        exchange: params.exchange,
        pair: params.pair,
        price,
        volume24h,
        quote: params.quote,
    };
    if (volume24h === null && params.volumeProvided === false) {
        entry.volumeNote = "not_provided";
    }
    return entry;
}

export async function getPriceOverview(options?: {
    includeSources?: boolean;
    includeDebug?: boolean;
}): Promise<PriceOverview> {
    const [nonKycBnb, nonKycUsdt, dexTrade, nestEx] = await Promise.all([
        fetchNonKycTicker("PEPEW_BNB"),
        fetchNonKycTicker("PEPEW_USDT"),
        fetchDexTradeTicker(),
        fetchNestExTicker(),
    ]);

    const nonKycUsdVolumes = [nonKycUsdt.ticker.volumeUsdEst, nonKycBnb.ticker.volumeUsdEst].filter(
        (value) => typeof value === "number" && Number.isFinite(value) && value > 0
    ) as number[];
    const nonKycVolume24h = nonKycUsdVolumes.length > 0 ? nonKycUsdVolumes.reduce((sum, v) => sum + v, 0) : null;

    const dexTradeVolume24h =
        typeof dexTrade.ticker.volumeBase === "number" &&
        Number.isFinite(dexTrade.ticker.volumeBase) &&
        dexTrade.ticker.volumeBase > 0 &&
        typeof dexTrade.ticker.last === "number" &&
        Number.isFinite(dexTrade.ticker.last) &&
        dexTrade.ticker.last > 0
            ? dexTrade.ticker.volumeBase * dexTrade.ticker.last
            : null;

    const prices: PriceEntry[] = [
        buildEntry({
            exchange: "NonKYC",
            pair: "PEPEW/BNB",
            quote: "BNB",
            ticker: nonKycBnb.ticker,
        }),
        buildEntry({
            exchange: "NonKYC",
            pair: "PEPEW/USDT",
            quote: "USD",
            ticker: nonKycUsdt.ticker,
            volume24h: nonKycVolume24h,
        }),
        buildEntry({
            exchange: "Dex-Trade",
            pair: "PEPEW/USDT",
            quote: "USD",
            ticker: dexTrade.ticker,
            volume24h: dexTradeVolume24h,
        }),
        buildEntry({
            exchange: "NestEX",
            pair: "PEPEW/USDT",
            quote: "USD",
            ticker: nestEx.ticker,
            volumeProvided: nestEx.volumeProvided,
        }),
    ];

    const overview: PriceOverview = {
        ok: true,
        ts: Date.now(),
        prices,
    };

    if (options?.includeSources) {
        overview.sources = {
            nonKycBnb: nonKycBnb.ticker,
            nonKycUsdt: nonKycUsdt.ticker,
            dexTrade: dexTrade.ticker,
            nestEx: nestEx.ticker,
        };
    }

    if (options?.includeDebug) {
        overview.debug = {
            rawNonKycBnb: nonKycBnb.raw,
            rawNonKycUsdt: nonKycUsdt.raw,
            rawDexTrade: dexTrade.raw,
            rawNestEx: nestEx.raw,
        };
    }

    return overview;
}

export { selectPrice };
