import {
    cancelOpenStrategyOrders,
    getExchangeKey,
    getOpenStrategyOrders,
    getStrategyConfigById,
    insertStrategyEvent,
    insertStrategyFill,
    insertStrategyOrder,
    insertStrategyOrderRegistry,
    updateStrategyLastRunAt,
    updateStrategyOrderStatus,
    updateStrategyOrderStatusRegistry,
    updateStrategyParams,
    getOpenStrategyOrdersRegistry
} from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { createDexTradeOrder, listDexTradeOpenOrders, cancelDexTradeOrder } from "../exchanges/dextrade.js";
import { createNonKycOrder, cancelNonKycOrder, getNonkycMarketRules, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { placeNestExLimitOrder, cancelNestExOrder } from "../exchanges/nestex.js";
import { ExchangeName, getBaseAsset, getExchangeSymbol, getQuoteUnit } from "../lib/markets.js";
import { getMinNotional, getPricePrecision, getQtyPrecision } from "../lib/exchanges.js";
import { fetchAggregatedPrice, fetchExchangePrice, fetchExchangeTopOfBook } from "./price.js";
import { StrategyRunner } from "./types.js";
import { wrapStrategyTick } from "../lib/runner-wrapper.js";
import { getExchangeNormalizedBalance } from "../lib/fundsCheck.js";
import { logStrategyTickContract } from "./logContract.js";

// Per-strategy lock to avoid overlapping ticks
const runningConfigs = new Set<number>();

const DEFAULT_REFRESH_SEC = 15;
const BIAS_LOG_INTERVAL_MS = 10 * 60 * 1000;
const FEE_BUFFER = 1.01;
const NESTEX_DEBUG =
    process.env.DEBUG_NESTEX === "1" ||
    process.env.DEBUG_NESTEX === "true" ||
    process.env.NESTEX_DEBUG === "1" ||
    process.env.NESTEX_DEBUG === "true";
const NESTEX_ORDER_DEBUG =
    process.env.DEBUG_NESTEX_ORDER === "1" ||
    process.env.DEBUG_NESTEX_ORDER === "true";

/** MM operating mode */
type MmMode = "TWO_SIDED" | "ONE_SIDED_BUY" | "ONE_SIDED_SELL";

type MmParams = {
    mid_source?: "aggregated" | "exchange";
    spread_pct?: number;
    /** @deprecated Use quote_per_order instead */
    order_quote?: number;
    /** Quote amount per individual order (USDT) - replaces order_quote */
    quote_per_order?: number;
    /** Number of orders per side (default: 1) */
    orders_per_side?: number;
    refresh_sec?: number;
    max_position_base?: number;
    inventory_base?: number;
    inventory_quote?: number;
    /** Operating mode: TWO_SIDED (default), ONE_SIDED_BUY, ONE_SIDED_SELL */
    mode?: MmMode;
    /** Minimum base asset (e.g. PEPEW) needed to place SELL orders */
    min_base_inventory?: number;
    /** Minimum quote asset (e.g. USDT) needed to place BUY orders */
    min_quote_inventory?: number;
    // Tracking fields for status display
    last_action?: string;
    last_action_at?: number;
    last_bias_log_at?: number;
    open_orders_count?: number;
    placed_buy?: number;
    placed_sell?: number;
    skip_reasons?: string[];
};

function safeParse(paramsJson: string): MmParams {
    try {
        return JSON.parse(paramsJson) as MmParams;
    } catch {
        return {};
    }
}

function normalizePrice(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Number(value.toPrecision(12));
}

type MarketRules = {
    minNotional: number;
    minQty: number;
    qtyStep: number;
    priceTick: number;
    source: string;
};

function roundToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
    return Math.floor(value / step) * step;
}

function roundToTick(value: number, tick: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
    return Math.round(value / tick) * tick;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return value;
    if (Number.isFinite(min) && value < min) return min;
    if (Number.isFinite(max) && value > max) return max;
    return value;
}

