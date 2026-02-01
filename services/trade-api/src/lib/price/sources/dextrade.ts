import { NormalizedTicker } from "../types.js";
import { fetchWithTimeout, parseNumber, truncateRaw } from "../utils.js";

const DEXTRADE_TICKER_URL = process.env.DEXTRADE_TICKER_URL || "https://api.dex-trade.com/v1/public/ticker?pair=PEPEWUSDT";

export async function fetchDexTradeTicker(): Promise<{ ticker: NormalizedTicker; raw: string }> {
    try {
        const data = await fetchWithTimeout(DEXTRADE_TICKER_URL);
        // Dex-Trade format: { data: { last, buy, sell, vol, ... } }
        const d = data?.data || data;
        const ticker: NormalizedTicker = {
            exchange: "dextrade",
            symbol: "PEPEWUSDT",
            last: parseNumber(d?.last),
            bid: parseNumber(d?.buy),
            ask: parseNumber(d?.sell),
            volumeQuote: parseNumber(d?.vol ?? d?.volume ?? d?.quoteVolume ?? d?.quote_volume),
            volumeBase: parseNumber(d?.volume_24H ?? d?.volume_24h ?? d?.volume24H),
            ts: d?.updated || Date.now(),
        };
        return { ticker, raw: truncateRaw(data) };
    } catch (err: any) {
        console.error(`[price] Dex-Trade fetch error: ${err.message}`);
        return {
            ticker: { exchange: "dextrade", symbol: "PEPEWUSDT", last: null, bid: null, ask: null, volumeQuote: null, ts: null },
            raw: JSON.stringify({ error: err.message }),
        };
    }
}
