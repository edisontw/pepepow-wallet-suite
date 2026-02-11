import fetch from "node-fetch";
import { NormalizedTicker } from "../types.js";
import { fetchWithTimeout, parseNumber, truncateRaw } from "../utils.js";
import { tradeLog } from "../../tradeLogger.js";

const NESTEX_TICKER_URL =
    process.env.NESTEX_TICKER_URL || "https://trade.nestex.one/api/cg/tickers/PEPEW_USDT";
const NESTEX_ORDERBOOK_URL =
    process.env.NESTEX_ORDERBOOK_URL || "https://trade.nestex.one/api/cg/orderbook/PEPEW_USDT";
const NESTEX_DEBUG =
    process.env.DEBUG_NESTEX === "1" ||
    process.env.DEBUG_NESTEX === "true" ||
    process.env.NESTEX_DEBUG === "1" ||
    process.env.NESTEX_DEBUG === "true";
let orderbookEndpointDisabled = false;
let orderbookDisableReason: string | null = null;
let orderbookDisableLogged = false;

function debugLog(label: string, data: any): void {
    if (!NESTEX_DEBUG) return;
    tradeLog({
        scope: "nestex",
        level: "debug",
        exchange: "nestex",
        message: `${label}: ${typeof data === "object" ? JSON.stringify(data) : data}`,
    });
}

function extractSymbolFromUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split("/").filter(Boolean);
        const last = parts.length > 0 ? parts[parts.length - 1] : "";
        return last ? decodeURIComponent(last).toUpperCase() : null;
    } catch {
        return null;
    }
}

function collectOrderbookPrices(side: any): number[] {
    if (!side) return [];
    const prices: number[] = [];
    if (Array.isArray(side)) {
        for (const entry of side) {
            if (Array.isArray(entry)) {
                const price = parseNumber(entry[0]);
                if (price !== null && price > 0) prices.push(price);
            } else if (entry && typeof entry === "object") {
                const price = parseNumber(entry.price ?? entry.rate ?? entry[0]);
                if (price !== null && price > 0) prices.push(price);
            }
        }
    } else if (typeof side === "object") {
        for (const key of Object.keys(side)) {
            const price = parseNumber(key);
            if (price !== null && price > 0) prices.push(price);
        }
    }
    return prices;
}

function samplePrices(values: number[], limit = 5, order: "asc" | "desc" = "asc"): number[] {
    const copy = values.slice();
    copy.sort((a, b) => order === "asc" ? a - b : b - a);
    return copy.slice(0, limit);
}