function isFinitePositive(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function inferTickFromPrice(price: number, maxDecimals = 12): number | null {
    if (!Number.isFinite(price) || price <= 0) return null;
    const fixed = price.toFixed(maxDecimals);
    const dot = fixed.indexOf(".");
    if (dot === -1) return 1;
    const frac = fixed.slice(dot + 1);
    const trimmed = frac.replace(/0+$/, "");
    if (!trimmed.length) return 1;
    return Math.pow(10, -trimmed.length);
}

function resolveDexTradeTick(params: {
    tick: number;
    bestBid?: number | null;
    bestAsk?: number | null;
    mid: number;
}): { tick: number; source: string } {
    const refBid = isFinitePositive(params.bestBid) ? params.bestBid : null;
    const refAsk = isFinitePositive(params.bestAsk) ? params.bestAsk : null;
    const ref = refAsk ?? refBid ?? (Number.isFinite(params.mid) ? params.mid : null);

    let tick = Number.isFinite(params.tick) && params.tick > 0 ? params.tick : 0;
    let source = "config";

    const inferred = ref ? inferTickFromPrice(ref) : null;
    if (Number.isFinite(inferred) && (inferred as number) > 0) {
        if (!Number.isFinite(tick) || tick <= 0 || (inferred as number) > tick) {
            tick = inferred as number;
            source = "inferred";
        }
    }

    if (!Number.isFinite(tick) || tick <= 0) {
        tick = inferred && inferred > 0 ? inferred : Math.pow(10, -8);
        source = "fallback";
    }

    if (ref && Number.isFinite(ref) && ref > 0) {
        const maxTick = Math.max(ref * 0.05, tick);
        let adjusted = false;
        for (let i = 0; i < 6; i++) {
            const downRef = refAsk ?? ref;
            const upRef = refBid ?? ref;
            const down = roundToTick(downRef - tick, tick);
            const up = roundToTick(upRef + tick, tick);
            if (Number.isFinite(down) && down < downRef && Number.isFinite(up) && up > upRef) {
                break;
            }
            const next = tick * 10;
            if (!Number.isFinite(next) || next > maxTick) break;
            tick = next;
            adjusted = true;
        }
        if (adjusted) source = `${source}+scaled`;
    }

    return { tick, source };
}

type SafeTopOfBook = {
    bestBid: number | null;
    bestAsk: number | null;
    valid: boolean;
    reason?: "PRICE_NAN" | "INVALID_TOP_OF_BOOK";
    swapped: boolean;
    synthetic: boolean;
};

function buildDexTradeSafeTopOfBook(params: {
    bestBid?: number | null;
    bestAsk?: number | null;
    mid: number;
    tick: number;
}): SafeTopOfBook {
    let bestBid = isFinitePositive(params.bestBid) ? params.bestBid : null;
    let bestAsk = isFinitePositive(params.bestAsk) ? params.bestAsk : null;
    let swapped = false;
    let synthetic = false;

    if (!bestBid || !bestAsk) {
        if (isFinitePositive(params.mid)) {
            bestBid = params.mid;
            bestAsk = params.mid;
            synthetic = true;
        } else {
            return { bestBid: null, bestAsk: null, valid: false, reason: "PRICE_NAN", swapped, synthetic };
        }
    }

    if (bestBid && bestAsk && bestBid > bestAsk) {
        const tmp = bestBid;
        bestBid = bestAsk;
        bestAsk = tmp;
        swapped = true;
    }

    if (bestBid && bestAsk) {
        const minAsk = bestBid + params.tick * 2;
        if (Number.isFinite(minAsk) && bestAsk < minAsk) {
            bestAsk = minAsk;
        }
    }

    if (!isFinitePositive(bestBid) || !isFinitePositive(bestAsk) || bestBid >= bestAsk) {
        return { bestBid, bestAsk, valid: false, reason: "INVALID_TOP_OF_BOOK", swapped, synthetic };
    }

    return { bestBid, bestAsk, valid: true, swapped, synthetic };
}

type CrossingGuardResult = {
    bid?: number;
    ask?: number;
    skipBuy: boolean;
    skipSell: boolean;
    adjustedBuy: boolean;
    adjustedSell: boolean;
};

function applyCrossingGuard(params: {
    bid?: number;
    ask?: number;
    bestBid?: number | null;
    bestAsk?: number | null;
    tick: number;
}): CrossingGuardResult {
    let bid = params.bid;
    let ask = params.ask;
    let skipBuy = false;
    let skipSell = false;
    let adjustedBuy = false;
    let adjustedSell = false;

    const bestBid = Number.isFinite(params.bestBid) ? (params.bestBid as number) : null;
    const bestAsk = Number.isFinite(params.bestAsk) ? (params.bestAsk as number) : null;
    const tick = params.tick;

    if (typeof bid === "number") {
        if (!bestAsk || bestAsk <= 0) {
            skipBuy = true;
        } else if (bid >= bestAsk) {
            const adjusted = roundToTick(bestAsk - tick, tick);
            if (!Number.isFinite(adjusted) || adjusted <= 0 || adjusted >= bestAsk) {
                skipBuy = true;
            } else {
                bid = adjusted;
                adjustedBuy = true;
            }
        }
        if (!skipBuy && bestAsk && bid >= bestAsk) {
            skipBuy = true;
        }
    }

    if (typeof ask === "number") {
        if (!bestBid || bestBid <= 0) {
            skipSell = true;
        } else if (ask <= bestBid) {
            const adjusted = roundToTick(bestBid + tick, tick);
            if (!Number.isFinite(adjusted) || adjusted <= bestBid) {
                skipSell = true;
            } else {
                ask = adjusted;
                adjustedSell = true;
            }
        }
        if (!skipSell && bestBid && ask <= bestBid) {
            skipSell = true;
        }
    }

    return { bid, ask, skipBuy, skipSell, adjustedBuy, adjustedSell };
}

function computeInventoryBiasedQuotes(params: {
    quotePerOrder: number;
    quoteFree: number;
    baseFree: number;
    mid: number;
    minNotional: number;
    quoteCcy: "USDT" | "BNB";
    k?: number;
}): {
    buyQuote: number;
    sellQuote: number;
    baseRatio: number | null;
    delta: number | null;
    minClamp: number;
    maxClamp: number;
} {
    const k = params.k ?? 1.0;
    const minClamp = Math.max(Number.isFinite(params.minNotional) ? params.minNotional : 0, 0);
    const maxClamp = params.quotePerOrder * 2;

    if (!Number.isFinite(params.mid) || params.mid <= 0) {
        return {
            buyQuote: clamp(params.quotePerOrder, minClamp, maxClamp),
            sellQuote: clamp(params.quotePerOrder, minClamp, maxClamp),
            baseRatio: null,
            delta: null,
            minClamp,
            maxClamp,
        };
    }

    const baseInQuote = params.baseFree * params.mid;
    const total = params.quoteFree + baseInQuote;
    if (!Number.isFinite(total) || total <= 0) {
        return {
            buyQuote: clamp(params.quotePerOrder, minClamp, maxClamp),
            sellQuote: clamp(params.quotePerOrder, minClamp, maxClamp),
            baseRatio: null,
            delta: null,
            minClamp,
            maxClamp,
        };
    }

    const baseRatio = baseInQuote / total;
    const delta = baseRatio - 0.5;
    const buyRaw = params.quotePerOrder * (1 - k * delta);
    const sellRaw = params.quotePerOrder * (1 + k * delta);

    return {
        buyQuote: clamp(buyRaw, minClamp, maxClamp),
        sellQuote: clamp(sellRaw, minClamp, maxClamp),
        baseRatio,
        delta,
        minClamp,
        maxClamp,
    };
}

async function getMarketRules(exchange: ExchangeName, symbol: string, quoteCcy: string): Promise<MarketRules> {
    if (exchange === "nonkyc") {
        const rules = await getNonkycMarketRules(symbol);
        return {
            minNotional: rules.minNotional,
            minQty: rules.minQty,
            qtyStep: rules.qtyStep,
            priceTick: rules.priceTick,
            source: rules.source,
        };
    }
    const qtyPrecision = getQtyPrecision(exchange);
    const pricePrecision = getPricePrecision(exchange);
    const step = Math.pow(10, -qtyPrecision);
    const tick = Math.pow(10, -pricePrecision);
    const minNotional = getMinNotional(exchange, quoteCcy);

    return {
        minNotional,
        minQty: step,
        qtyStep: step,
        priceTick: tick,
        source: exchange === "dextrade" ? "config" : "fallback",
    };
}

async function cancelExchangeOrders(exchange: ExchangeName, accessKey: string, secretKey: string, orderIds: string[], pair?: string): Promise<{ ok: boolean; failed?: number }> {
    if (orderIds.length === 0) return { ok: true };

    let failed = 0;
    for (const orderId of orderIds) {
        let result: { ok: boolean; status?: number; error?: string; reason?: string };
        if (exchange === "nonkyc") {
            result = await cancelNonKycOrder(accessKey, secretKey, orderId);
        } else if (exchange === "dextrade") {
            const { cancelDexTradeOrder } = await import("../exchanges/dextrade.js");
            // Normalize pair if provided (remove slash for Dex-Trade)
            const dexSymbol = pair ? pair.replace("/", "") : undefined;
            result = await cancelDexTradeOrder(accessKey, secretKey, orderId, dexSymbol);
        } else {
            console.warn(`[mmRunner] cancel not supported for ${exchange}`);
            failed += 1;
            continue;
        }

        if (!result.ok) {
            // Treat "not found" / "already closed" as success (idempotent cancel)
            const isIdempotentError =
                result.status === 404 ||
                result.reason === "ORDER_NOT_FOUND" ||
                (result.error && /not found|already.*closed|cancelled|canceled/i.test(result.error));

            if (isIdempotentError) {
                console.log(`[mmRunner] cancel orderId=${orderId} idempotent (already closed / not found) on ${exchange}`);
            } else {
                failed += 1;
                console.warn(`[mmRunner] cancel orderId=${orderId} failed on ${exchange}: ${result.error || result.reason || "unknown"}`);
            }
        }
    }
    return { ok: failed === 0, failed };
}

export const mmRunner: StrategyRunner = {
    type: "MM",
    async tick(configId: number, now: number): Promise<void> {
        const config = getStrategyConfigById(configId);
        if (!config || config.strategy !== "MM") return;
        if (!config.enabled || config.disabled_reason === "STOPPING") {
            console.log(`[mmRunner] skip config=${configId}: disabled`);
            return;
        }

        if (runningConfigs.has(configId)) {
            console.log(`[mmRunner] skip config=${configId}: already running`);
            return;
        }
        runningConfigs.add(configId);

        try {
            await wrapStrategyTick(config, async () => {
                const shouldAbort = (): boolean => {
                    const fresh = getStrategyConfigById(configId);
                    return !fresh || fresh.enabled !== 1 || fresh.disabled_reason === "STOPPING";
                };
                const exchange = config.exchange as ExchangeName;
                const symbol = getExchangeSymbol(exchange, config.pair);
                const quoteCcy = getQuoteUnit(exchange, config.pair) || "USDT";

                if (exchange === "nestex" && NESTEX_DEBUG) {
                    console.log(`[nestex:debug] symbol mapping: pair=${config.pair} exchangeSymbol=${symbol}`);
                }

                const params = safeParse(config.params_json);
                const spreadPct = params.spread_pct ?? 0.01;
                // Support both new quote_per_order and legacy order_quote
                const quotePerOrder = params.quote_per_order ?? params.order_quote ?? 1;
                const ordersPerSide = params.orders_per_side ?? 1;
                const refreshSec = params.refresh_sec ?? DEFAULT_REFRESH_SEC;
                const midSource = params.mid_source ?? "aggregated";
                const maxPositionBase = params.max_position_base ?? 0;
                const mmMode: MmMode = params.mode ?? "TWO_SIDED";
                const minBaseInventory = params.min_base_inventory ?? 0;
                const minQuoteInventory = params.min_quote_inventory ?? 0;
                let inventoryBase = params.inventory_base ?? 0;
                let inventoryQuote = params.inventory_quote ?? quotePerOrder * 10;
                let balanceTs: number | null = null;
                let balanceStalenessMs: number | null = null;

                // Tracking for status display
                let placedBuy = 0;
                let placedSell = 0;
                const actions: string[] = [];
                const errors: string[] = [];
                const skipReasons: string[] = [];
                const skipReasonSet = new Set<string>();
                let inventorySource = "REAL";

                const recordSkip = (reason: string, opts?: { silent?: boolean }): void => {
                    if (!skipReasonSet.has(reason)) {
                        skipReasonSet.add(reason);
                        skipReasons.push(reason);
                    }
                    if (!opts?.silent) {
                        errors.push(reason);
                    }
                };

                // Log orders_per_side config
                console.log(`[mmRunner] config=${config.id} orders_per_side=${ordersPerSide} quote_per_order=${quotePerOrder}`);

                if (!Number.isFinite(spreadPct) || spreadPct <= 0 || !Number.isFinite(quotePerOrder) || quotePerOrder <= 0) {
                    return {
                        success: false,
                        error: { message: "MM params invalid: check spread/order size." }
                    };
                }
                if (shouldAbort()) {
                    recordSkip("STOPPING", { silent: true });
                    return { success: true };
                }

                let priceResult = null;
                try {
                    if (midSource === "aggregated") {
                        priceResult = await fetchAggregatedPrice(config.pair);
                    }
                    if (!priceResult) {
                        priceResult = await fetchExchangePrice(config.exchange as ExchangeName, config.pair);
                    }
                } catch (err: any) {
                    return {
                        success: false,
                        error: { message: err.message || "Price fetch failed", code: err.code }
                    };
                }

                if (!priceResult || !Number.isFinite(priceResult.price) || priceResult.price <= 0) {
                    return {
                        success: false,
                        error: { message: "Price unavailable (MM)", code: "INVALID_MARKET" }
                    };
                }
                const mid = priceResult.price;

                let apiKey = "";
                let apiSecret = "";
                if (config.trade_mode === "REAL") {
                    const keyRecord = getExchangeKey(config.tg_user_id, config.exchange);
                    if (!keyRecord) {
                        return { success: false, error: { message: `Missing API keys for REAL mode (${config.exchange})`, code: "AUTH_FAILED" } };
                    }
                    if (keyRecord.exchange !== config.exchange) {
                        console.error(`[mmRunner] MISROUTED_EXCHANGE: config.exchange=${config.exchange} key.exchange=${keyRecord.exchange}`);
                        return { success: false, error: { message: "Exchange routing error", code: "MISROUTED_EXCHANGE" } };
                    }
                    try {
                        const decrypted = decryptKeyPair({
                            keyCipher: keyRecord.key_cipher,
                            secretCipher: keyRecord.secret_cipher,
                            iv: keyRecord.iv,
                            tag: keyRecord.tag,
                        });
                        apiKey = decrypted.apiKey;
                        apiSecret = decrypted.apiSecret;
                    } catch (err) {
                        return { success: false, error: { message: "Failed to decrypt API keys", code: "AUTH_FAILED" } };
                    }
                }

                // Fetch actual balance from Exchange to get real inventory
                if (config.trade_mode === "REAL") {
                    try {
                        const balanceResult = await getExchangeNormalizedBalance(exchange, apiKey, apiSecret, quoteCcy as "USDT" | "BNB", true);
                        if (balanceResult) {
                            inventoryBase = balanceResult.data.freePEPEW;
                            inventoryQuote = balanceResult.data.freeQuote;
                            inventorySource = `${exchange.toUpperCase()}_API`;
                            balanceTs = balanceResult.metadata.fetchedAt;
                            balanceStalenessMs = balanceResult.metadata.cacheAgeMs;
                            console.log(`[mmRunner] Inventory fetched for ${exchange}: Base=${inventoryBase} Quote=${inventoryQuote}`);
                        } else {
                            console.warn(`[mmRunner] REAL mode but balance fetch failed for ${exchange}. Skipping tick (Fail-Closed).`);
                            return { success: false, error: { message: "SKIP: BALANCE_UNAVAILABLE", code: "FETCH_FAILED" } };
                        }
                    } catch (err: any) {
                        const errMsg = err?.message || "Unknown error";
                        console.warn(`[mmRunner] balance fetch error (${exchange}): ${errMsg}`);
                        return { success: false, error: { message: `SKIP: BALANCE_UNAVAILABLE (${errMsg})`, code: "FETCH_FAILED" } };
                    }
                }

                // --- 1. RECONCILE WITH EXCHANGE ---
                let exchangeOpenOrders: any[] = [];
                const localOpenRegistry = getOpenStrategyOrdersRegistry(String(config.id));
                if (config.trade_mode === "REAL") {
                    try {
                        if (exchange === "nonkyc") {
                            const res = await listNonKycOpenOrders(apiKey, apiSecret, symbol);
                            if (res.ok) exchangeOpenOrders = res.orders || [];
                        } else if (exchange === "dextrade") {
                            const res = await listDexTradeOpenOrders(apiKey, apiSecret, symbol);
                            if (res.ok) exchangeOpenOrders = res.orders || [];
                        } else if (exchange === "nestex") {
                            exchangeOpenOrders = localOpenRegistry.map(o => ({
                                order_id: o.order_id,
                                side: String(o.side || "").toLowerCase(),
                            }));
                        }
                    } catch (err) {
                        console.warn(`[mmRunner] config=${config.id} open orders fetch failed:`, err);
                    }
                }

                // Group by side
                const openBuys = exchangeOpenOrders.filter(o => String(o.side || "").toLowerCase() === "buy");
                const openSells = exchangeOpenOrders.filter(o => String(o.side || "").toLowerCase() === "sell");

                // --- 2. CANCEL EXCESS/STALE ORDERS ---
                let totalCancelled = 0;
                const myOrderIdSet = new Set(localOpenRegistry.map(o => o.order_id));

                const cancelOrders = async (orders: any[]) => {
                    // Filter to only cancel orders in our registry OR matching conservative criteria
                    const myOrders = orders.filter(o => {
                        const orderId = String(o.order_id);
                        if (myOrderIdSet.has(orderId)) return true;

                        // Conservative matching fallback for Dex-Trade if registry is out of sync
                        if (exchange === "dextrade") {
                            const orderPrice = Number(o.price);
                            const orderQty = Number(o.quantity);
                            const orderTime = Number(o.created_at);

                            // Criteria:
                            // 1. Created after strategy start (allow 5min buffer)
                            const startTime = config.created_at - (5 * 60 * 1000);
                            const isAfterStart = orderTime > startTime;

                            // 2. Sizing is similar to config
                            const expectedQty = quotePerOrder / (mid || 1);
                            const isSizingClose = Math.abs(orderQty - expectedQty) / expectedQty < 0.2; // 20% tolerance

                            // 3. Price is within spread range (conservative: allow 1.5x spread distance)
                            const isPriceInRange = mid ? (Math.abs(orderPrice - mid) / mid < spreadPct * 1.5) : false;

                            if (isAfterStart && isSizingClose && isPriceInRange) {
                                console.log(`[mmRunner] OWN_ONLY fallback match for Dex-Trade: id=${orderId} price=${o.price} qty=${o.quantity}`);
                                return true;
                            }
                        }
                        return false;
                    });

                    if (myOrders.length === 0 && orders.length > 0) {
                        console.log(`[mmRunner] Skipping ${orders.length} orders as they don't belong to this strategy (OWN_ONLY scope)`);
                        return;
                    }

                    for (const o of myOrders) {
                        const orderId = String(o.order_id || "");
                        if (exchange === "nestex" && !/^\d+$/.test(orderId)) {
                            console.warn(`[mmRunner] Skipping non-numeric NestEx order_id=${orderId}`);
                            continue;
                        }
                        let res: { ok: boolean; status?: number; error?: string } = { ok: false };
                        if (exchange === "nonkyc") {
                            res = await cancelNonKycOrder(apiKey, apiSecret, o.order_id);
                        } else if (exchange === "dextrade") {
                            res = await cancelDexTradeOrder(apiKey, apiSecret, o.order_id, symbol);
                        } else if (exchange === "nestex") {
                            res = await cancelNestExOrder(apiKey, apiSecret, orderId, `USER:${config.tg_user_id}`);
                        }

                        if (res.ok) {
                            updateStrategyOrderStatusRegistry(exchange, orderId, "CANCELLED");
                        }
                    }
                };

                // Enforce orders_per_side: cancel excess
                if (openBuys.length > ordersPerSide) {
                    // Cancel oldest if list is sorted, otherwise just oldest by created_at if skip/limit
                    const excess = openBuys.slice(0, openBuys.length - ordersPerSide);
                    await cancelOrders(excess);
                }
                if (openSells.length > ordersPerSide) {
                    const excess = openSells.slice(0, openSells.length - ordersPerSide);
                    await cancelOrders(excess);
                }

                if (inventoryBase !== (params.inventory_base ?? 0) || inventoryQuote !== (params.inventory_quote ?? quotePerOrder * 10)) {
                    updateStrategyParams(config.id, JSON.stringify({
                        ...params,
                        spread_pct: spreadPct,
                        quote_per_order: quotePerOrder,
                        order_quote: quotePerOrder, // Keep for backward compatibility
                        refresh_sec: refreshSec,
                        mid_source: midSource,
                        max_position_base: maxPositionBase,
                        inventory_base: inventoryBase,
                        inventory_quote: inventoryQuote,
                    }));
                }

                const lastRun = config.last_run_at || 0;
                if (lastRun > 0 && now - lastRun < refreshSec * 1000) {
                    return { success: true };
                }

                const baseRules = await getMarketRules(exchange, symbol, quoteCcy);
                const halfSpread = spreadPct / 2;

                const topOfBook = await fetchExchangeTopOfBook(exchange, config.pair);
                const rawBestBid = topOfBook?.bestBid ?? null;
                const rawBestAsk = topOfBook?.bestAsk ?? null;

                let bestBid = rawBestBid;
                let bestAsk = rawBestAsk;
                let rules = baseRules;
                let dextradeTopReason: "PRICE_NAN" | "INVALID_TOP_OF_BOOK" | null = null;

                if (exchange === "dextrade") {
                    const resolved = resolveDexTradeTick({
                        tick: baseRules.priceTick,
                        bestBid: rawBestBid,
                        bestAsk: rawBestAsk,
                        mid,
                    });
                    rules = {
                        ...baseRules,
                        priceTick: resolved.tick,
                        source: `${baseRules.source}+${resolved.source}`,
                    };
                    const safeTop = buildDexTradeSafeTopOfBook({
                        bestBid: rawBestBid,
                        bestAsk: rawBestAsk,
                        mid,
                        tick: rules.priceTick,
                    });
                    bestBid = safeTop.bestBid;
                    bestAsk = safeTop.bestAsk;
                    if (!safeTop.valid) {
                        dextradeTopReason = safeTop.reason || "INVALID_TOP_OF_BOOK";
                    }
                }

                const hasBestBid = Number.isFinite(bestBid) && (bestBid as number) > 0;
                const hasBestAsk = Number.isFinite(bestAsk) && (bestAsk as number) > 0;
                const midForBias = hasBestBid && hasBestAsk
                    ? ((bestBid as number) + (bestAsk as number)) / 2
                    : mid;

                const bias = computeInventoryBiasedQuotes({
                    quotePerOrder,
                    quoteFree: inventoryQuote,
                    baseFree: inventoryBase,
                    mid: midForBias,
                    minNotional: rules.minNotional,
                    quoteCcy: quoteCcy as "USDT" | "BNB",
                    k: 1.0,
                });
                const buyQuotePerOrder = bias.buyQuote;
                const sellQuotePerOrder = bias.sellQuote;

                let biasLogAt = Number(params.last_bias_log_at) || 0;
                if (!biasLogAt || now - biasLogAt >= BIAS_LOG_INTERVAL_MS) {
                    const ratioStr = bias.baseRatio !== null ? bias.baseRatio.toFixed(4) : "n/a";
                    const deltaStr = bias.delta !== null ? bias.delta.toFixed(4) : "n/a";
                    console.log(
                        `[mmRunner] bias config=${config.id} baseRatio=${ratioStr} delta=${deltaStr} buyQuote=${buyQuotePerOrder} sellQuote=${sellQuotePerOrder}`
                    );
                    biasLogAt = now;
                }

                const orderTrace: Array<{ side: string; price: number; qty: number; notional: number; status: string; reason?: string }> = [];
                logStrategyTickContract({
                    strategyId: config.id,
                    strategyType: "MM",
                    requestedExchangeId: config.exchange,
                    canonicalPair: config.pair,
                    exchangeSymbol: symbol,
                    balanceTs,
                    balanceStalenessMs,
                    bestBid: Number.isFinite(bestBid as number) ? Number(bestBid) : null,
                    bestAsk: Number.isFinite(bestAsk as number) ? Number(bestAsk) : null,
                    guards: skipReasons,
                });

                // --- 2. CANCEL EXCESS/STALE ORDERS ---
                // Enforce orders_per_side: cancel all if we want fresh orders every tick (standard MM)
                // or just cancel the ones that are too far from mid.
                // Given the user request "refresh every 15s" and "runaway orders",
                // the safest is to cancel all open orders for this config before placing new ones,
                // OR strictly cancel the ones we fetched.
                if (exchangeOpenOrders.length > 0) {
                    await cancelOrders(exchangeOpenOrders);
                }

                // Clean up local DB if any (sync)
                const localOpenOrders = getOpenStrategyOrders(config.id);
                if (localOpenOrders.length > 0) {
                    for (const lo of localOpenOrders) {
                        updateStrategyOrderStatus(lo.id, "CANCELED");
                    }
                }

                const placeOrder = async (
                    side: "BUY" | "SELL",
                    price: number,
                    qty: number,
                    notional: number,
                    quoteAmount: number,
                    note?: string
                ): Promise<void> => {
                    if (shouldAbort()) {
                        recordSkip("STOPPING", { silent: true });
                        return;
                    }
                    const baseAsset = getBaseAsset(exchange, config.pair) || "BASE";
                    const quoteAsset = quoteCcy;

                    if (exchange === "nestex") {
                        const minPrice = 1e-12;
                        const maxPrice = 0.01;
                        if (!Number.isFinite(price) || price <= 0 || price < minPrice || price > maxPrice) {
                            orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "PRICE_SANITY_FAILED" });
                            recordSkip(`${side}: PRICE_SANITY_FAILED`);
                            return;
                        }
                        if (hasBestBid && hasBestAsk) {
                            const midCheck = Number.isFinite(midForBias) && midForBias > 0 ? midForBias : null;
                            if (midCheck) {
                                const spread = ((bestAsk as number) - (bestBid as number)) / midCheck;
                                if (!Number.isFinite(spread) || spread > 0.2) {
                                    orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "PRICE_SANITY_SPREAD" });
                                    recordSkip(`${side}: PRICE_SANITY_SPREAD`);
                                    return;
                                }
                            }
                        }
                    }

                    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
                        orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "MIN_QTY" });
                        const msg = `${side}: MIN_QTY`;
                        recordSkip(msg);
                        return;
                    }
                    if (rules.minQty > 0 && qty < rules.minQty) {
                        orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "MIN_QTY" });
                        const msg = `${side}: MIN_QTY (have ${qty.toFixed(0)}, need >= ${rules.minQty.toFixed(0)})`;
                        recordSkip(msg);
                        return;
                    }
                    if (rules.minNotional > 0 && notional < rules.minNotional) {
                        orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "MIN_NOTIONAL" });
                        const suggest = (rules.minNotional * 1.05);
                        const msg = `${side}: MIN_NOTIONAL <${rules.minNotional.toFixed(4)} ${quoteAsset}; suggest >= ${suggest.toFixed(4)} ${quoteAsset}`;
                        recordSkip(msg);
                        return;
                    }

                    // Enhanced inventory checks
                    if (side === "BUY") {
                        if (inventoryQuote < notional) {
                            orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "NO_INVENTORY" });
                            const msg = `${side}: NO_INVENTORY (have ${inventoryQuote.toFixed(2)} ${quoteAsset}, need >= ${notional.toFixed(2)} ${quoteAsset})`;
                            recordSkip(msg);
                            return;
                        }
                    }
                    if (side === "SELL") {
                        if (inventoryBase < qty) {
                            orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "NO_INVENTORY" });
                            const msg = `${side}: NO_INVENTORY (have ${inventoryBase.toFixed(0)} ${baseAsset}, need >= ${qty.toFixed(0)} ${baseAsset})`;
                            recordSkip(msg);
                            return;
                        }
                    }

                    console.log(`[mmRunner] placing ${side} ${symbol} qty=${qty} price=${price}`);

                    if (exchange === "nonkyc") {
                        const orderResult = await createNonKycOrder({
                            accessKey: apiKey,
                            secretKey: apiSecret,
                            symbol,
                            side: side.toLowerCase() as "buy" | "sell",
                            quantity: qty,
                            price,
                            orderType: "limit",
                        });
                        if (orderResult.ok) {
                            if (side === "BUY") placedBuy++;
                            else placedSell++;

                            const exchangeOrderId = orderResult.orderId ?? null;
                            const clientOrderId = `PPW-MM-${config.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

                            insertStrategyOrder({
                                configId: config.id,
                                tgUserId: config.tg_user_id,
                                exchange: config.exchange,
                                pair: config.pair,
                                strategy: config.strategy,
                                tradeMode: config.trade_mode,
                                side,
                                price,
                                qty,
                                quoteQty: quoteAmount,
                                status: "OPEN",
                                exchangeOrderId,
                            });

                            insertStrategyOrderRegistry({
                                strategy_id: String(config.id),
                                exchange: config.exchange,
                                pair: config.pair,
                                order_id: String(exchangeOrderId || clientOrderId),
                                client_order_id: clientOrderId,
                                side,
                                price: String(price),
                                qty: String(qty),
                                status: "OPEN",
                            });

                            actions.push(`${side}`);
                            orderTrace.push({ side, price, qty, notional, status: "PLACED", reason: note });
                        } else {
                            const errorCode = orderResult.reason || "ORDER_FAILED";
                            recordSkip(`${side}: ${errorCode}`);
                            orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: errorCode });
                        }
                    } else if (exchange === "dextrade") {
                        const orderResult = await createDexTradeOrder({
                            loginToken: apiKey,
                            secret: apiSecret,
                            pair: symbol,
                            side,
                            tradeType: "LIMIT",
                            volume: qty,
                            rate: price,
                        });
                        if (orderResult.ok) {
                            if (side === "BUY") placedBuy++;
                            else placedSell++;

                            const exchangeOrderId = orderResult.data?.data?.order_id ?? orderResult.data?.data?.id ?? orderResult.data?.order_id ?? orderResult.data?.id ?? null;
                            const clientOrderId = `PPW-MM-${config.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

                            insertStrategyOrder({
                                configId: config.id,
                                tgUserId: config.tg_user_id,
                                exchange: config.exchange,
                                pair: config.pair,
                                strategy: config.strategy,
                                tradeMode: config.trade_mode,
                                side,
                                price,
                                qty,
                                quoteQty: quoteAmount,
                                status: "OPEN",
                                exchangeOrderId,
                            });

                            insertStrategyOrderRegistry({
                                strategy_id: String(config.id),
                                exchange: config.exchange,
                                pair: config.pair,
                                order_id: String(exchangeOrderId || clientOrderId),
                                client_order_id: clientOrderId,
                                side,
                                price: String(price),
                                qty: String(qty),
                                status: "OPEN",
                            });

                            actions.push(`${side}`);
                            orderTrace.push({ side, price, qty, notional, status: "PLACED", reason: note });
                        } else {
                            recordSkip(`${side}: ORDER_FAILED`);
                            orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: "ORDER_FAILED" });
                        }
                    } else if (exchange === "nestex") {
                        const orderResult = await placeNestExLimitOrder({
                            apiKey,
                            apiSecret,
                            cur: symbol,
                            side,
                            qty,
                            price,
                            rateLimitKey: `USER:${config.tg_user_id}`,
                            pair: config.pair,
                            baseQty: qty,
                            quoteQty: quoteAmount,
                        });
                        if (orderResult.ok) {
                            if (side === "BUY") placedBuy++;
                            else placedSell++;

                            const exchangeOrderId = orderResult.orderId ?? null;
                            const clientOrderId = `PPW-MM-${config.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

                            insertStrategyOrder({
                                configId: config.id,
                                tgUserId: config.tg_user_id,
                                exchange: config.exchange,
                                pair: config.pair,
                                strategy: config.strategy,
                                tradeMode: config.trade_mode,
                                side,
                                price,
                                qty,
                                quoteQty: quoteAmount,
                                status: "OPEN",
                                exchangeOrderId,
                                clientOrderId,
                            });

                            if (exchangeOrderId) {
                                insertStrategyOrderRegistry({
                                    strategy_id: String(config.id),
                                    exchange: config.exchange,
                                    pair: config.pair,
                                    order_id: String(exchangeOrderId),
                                    client_order_id: clientOrderId,
                                    side,
                                    price: String(price),
                                    qty: String(qty),
                                    status: "OPEN",
                                });
                            } else {
                                console.warn(`[mmRunner] nestex order placed but no exchangeOrderId: config=${config.id} clientOrderId=${clientOrderId}`);
                            }

                            actions.push(`${side}`);
                            orderTrace.push({ side, price, qty, notional, status: "PLACED", reason: note });
                            console.log(`[mmRunner] nestex placed exchangeOrderId=${exchangeOrderId ?? "n/a"} clientOrderId=${clientOrderId}`);
                        } else {
                            const errorCode = orderResult.error || "ORDER_FAILED";
                            recordSkip(`${side}: ${errorCode}`);
                            orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: "ORDER_FAILED" });
                        }
                    }
                };

                // Place orders based on mode
                const shouldPlaceBuy = mmMode !== "ONE_SIDED_SELL";
                const shouldPlaceSell = mmMode !== "ONE_SIDED_BUY";
                const baseAsset = getBaseAsset(exchange, config.pair) || "BASE";

                let allowBuy = shouldPlaceBuy;
                let allowSell = shouldPlaceSell;

                if (exchange === "dextrade" && dextradeTopReason) {
                    recordSkip(dextradeTopReason, { silent: true });
                    allowBuy = false;
                    allowSell = false;
                } else {
                    if (allowBuy && !hasBestAsk) {
                        recordSkip("CROSSING_GUARD", { silent: true });
                        allowBuy = false;
                    }
                    if (allowSell && !hasBestBid) {
                        recordSkip("CROSSING_GUARD", { silent: true });
                        allowSell = false;
                    }
                }

                if (allowBuy) {
                    const requiredQuote = quotePerOrder * ordersPerSide * FEE_BUFFER;
                    if (!Number.isFinite(requiredQuote) || inventoryQuote < requiredQuote) {
                        const needStr = Number.isFinite(requiredQuote) ? requiredQuote.toFixed(2) : "n/a";
                        const msg = `BUY: NO_INVENTORY (have ${inventoryQuote.toFixed(2)} ${quoteCcy}, need >= ${needStr} ${quoteCcy})`;
                        recordSkip(msg);
                        allowBuy = false;
                    }
                }

                if (allowSell) {
                    const refPrice = hasBestBid ? (bestBid as number) : midForBias;
                    const requiredBase = Number.isFinite(refPrice) && refPrice > 0
                        ? (sellQuotePerOrder / refPrice) * ordersPerSide
                        : Number.POSITIVE_INFINITY;
                    if (!Number.isFinite(requiredBase) || inventoryBase < requiredBase) {
                        const needStr = Number.isFinite(requiredBase) ? requiredBase.toFixed(0) : "n/a";
                        const msg = `SELL: NO_INVENTORY (have ${inventoryBase.toFixed(0)} ${baseAsset}, need >= ${needStr} ${baseAsset})`;
                        recordSkip(msg);
                        allowSell = false;
                    }
                }

                if (exchange === "nestex" && NESTEX_ORDER_DEBUG) {
                    const buyReason = allowBuy ? "OK" : (skipReasons[0] || "SKIP");
                    const sellReason = allowSell ? "OK" : (skipReasons[0] || "SKIP");
                    console.log(`[nestex:order] decision: allowBuy=${allowBuy} allowSell=${allowSell} buyReason=${buyReason} sellReason=${sellReason}`);
                }

                const rawBidSample = roundToTick(normalizePrice(mid * (1 - halfSpread)), rules.priceTick);
                const rawAskSample = roundToTick(normalizePrice(mid * (1 + halfSpread)), rules.priceTick);

                if (exchange === "nestex" && NESTEX_ORDER_DEBUG) {
                    const bb = Number.isFinite(bestBid as number) ? Number(bestBid) : null;
                    const ba = Number.isFinite(bestAsk as number) ? Number(bestAsk) : null;
                    console.log(`[nestex:order] quotes: mid=${mid} bestBid=${bb} bestAsk=${ba} bidCalc=${rawBidSample} askCalc=${rawAskSample} spreadPct=${spreadPct}`);
                }

                // BUY LADDER
                if (allowBuy) {
                    for (let i = 0; i < ordersPerSide; i++) {
                        if (shouldAbort()) {
                            recordSkip("STOPPING", { silent: true });
                            break;
                        }
                        const tierSpread = halfSpread * (i + 1);
                        const rawPrice = roundToTick(normalizePrice(mid * (1 - tierSpread)), rules.priceTick);
                        const guard = applyCrossingGuard({
                            bid: rawPrice,
                            bestAsk,
                            bestBid,
                            tick: rules.priceTick,
                        });
                        if (guard.skipBuy) {
                            recordSkip("CROSSING_GUARD", { silent: true });
                            continue;
                        }
                        const price = guard.bid ?? rawPrice;
                        const qty = roundToStep(buyQuotePerOrder / price, rules.qtyStep);
                        const notional = qty * price;
                        await placeOrder("BUY", price, qty, notional, buyQuotePerOrder, guard.adjustedBuy ? "ADJUSTED" : undefined);
                    }
                }

                // SELL LADDER
                if (allowSell) {
                    for (let i = 0; i < ordersPerSide; i++) {
                        if (shouldAbort()) {
                            recordSkip("STOPPING", { silent: true });
                            break;
                        }
                        const tierSpread = halfSpread * (i + 1);
                        const rawPrice = roundToTick(normalizePrice(mid * (1 + tierSpread)), rules.priceTick);
                        const guard = applyCrossingGuard({
                            ask: rawPrice,
                            bestAsk,
                            bestBid,
                            tick: rules.priceTick,
                        });
                        if (guard.skipSell) {
                            recordSkip("CROSSING_GUARD", { silent: true });
                            continue;
                        }
                        const price = guard.ask ?? rawPrice;
                        const qty = roundToStep(sellQuotePerOrder / price, rules.qtyStep);
                        const notional = qty * price;
                        await placeOrder("SELL", price, qty, notional, sellQuotePerOrder, guard.adjustedSell ? "ADJUSTED" : undefined);
                    }
                }

                if (exchange === "dextrade" && orderTrace.length === 0) {
                    const skipReason = skipReasons[0] || dextradeTopReason || "UNKNOWN";
                    const bb = Number.isFinite(bestBid as number) ? String(bestBid) : "n/a";
                    const ba = Number.isFinite(bestAsk as number) ? String(bestAsk) : "n/a";
                    console.log(
                        `[mmRunner] dextrade-skip exchange=dextrade pair=${config.pair} bestBid=${bb} bestAsk=${ba} mid=${mid} rawBid=${rawBidSample} rawAsk=${rawAskSample} tick=${rules.priceTick} skipReason=${skipReason}`
                    );
                }

                const trace = {
                    runner: "mmRunner",
                    configId: config.id,
                    exchange,
                    pair: config.pair,
                    rules,
                    orders: orderTrace,
                    openOrders: exchangeOpenOrders.length,
                    placedBuy,
                    placedSell,
                    ordersPerSide,
                    quotePerOrder,
                    cancelledCount: totalCancelled,
                };
                console.log(`[mmRunner] trace ${JSON.stringify(trace)}`);
                console.log(`[mmRunner] summary: config=${config.id} buyPlaced=${placedBuy} sellPlaced=${placedSell} orders_per_side=${ordersPerSide}`);

                // Persist status tracking fields
                const lastAction = actions.length > 0
                    ? `PLACED ${actions.join(",")}`
                    : (errors.length > 0 ? "SKIP" : (skipReasons.length > 0 ? `SKIP: ${skipReasons[0]}` : "OK"));
                updateStrategyParams(config.id, JSON.stringify({
                    ...params,
                    spread_pct: spreadPct,
                    quote_per_order: quotePerOrder,
                    orders_per_side: ordersPerSide,
                    // Keep order_quote for backward compatibility
                    order_quote: quotePerOrder,
                    refresh_sec: refreshSec,
                    mid_source: midSource,
                    max_position_base: maxPositionBase,
                    mode: mmMode,
                    min_base_inventory: minBaseInventory,
                    min_quote_inventory: minQuoteInventory,
                    inventory_base: inventoryBase,
                    inventory_quote: inventoryQuote,
                    last_action: lastAction,
                    last_action_at: now,
                    open_orders_count: exchangeOpenOrders.length,
                    placed_buy: placedBuy,
                    placed_sell: placedSell,
                    skip_reasons: skipReasons.slice(0, 3) || [],
                    last_bias_log_at: biasLogAt,
                }));

                updateStrategyLastRunAt(config.id, now);
                if (actions.length > 0) {
                    const skipSuffix = errors.length > 0 ? `; SKIP: ${errors.join("; ")}` : "";
                    insertStrategyEvent({
                        configId: config.id,
                        level: "INFO",
                        message: `MM PLACED ${actions.length} order(s): ${actions.join(", ")}${skipSuffix}`,
                    });
                } else if (errors.length > 0) {
                    const errorCodes = errors
                        .map((entry) => entry.split(":")[1]?.trim().toUpperCase().split(" ")[0])
                        .filter((value): value is string => Boolean(value));
                    const preferred = ["NO_INVENTORY", "MIN_NOTIONAL", "MIN_QTY", "PRECISION", "OPEN_ORDERS", "MAX_POSITION"];
                    const resolvedCode = preferred.find((code) => errorCodes.includes(code)) || "UNKNOWN";
                    console.warn(`[mmRunner] SKIP config=${config.id} exchange=${exchange} reason=${skipReasons[0] || errors[0] || "unknown"}`);
                    insertStrategyEvent({
                        configId: config.id,
                        level: "WARN",
                        message: `MM SKIP: ${skipReasons[0] || errors[0] || "unknown"}`,
                    });
                    return {
                        success: false,
                        error: { message: `MM SKIP: ${skipReasons[0] || errors[0] || "unknown"}`, code: resolvedCode }
                    };
                }

                console.log(`[mmRunner] refreshed config=${config.id} exchange=${config.exchange} pair=${config.pair}`);
                return { success: true };

            }, now);
        } finally {
            runningConfigs.delete(configId);
        }
    },
};
