import { NormalizedTicker } from "../types.js";
import { fetchWithTimeout, parseNumber, truncateRaw } from "../utils.js";

const DEXTRADE_TICKER_URL = process.env.DEXTRADE_TICKER_URL || "https://api.dex-trade.com/v1/public/ticker?pair=PEPEWUSDT";

export async function fetchDexTradeTicker(): Promise<{ ticker: NormalizedTicker; raw: string }> {
    return {
        ticker: { exchange: "dextrade", symbol: "PEPEWUSDT", last: null, bid: null, ask: null, volumeQuote: null, ts: null },
        raw: JSON.stringify({ error: "Dex-Trade is delisted/unsupported" }),
    };
}