export async function fetchNestExOrderbookTop(): Promise<{
    bestBid: number | null;
    bestAsk: number | null;
    status: "OK" | "EMPTY" | "INVALID";
    raw: string;
    bookSource: "orderbook" | "ticker_fallback" | "ticker_primary";
}> {
    if (!NESTEX_ORDERBOOK_URL) {
        tradeLog({
            scope: "nestex",
            level: "error",
            exchange: "nestex",
            message: "book.fail errCode=NO_BOOK url=n/a statusCode=n/a reason=ORDERBOOK_URL_EMPTY",
            throttleKey: "nestex:book:no-url",
            throttleSec: 60,
        });
        return { bestBid: null, bestAsk: null, status: "EMPTY", raw: JSON.stringify({ error: "NestEx orderbook not configured" }), bookSource: "orderbook" };
    }

    const fallbackToTicker = async (
        reason: string,
        raw: string,
        source: "ticker_fallback" | "ticker_primary" = "ticker_fallback"
    ): Promise<{
        bestBid: number | null;
        bestAsk: number | null;
        status: "OK" | "EMPTY" | "INVALID";
        raw: string;
        bookSource: "orderbook" | "ticker_fallback" | "ticker_primary";
    }> => {
        const ticker = await fetchNestExTicker();
        const bestBid = ticker.ticker.bid ?? null;
        const bestAsk = ticker.ticker.ask ?? null;
        if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
            const status = bestAsk <= bestBid ? "INVALID" : "OK";
            if (source === "ticker_primary") {
                if (!orderbookDisableLogged || orderbookDisableReason !== reason) {
                    tradeLog({
                        scope: "nestex",
                        level: "info",
                        exchange: "nestex",
                        message: `book.primary source=ticker bid=${bestBid} ask=${bestAsk} reason=${reason}`,
                        throttleKey: "nestex:book:primary",
                        throttleSec: 30,
                    });
                    orderbookDisableLogged = true;
                }
            } else {
                tradeLog({
                    scope: "nestex",
                    level: "warn",
                    exchange: "nestex",
                    message: `book.fallback reason=${reason} bestBid=${bestBid} bestAsk=${bestAsk} source=ticker`,
                    throttleKey: `nestex:book:fallback:${reason}`,
                    throttleSec: 30,
                });
            }
            return { bestBid, bestAsk, status, raw, bookSource: source };
        }
        tradeLog({
            scope: "nestex",
            level: "error",
            exchange: "nestex",
            message: `book.fail errCode=NO_BOOK url=${NESTEX_ORDERBOOK_URL} statusCode=n/a reason=${reason}`,
            throttleKey: `nestex:book:fail:${reason}`,
            throttleSec: 60,
        });
        return { bestBid: null, bestAsk: null, status: "EMPTY", raw, bookSource: source };
    };

    if (orderbookEndpointDisabled) {
        const reason = orderbookDisableReason || "ORDERBOOK_ENDPOINT_DISABLED";
        return fallbackToTicker(reason, JSON.stringify({ reason }), "ticker_primary");
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        let res: any;
        try {
            res = await fetch(NESTEX_ORDERBOOK_URL, { signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }

        const httpStatus = Number(res?.status ?? 0);
        let data: any = null;
        try {
            data = await res.json();
        } catch {
            data = null;
        }

        if (httpStatus === 404) {
            orderbookEndpointDisabled = true;
            orderbookDisableReason = "ORDERBOOK_ENDPOINT_404_DISABLED";
            orderbookDisableLogged = false;
            return fallbackToTicker(orderbookDisableReason, truncateRaw(data ?? { status: 404 }), "ticker_primary");
        }

        if (!res.ok) {
            const reason = `ORDERBOOK_HTTP_${httpStatus || "ERROR"}`;
            return fallbackToTicker(reason, truncateRaw(data ?? { status: httpStatus }));
        }

        const d = unwrapNestExTicker(data);
        const bidPrices = collectOrderbookPrices(d?.bids ?? d?.bid ?? d?.buy);
        const askPrices = collectOrderbookPrices(d?.asks ?? d?.ask ?? d?.sell);
        const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
        const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;
        const mid = (bestBid !== null && bestAsk !== null) ? (bestBid + bestAsk) / 2 : null;
        const status = bidPrices.length === 0 || askPrices.length === 0
            ? "EMPTY"
            : (bestBid !== null && bestAsk !== null && bestAsk <= bestBid)
                ? "INVALID"
                : "OK";
        debugLog("orderbook.parsed", {
            bestBid,
            bestAsk,
            mid,
            status,
            bidCount: bidPrices.length,
            askCount: askPrices.length,
        });
        if (status === "EMPTY") {
            debugLog("orderbook.empty", {
                bidSample: samplePrices(bidPrices, 5, "desc"),
                askSample: samplePrices(askPrices, 5, "asc"),
            });
            return fallbackToTicker("EMPTY_BOOK", truncateRaw(data));
        }
        if (status === "INVALID") {
            debugLog("orderbook.invalid", {
                bestBid,
                bestAsk,
                bidSample: samplePrices(bidPrices, 5, "desc"),
                askSample: samplePrices(askPrices, 5, "asc"),
            });
            return fallbackToTicker("INVALID_BOOK", truncateRaw(data));
        }
        const spread = bestBid !== null && bestAsk !== null && mid && mid > 0 ? ((bestAsk - bestBid) / mid) : null;
        tradeLog({
            scope: "nestex",
            level: "info",
            exchange: "nestex",
            message: `book.ok bestBid=${bestBid} bestAsk=${bestAsk} mid=${mid ?? "n/a"} spread=${spread ?? "n/a"} source=orderbook`,
            throttleKey: "nestex:book:ok",
            throttleSec: 30,
        });
        return { bestBid, bestAsk, status, raw: truncateRaw(data), bookSource: "orderbook" };
    } catch (err: any) {
        tradeLog({
            scope: "nestex",
            level: "error",
            exchange: "nestex",
            message: `book.fail errCode=NO_BOOK url=${NESTEX_ORDERBOOK_URL} statusCode=n/a reason=${err.message}`,
            throttleKey: "nestex:book:fetch-error",
            throttleSec: 60,
        });
        return fallbackToTicker("ORDERBOOK_FETCH_ERROR", JSON.stringify({ error: err.message }));
    }
}

function unwrapNestExTicker(data: any): any {
    if (!data) return data;
    if (data?.data?.ticker) return data.data.ticker;
    if (data?.data) return data.data;
    if (data?.ticker) return data.ticker;
    if (data?.result) return data.result;
    return data;
}

export async function fetchNestExTicker(): Promise<{
    ticker: NormalizedTicker;
    raw: string;
    volumeProvided: boolean;
}> {
    if (!NESTEX_TICKER_URL) {
        tradeLog({
            scope: "price",
            level: "error",
            exchange: "nestex",
            message: "NestEx ticker not configured (NESTEX_TICKER_URL is empty)",
            throttleKey: "nestex:ticker:not-configured",
            throttleSec: 60,
        });
        return {
            ticker: { exchange: "nestex", symbol: "PEPEW_USDT", last: null, bid: null, ask: null, volumeQuote: null, ts: null },
            raw: JSON.stringify({ error: "NestEx ticker not configured" }),
            volumeProvided: false,
        };
    }

    try {
        const requestedPair = "PEPEW/USDT";
        const exchangeSymbol = extractSymbolFromUrl(NESTEX_TICKER_URL) || "PEPEW_USDT";
        debugLog("symbol mapping", { requestedPair, exchangeSymbol, url: NESTEX_TICKER_URL });

        const data = await fetchWithTimeout(NESTEX_TICKER_URL);
        const d = unwrapNestExTicker(data);
        const volumeField =
            d?.target_volume ?? d?.quote_volume ?? d?.quoteVolume ?? d?.volume ?? d?.vol;
        const last = parseNumber(d?.last_price ?? d?.last ?? d?.close ?? d?.price);
        const bid = parseNumber(d?.bid);
        const ask = parseNumber(d?.ask);
        const mid = (bid !== null && ask !== null && bid > 0 && ask > 0) ? (bid + ask) / 2 : null;
        const ticker: NormalizedTicker = {
            exchange: "nestex",
            symbol: d?.ticker_id || d?.symbol || "PEPEW_USDT",
            last,
            bid,
            ask,
            volumeQuote: parseNumber(volumeField),
            ts: d?.timestamp || Date.now(),
        };
        debugLog("ticker.parsed", {
            symbol: ticker.symbol,
            bestBid: bid,
            bestAsk: ask,
            mid,
            last,
        });
        return { ticker, raw: truncateRaw(data), volumeProvided: volumeField !== undefined };
    } catch (err: any) {
        tradeLog({
            scope: "price",
            level: "error",
            exchange: "nestex",
            message: `NestEx fetch error: ${err.message}`,
            throttleKey: "nestex:ticker:fetch-error",
            throttleSec: 60,
        });
        return {
            ticker: { exchange: "nestex", symbol: "PEPEW_USDT", last: null, bid: null, ask: null, volumeQuote: null, ts: null },
            raw: JSON.stringify({ error: err.message }),
            volumeProvided: false,
        };
    }
}
