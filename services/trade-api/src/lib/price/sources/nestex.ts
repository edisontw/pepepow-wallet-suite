import { NormalizedTicker } from "../types.js";
import { fetchWithTimeout, parseNumber, truncateRaw } from "../utils.js";

const NESTEX_TICKER_URL =
    process.env.NESTEX_TICKER_URL || "https://trade.nestex.one/api/cg/tickers/PEPEW_USDT";

function unwrapNestExTicker(data: any): any {
    if (!data) return data;
    if (data?.data) return data.data;
    if (data?.ticker) return data.ticker;
    return data;
}

export async function fetchNestExTicker(): Promise<{
    ticker: NormalizedTicker;
    raw: string;
    volumeProvided: boolean;
}> {
    if (!NESTEX_TICKER_URL) {
        console.error(`[price] NestEx ticker not configured (NESTEX_TICKER_URL is empty)`);
        return {
            ticker: { exchange: "nestex", symbol: "PEPEW_USDT", last: null, bid: null, ask: null, volumeQuote: null, ts: null },
            raw: JSON.stringify({ error: "NestEx ticker not configured" }),
            volumeProvided: false,
        };
    }

    try {
        const data = await fetchWithTimeout(NESTEX_TICKER_URL);
        const d = unwrapNestExTicker(data);
        const volumeField =
            d?.target_volume ?? d?.quote_volume ?? d?.quoteVolume ?? d?.volume ?? d?.vol;
        const ticker: NormalizedTicker = {
            exchange: "nestex",
            symbol: d?.ticker_id || d?.symbol || "PEPEW_USDT",
            last: parseNumber(d?.last_price ?? d?.last ?? d?.close ?? d?.price),
            bid: parseNumber(d?.bid),
            ask: parseNumber(d?.ask),
            volumeQuote: parseNumber(volumeField),
            ts: d?.timestamp || Date.now(),
        };
        return { ticker, raw: truncateRaw(data), volumeProvided: volumeField !== undefined };
    } catch (err: any) {
        console.error(`[price] NestEx fetch error: ${err.message}`);
        return {
            ticker: { exchange: "nestex", symbol: "PEPEW_USDT", last: null, bid: null, ask: null, volumeQuote: null, ts: null },
            raw: JSON.stringify({ error: err.message }),
            volumeProvided: false,
        };
    }
}
