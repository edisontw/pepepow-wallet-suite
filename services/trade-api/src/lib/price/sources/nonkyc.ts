import { NormalizedTicker } from "../types.js";
import { fetchWithTimeout, parseNumber, truncateRaw } from "../utils.js";

const NONKYC_TICKER_URL_BNB = process.env.NONKYC_TICKER_URL_BNB || "https://api.nonkyc.io/api/v2/ticker/PEPEW_BNB";
const NONKYC_TICKER_URL_USDT = process.env.NONKYC_TICKER_URL_USDT || "https://api.nonkyc.io/api/v2/ticker/PEPEW_USDT";

function getNonKycUrl(symbol: "PEPEW_BNB" | "PEPEW_USDT"): string {
    return symbol === "PEPEW_USDT" ? NONKYC_TICKER_URL_USDT : NONKYC_TICKER_URL_BNB;
}

export async function fetchNonKycTicker(
    symbol: "PEPEW_BNB" | "PEPEW_USDT"
): Promise<{ ticker: NormalizedTicker; raw: string }> {
    try {
        const data = await fetchWithTimeout(getNonKycUrl(symbol));
        // NonKYC v2 ticker format: { symbol, last, bid, ask, quoteVolume, ... }
        const ticker: NormalizedTicker = {
            exchange: "nonkyc",
            symbol: data?.symbol || symbol,
            last: parseNumber(data?.last ?? data?.last_price ?? data?.price),
            bid: parseNumber(data?.bid ?? data?.bid_price),
            ask: parseNumber(data?.ask ?? data?.ask_price),
            volumeQuote: parseNumber(
                data?.quoteVolume ?? data?.quote_volume ?? data?.volumeQuote ?? data?.volume ?? data?.vol
            ),
            volumeUsdEst: parseNumber(data?.usd_volume_est ?? data?.usdVolumeEst),
            ts: data?.timestamp || Date.now(),
        };
        return { ticker, raw: truncateRaw(data) };
    } catch (err: any) {
        console.error(`[price] NonKYC fetch error (${symbol}): ${err.message}`);
        return {
            ticker: { exchange: "nonkyc", symbol, last: null, bid: null, ask: null, volumeQuote: null, ts: null },
            raw: JSON.stringify({ error: err.message }),
        };
    }
}
