import {
    cancelOpenStrategyOrders,
    closeMissingStrategyOrdersRegistry,
    getExchangeKey,
    getOpenStrategyOrders,
    getStrategyConfigById,
    insertTradeAudit,
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
import { placeNestExLimitOrder, cancelNestExOrder, listNestExOpenOrders } from "../exchanges/nestex.js";
import { ExchangeName, getBaseAsset, getExchangeSymbol, getQuoteUnit } from "../lib/markets.js";
import { getMinNotional, getPricePrecision, getQtyPrecision } from "../lib/exchanges.js";
import { fetchAggregatedPrice, fetchExchangePrice, fetchExchangeTopOfBook } from "./price.js";
import { StrategyRunner } from "./types.js";
import { wrapStrategyTick } from "../lib/runner-wrapper.js";
import { getExchangeNormalizedBalance } from "../lib/fundsCheck.js";
import { logStrategyTickContract } from "./logContract.js";
import { tradeLog } from "../lib/tradeLogger.js";

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
const NESTEX_TARGET_NOTIONAL_USDT = 1;
const MM_THROTTLE_SEC = Math.max(5, Number(process.env.LOG_THROTTLE_SEC || 30));
const MM_SKIP_AUDIT_THROTTLE_MS = Math.max(5_000, Number(process.env.MM_SKIP_AUDIT_THROTTLE_MS || 30_000));
const mmSkipAuditAt = new Map<string, number>();

function mmLog(params: {
    level?: "debug" | "info" | "warn" | "error";
    message: string;
    configId?: number | null;
    exchange?: string | null;
    throttleKey?: string;
    throttleSec?: number;
}): void {
    tradeLog({
        scope: "mmRunner",
        level: params.level || "info",
        strategyId: params.configId ?? null,
        exchange: params.exchange ?? null,
        message: params.message,
        throttleKey: params.throttleKey,
        throttleSec: params.throttleSec ?? MM_THROTTLE_SEC,
    });
}

function shouldRecordMmSkipAudit(configId: number, reason: string, now: number): boolean {
    const key = `${configId}:${reason}`;
    const prev = mmSkipAuditAt.get(key) || 0;
    if (now - prev < MM_SKIP_AUDIT_THROTTLE_MS) return false;
    mmSkipAuditAt.set(key, now);
    return true;
}

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

function ceilToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
    return Math.ceil(value / step) * step;
}

function roundToTick(value: number, tick: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
    return Math.round(value / tick) * tick;
}

function floorToTick(value: number, tick: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
    return Math.floor(value / tick) * tick;
}

function ceilToTick(value: number, tick: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
    return Math.ceil(value / tick) * tick;
}

function normalizePercentRatio(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    if (value <= 0) return fallback;
    if (value >= 1) return value / 100;
    return value;
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

function normalizeMmOrderSide(value: any): "buy" | "sell" | "unknown" {
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw) return "unknown";
    if (raw === "buy" || raw === "bid" || raw === "b" || raw === "0") return "buy";
    if (raw === "sell" || raw === "ask" || raw === "s" || raw === "1") return "sell";
    if (raw.includes("buy") || raw.includes("bid")) return "buy";
    if (raw.includes("sell") || raw.includes("ask")) return "sell";
    return "unknown";
}

function resolveQuotePerOrder(exchange: ExchangeName, configuredQuotePerOrder: number): number {
    if (exchange === "nestex") return NESTEX_TARGET_NOTIONAL_USDT;
    return configuredQuotePerOrder;
}

function isIdempotentCancelMessage(value: string | undefined | null): boolean {
    if (!value) return false;
    return /not found|not exist|already.*(closed|cancel)|canceled|cancelled|check the order_id/i.test(value);
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
    const toTickUnit = (value: number): number => Math.round(value / tick);

    if (typeof bid === "number") {
        if (!bestAsk || bestAsk <= 0) {
            skipBuy = true;
        } else if (bid >= bestAsk) {
            const adjusted = floorToTick(bestAsk - tick, tick);
            if (!Number.isFinite(adjusted) || adjusted <= 0 || adjusted >= bestAsk) {
                skipBuy = true;
            } else {
                bid = adjusted;
                adjustedBuy = true;
            }
        }
        if (!skipBuy && Number.isFinite(tick) && tick > 0 && Number.isFinite(bestAsk) && Number.isFinite(bid)) {
            const askUnit = toTickUnit(bestAsk as number);
            let bidUnit = toTickUnit(bid as number);
            if (bidUnit >= askUnit) {
                bidUnit = askUnit - 1;
                if (bidUnit <= 0) {
                    skipBuy = true;
                } else {
                    bid = floorToTick(bidUnit * tick, tick);
                    adjustedBuy = true;
                }
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
            const adjusted = ceilToTick(bestBid + tick, tick);
            if (!Number.isFinite(adjusted) || adjusted <= bestBid) {
                skipSell = true;
            } else {
                ask = adjusted;
                adjustedSell = true;
            }
        }
        if (!skipSell && Number.isFinite(tick) && tick > 0 && Number.isFinite(bestBid) && Number.isFinite(ask)) {
            const bidUnit = toTickUnit(bestBid as number);
            let askUnit = toTickUnit(ask as number);
            if (askUnit <= bidUnit) {
                askUnit = bidUnit + 1;
                ask = ceilToTick(askUnit * tick, tick);
                adjustedSell = true;
            }
        }
        if (!skipSell && bestBid && ask <= bestBid) {
            skipSell = true;
        }
    }

    return { bid, ask, skipBuy, skipSell, adjustedBuy, adjustedSell };
}

function inferTickPrecision(tick: number): number {
    if (!Number.isFinite(tick) || tick <= 0) return 8;
    const asText = tick.toString();
    if (asText.includes("e-")) {
        const exp = Number(asText.split("e-")[1]);
        if (Number.isFinite(exp) && exp >= 0) return exp;
    }
    const dot = asText.indexOf(".");
    return dot >= 0 ? asText.length - dot - 1 : 0;
}

function toTickUnitKey(price: number, tick: number): string {
    if (!Number.isFinite(price)) return "nan";
    if (!Number.isFinite(tick) || tick <= 0) return normalizePrice(price).toString();
    return String(Math.round(price / tick));
}

function formatPriceByTick(price: number, tick: number): string {
    if (!Number.isFinite(price)) return "nan";
    const precision = Math.min(14, Math.max(0, inferTickPrecision(tick)));
    return price.toFixed(precision);
}

function moveOutwardByTick(params: {
    side: "BUY" | "SELL";
    candidate: number;
    tick: number;
    seenUnits: Set<string>;
    maxAttempts?: number;
}): { price: number | null; attempts: number } {
    const maxAttempts = params.maxAttempts ?? 64;
    if (!Number.isFinite(params.candidate) || params.candidate <= 0 || !Number.isFinite(params.tick) || params.tick <= 0) {
        return { price: null, attempts: 0 };
    }

    let candidate = params.candidate;
    let attempts = 0;
    while (attempts <= maxAttempts) {
        if (candidate > 0) {
            const key = toTickUnitKey(candidate, params.tick);
            if (!params.seenUnits.has(key)) {
                params.seenUnits.add(key);
                return { price: candidate, attempts };
            }
        }
        candidate = params.side === "BUY"
            ? floorToTick(candidate - params.tick, params.tick)
            : ceilToTick(candidate + params.tick, params.tick);
        attempts += 1;
    }
    return { price: null, attempts };
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
            mmLog({
                level: "warn",
                exchange,
                message: `cancel not supported for ${exchange}`,
                throttleKey: `mmRunner:cancel-not-supported:${exchange}`,
            });
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
                mmLog({
                    level: "debug",
                    exchange,
                    message: `cancel orderId=${orderId} idempotent (already closed / not found)`,
                    throttleKey: `mmRunner:cancel-idempotent:${exchange}:${orderId}`,
                    throttleSec: 10,
                });
            } else {
                failed += 1;
                mmLog({
                    level: "warn",
                    exchange,
                    message: `cancel orderId=${orderId} failed: ${result.error || result.reason || "unknown"}`,
                    throttleKey: `mmRunner:cancel-fail:${exchange}:${result.error || result.reason || "unknown"}`,
                });
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
            mmLog({
                level: "debug",
                configId,
                exchange: config.exchange,
                message: "skip: disabled",
                throttleKey: `mmRunner:skip-disabled:${configId}`,
            });
            return;
        }

        if (runningConfigs.has(configId)) {
            mmLog({
                level: "debug",
                configId,
                exchange: config.exchange,
                message: "skip: already running",
                throttleKey: `mmRunner:skip-running:${configId}`,
                throttleSec: 10,
            });
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
                    mmLog({
                        level: "debug",
                        configId: config.id,
                        exchange,
                        message: `nestex symbol mapping pair=${config.pair} exchangeSymbol=${symbol}`,
                    });
                }

                const params = safeParse(config.params_json);
                const rawSpreadPct = params.spread_pct ?? 0.01;
                const spreadPct = normalizePercentRatio(rawSpreadPct, 0.01);
                // Support both new quote_per_order and legacy order_quote
                const configuredQuotePerOrder = params.quote_per_order ?? params.order_quote ?? 1;
                const quotePerOrder = resolveQuotePerOrder(exchange, configuredQuotePerOrder);
                const ordersPerSide = params.orders_per_side ?? 1;
                const refreshSec = params.refresh_sec ?? DEFAULT_REFRESH_SEC;
                const requestedMidSource = params.mid_source === "aggregated" ? "aggregated" : "exchange";
                let effectiveMidSource: "exchange" | "aggregated_fallback" = "exchange";
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
                mmLog({
                    level: "info",
                    configId: config.id,
                    exchange,
                    message: `config orders_per_side=${ordersPerSide} quote_per_order=${quotePerOrder} configured_quote_per_order=${configuredQuotePerOrder}`,
                    throttleKey: `mmRunner:config:${config.id}`,
                    throttleSec: 60,
                });
                if (rawSpreadPct !== spreadPct) {
                    mmLog({
                        level: "warn",
                        configId: config.id,
                        exchange,
                        message: `normalized spread_pct from ${rawSpreadPct} to ${spreadPct}`,
                        throttleKey: `mmRunner:spread-normalized:${config.id}`,
                        throttleSec: 60,
                    });
                }

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
                    // Always prefer local exchange mid for quoting stability.
                    priceResult = await fetchExchangePrice(config.exchange as ExchangeName, config.pair);
                    if (!priceResult && requestedMidSource === "aggregated") {
                        const agg = await fetchAggregatedPrice(config.pair);
                        if (agg) {
                            priceResult = agg;
                            effectiveMidSource = "aggregated_fallback";
                        }
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
                        mmLog({
                            level: "error",
                            configId: config.id,
                            exchange,
                            message: `MISROUTED_EXCHANGE config.exchange=${config.exchange} key.exchange=${keyRecord.exchange}`,
                        });
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
                            mmLog({
                                level: "debug",
                                configId: config.id,
                                exchange,
                                message: `inventory fetched base=${inventoryBase} quote=${inventoryQuote}`,
                                throttleKey: `mmRunner:inventory:${config.id}`,
                            });
                        } else {
                            mmLog({
                                level: "warn",
                                configId: config.id,
                                exchange,
                                message: "REAL mode but balance fetch failed. Skipping tick (Fail-Closed).",
                                throttleKey: `mmRunner:balance-unavailable:${config.id}`,
                            });
                            return { success: false, error: { message: "SKIP: BALANCE_UNAVAILABLE", code: "FETCH_FAILED" } };
                        }
                    } catch (err: any) {
                        const errMsg = err?.message || "Unknown error";
                        mmLog({
                            level: "warn",
                            configId: config.id,
                            exchange,
                            message: `balance fetch error: ${errMsg}`,
                            throttleKey: `mmRunner:balance-error:${config.id}:${errMsg}`,
                        });
                        return { success: false, error: { message: `SKIP: BALANCE_UNAVAILABLE (${errMsg})`, code: "FETCH_FAILED" } };
                    }
                }

                // --- 1. RECONCILE WITH EXCHANGE ---
                let exchangeOpenOrders: any[] = [];
                let localOpenRegistry = getOpenStrategyOrdersRegistry(String(config.id));
                let openOrdersSource = "none";
                if (config.trade_mode === "REAL") {
                    try {
                        if (exchange === "nonkyc") {
                            const res = await listNonKycOpenOrders(apiKey, apiSecret, symbol);
                            if (res.ok) {
                                exchangeOpenOrders = res.orders || [];
                                openOrdersSource = "exchange";
                            } else {
                                openOrdersSource = `exchange_error:${res.reason || res.error || "unknown"}`;
                            }
                        } else if (exchange === "dextrade") {
                            const res = await listDexTradeOpenOrders(apiKey, apiSecret, symbol);
                            if (res.ok) {
                                exchangeOpenOrders = res.orders || [];
                                openOrdersSource = "exchange";
                            } else {
                                openOrdersSource = `exchange_error:${res.error || "unknown"}`;
                            }
                        } else if (exchange === "nestex") {
                            const res = await listNestExOpenOrders(
                                apiKey,
                                apiSecret,
                                config.pair,
                                `USER:${config.tg_user_id}`,
                                { exhaustive: true, includeNoCur: true }
                            );
                            if (res.ok && Array.isArray(res.orders)) {
                                exchangeOpenOrders = res.orders.map((o: any) => ({
                                    order_id: String(o.order_id || o.id || ""),
                                    side: normalizeMmOrderSide(o.side ?? o.type ?? o.order_type ?? o.raw?.side ?? o.raw?.type ?? o.raw?.order_type),
                                    price: Number(o.price ?? o.raw?.price ?? 0),
                                    quantity: Number(o.quantity ?? o.raw?.quantity ?? o.raw?.qty ?? 0),
                                    created_at: Number(o.raw?.time || o.raw?.created_at || 0) * 1000,
                                }));
                                openOrdersSource = "exchange";
                            } else {
                                // Fallback: preserve behavior if NestEx openOrders endpoint fails.
                                exchangeOpenOrders = localOpenRegistry.map(o => ({
                                    order_id: o.order_id,
                                    side: normalizeMmOrderSide(o.side),
                                }));
                                openOrdersSource = "local_registry_fallback";
                            }
                        }
                    } catch (err) {
                        mmLog({
                            level: "warn",
                            configId: config.id,
                            exchange,
                            message: `open orders fetch failed: ${(err as any)?.message || String(err)}`,
                            throttleKey: `mmRunner:open-orders-error:${config.id}`,
                            throttleSec: 20,
                        });
                        openOrdersSource = "exception";
                    }
                } else {
                    openOrdersSource = "paper_or_disabled";
                }
                if (exchangeOpenOrders.length === 0 && localOpenRegistry.length > 0 && exchange === "nestex" && openOrdersSource !== "exchange") {
                    exchangeOpenOrders = localOpenRegistry.map(o => ({
                        order_id: o.order_id,
                        side: normalizeMmOrderSide(o.side),
                    }));
                    if (openOrdersSource === "none") {
                        openOrdersSource = "local_registry_fallback";
                    }
                }

                if (config.trade_mode === "REAL" && openOrdersSource === "exchange" && (exchange === "nonkyc" || exchange === "dextrade" || exchange === "nestex")) {
                    const liveOrderIds = exchangeOpenOrders
                        .map((o: any) => String(o?.order_id ?? "").trim())
                        .filter(Boolean);
                    const closedMissing = closeMissingStrategyOrdersRegistry(
                        String(config.id),
                        exchange,
                        config.pair,
                        liveOrderIds,
                        "CLOSED"
                    );
                    if (closedMissing > 0) {
                        localOpenRegistry = getOpenStrategyOrdersRegistry(String(config.id));
                        mmLog({
                            level: "info",
                            configId: config.id,
                            exchange,
                            message: `reconciled local registry pair=${config.pair} closedMissing=${closedMissing} live=${liveOrderIds.length}`,
                            throttleKey: `mmRunner:reconcile:${config.id}`,
                            throttleSec: 20,
                        });
                    }
                }

                const managedOrderIdSet = new Set(localOpenRegistry.map((o) => String(o.order_id || "").trim()).filter(Boolean));

                // Group by side
                const openBuys = exchangeOpenOrders.filter(o => normalizeMmOrderSide(o.side) === "buy");
                const openSells = exchangeOpenOrders.filter(o => normalizeMmOrderSide(o.side) === "sell");
                const openUnknown = exchangeOpenOrders.filter(o => normalizeMmOrderSide(o.side) === "unknown");
                const managedOpenOrders = exchangeOpenOrders.filter((o) => managedOrderIdSet.has(String(o.order_id || "").trim()));
                const managedOpenBuys = managedOpenOrders.filter(o => normalizeMmOrderSide(o.side) === "buy");
                const managedOpenSells = managedOpenOrders.filter(o => normalizeMmOrderSide(o.side) === "sell");
                const managedOpenUnknown = managedOpenOrders.filter(o => normalizeMmOrderSide(o.side) === "unknown");
                mmLog({
                    level: "info",
                    configId: config.id,
                    exchange,
                    message: `openOrders source=${openOrdersSource} total=${exchangeOpenOrders.length} buy=${openBuys.length} sell=${openSells.length} unknown=${openUnknown.length} managedTotal=${managedOpenOrders.length} managedBuy=${managedOpenBuys.length} managedSell=${managedOpenSells.length} managedUnknown=${managedOpenUnknown.length} registryOpen=${localOpenRegistry.length}`,
                    throttleKey: `mmRunner:openOrders:${config.id}`,
                    throttleSec: 30,
                });

                // --- 2. CANCEL EXCESS/STALE ORDERS ---
                let totalCancelled = 0;
                let totalAlreadyClosed = 0;
                let totalCancelFailed = 0;
                const myOrderIdSet = managedOrderIdSet;

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
                                mmLog({
                                    level: "debug",
                                    configId: config.id,
                                    exchange,
                                    message: `OWN_ONLY fallback match dextrade id=${orderId} price=${o.price} qty=${o.quantity}`,
                                    throttleKey: `mmRunner:own-only:${config.id}`,
                                    throttleSec: 20,
                                });
                                return true;
                            }
                        }
                        return false;
                    });

                    if (myOrders.length === 0 && orders.length > 0) {
                        mmLog({
                            level: "info",
                            configId: config.id,
                            exchange,
                            message: `Skipping ${orders.length} orders (OWN_ONLY scope)`,
                            throttleKey: `mmRunner:own-only-skip:${config.id}`,
                            throttleSec: 30,
                        });
                        return;
                    }

                    for (const o of myOrders) {
                        const orderId = String(o.order_id || "");
                        if (exchange === "nestex" && !/^\d+$/.test(orderId)) {
                            mmLog({
                                level: "warn",
                                configId: config.id,
                                exchange,
                                message: `Skipping non-numeric NestEx order_id=${orderId}`,
                                throttleKey: `mmRunner:nonnumeric-order:${config.id}`,
                                throttleSec: 30,
                            });
                            continue;
                        }
                        let res: { ok: boolean; status?: number; error?: string; alreadyClosed?: boolean } = { ok: false };
                        if (exchange === "nonkyc") {
                            res = await cancelNonKycOrder(apiKey, apiSecret, o.order_id);
                        } else if (exchange === "dextrade") {
                            res = await cancelDexTradeOrder(apiKey, apiSecret, o.order_id, symbol);
                        } else if (exchange === "nestex") {
                            res = await cancelNestExOrder(apiKey, apiSecret, orderId, `USER:${config.tg_user_id}`);
                        }

                        if (res.ok && (res.alreadyClosed || isIdempotentCancelMessage(res.error))) {
                            totalAlreadyClosed++;
                            updateStrategyOrderStatusRegistry(exchange, orderId, "CLOSED");
                        } else if (res.ok) {
                            totalCancelled++;
                            updateStrategyOrderStatusRegistry(exchange, orderId, "CANCELLED");
                        } else if (isIdempotentCancelMessage(res.error)) {
                            totalAlreadyClosed++;
                            updateStrategyOrderStatusRegistry(exchange, orderId, "CLOSED");
                        } else {
                            totalCancelFailed++;
                            mmLog({
                                level: "warn",
                                configId: config.id,
                                exchange,
                                message: `cancel failed orderId=${orderId} error=${res.error || "unknown"}`,
                                throttleKey: `mmRunner:cancel-failed:${config.id}:${res.error || "unknown"}`,
                            });
                        }
                    }
                };

                if (inventoryBase !== (params.inventory_base ?? 0) || inventoryQuote !== (params.inventory_quote ?? quotePerOrder * 10)) {
                    updateStrategyParams(config.id, JSON.stringify({
                        ...params,
                        spread_pct: spreadPct,
                        quote_per_order: quotePerOrder,
                        order_quote: quotePerOrder, // Keep for backward compatibility
                        refresh_sec: refreshSec,
                        mid_source: effectiveMidSource === "exchange" ? "exchange" : "aggregated",
                        max_position_base: maxPositionBase,
                        inventory_base: inventoryBase,
                        inventory_quote: inventoryQuote,
                    }));
                }

                const lastRun = config.last_run_at || 0;
                if (lastRun > 0 && now - lastRun < refreshSec * 1000) {
                    return { success: true };
                }

                // Enforce orders_per_side only on managed orders.
                if (managedOpenBuys.length > ordersPerSide) {
                    const excess = managedOpenBuys.slice(0, managedOpenBuys.length - ordersPerSide);
                    await cancelOrders(excess);
                }
                if (managedOpenSells.length > ordersPerSide) {
                    const excess = managedOpenSells.slice(0, managedOpenSells.length - ordersPerSide);
                    await cancelOrders(excess);
                }

                const baseRules = await getMarketRules(exchange, symbol, quoteCcy);
                const sideSpread = spreadPct;

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
                const bookMid = hasBestBid && hasBestAsk
                    ? ((bestBid as number) + (bestAsk as number)) / 2
                    : null;
                let quoteMid = mid;
                let midAnchor = "source";
                if (bookMid && Number.isFinite(bookMid) && bookMid > 0) {
                    const deviation = Math.abs(mid - bookMid) / bookMid;
                    const clampThreshold = Math.max(spreadPct * 2, 0.03);
                    if (deviation > clampThreshold) {
                        quoteMid = bookMid;
                        midAnchor = "book_clamped";
                        mmLog({
                            level: "warn",
                            configId: config.id,
                            exchange,
                            message: `mid-clamp sourceMid=${mid} bookMid=${bookMid} deviationPct=${(deviation * 100).toFixed(2)} thresholdPct=${(clampThreshold * 100).toFixed(2)}`,
                            throttleKey: `mmRunner:mid-clamp:${config.id}`,
                            throttleSec: 20,
                        });
                    }
                }
                if (exchange === "dextrade" && Number.isFinite(mid) && mid > 0 && quoteMid > mid) {
                    quoteMid = mid;
                    midAnchor = `${midAnchor}+source_cap`;
                }

                const bias = computeInventoryBiasedQuotes({
                    quotePerOrder,
                    quoteFree: inventoryQuote,
                    baseFree: inventoryBase,
                    mid: midForBias,
                    minNotional: rules.minNotional,
                    quoteCcy: quoteCcy as "USDT" | "BNB",
                    k: 1.0,
                });
                const buyQuotePerOrder = exchange === "nestex" ? NESTEX_TARGET_NOTIONAL_USDT : bias.buyQuote;
                const sellQuotePerOrder = exchange === "nestex" ? NESTEX_TARGET_NOTIONAL_USDT : bias.sellQuote;

                let biasLogAt = Number(params.last_bias_log_at) || 0;
                if (!biasLogAt || now - biasLogAt >= BIAS_LOG_INTERVAL_MS) {
                    const ratioStr = bias.baseRatio !== null ? bias.baseRatio.toFixed(4) : "n/a";
                    const deltaStr = bias.delta !== null ? bias.delta.toFixed(4) : "n/a";
                    mmLog({
                        level: "info",
                        configId: config.id,
                        exchange,
                        message: `bias baseRatio=${ratioStr} delta=${deltaStr} buyQuote=${buyQuotePerOrder} sellQuote=${sellQuotePerOrder}`,
                        throttleKey: `mmRunner:bias:${config.id}`,
                        throttleSec: 600,
                    });
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
                    let workingQty = qty;
                    let workingNotional = notional;
                    const baseAsset = getBaseAsset(exchange, config.pair) || "BASE";
                    const quoteAsset = quoteCcy;
                    const minNotionalTarget = rules.minNotional > 0
                        ? (exchange === "nonkyc" ? rules.minNotional * 1.05 : rules.minNotional)
                        : 0;

                    if (exchange === "nestex") {
                        const minPrice = 1e-12;
                        const maxPrice = 0.01;
                        if (!Number.isFinite(price) || price <= 0 || price < minPrice || price > maxPrice) {
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "PRICE_SANITY_FAILED" });
                            recordSkip(`${side}: PRICE_SANITY_FAILED`);
                            return;
                        }
                        if (hasBestBid && hasBestAsk) {
                            const midCheck = Number.isFinite(midForBias) && midForBias > 0 ? midForBias : null;
                            if (midCheck) {
                                const spread = ((bestAsk as number) - (bestBid as number)) / midCheck;
                                if (!Number.isFinite(spread) || spread > 0.2) {
                                    orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "PRICE_SANITY_SPREAD" });
                                    recordSkip(`${side}: PRICE_SANITY_SPREAD`);
                                    return;
                                }
                            }
                        }
                    }

                    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(workingQty) || workingQty <= 0) {
                        orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "MIN_QTY" });
                        const msg = `${side}: MIN_QTY`;
                        recordSkip(msg);
                        return;
                    }
                    if (rules.minQty > 0 && workingQty < rules.minQty) {
                        orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "MIN_QTY" });
                        const msg = `${side}: MIN_QTY (have ${workingQty.toFixed(0)}, need >= ${rules.minQty.toFixed(0)})`;
                        recordSkip(msg);
                        return;
                    }

                    // Conservative uplift for edge-case rounding drift near min-notional threshold.
                    if (minNotionalTarget > 0 && workingNotional < minNotionalTarget) {
                        const shortfallRatio = (minNotionalTarget - workingNotional) / minNotionalTarget;
                        const upliftThreshold = exchange === "nonkyc" ? 0.1 : 0.02;
                        if (shortfallRatio > 0 && shortfallRatio <= upliftThreshold && rules.qtyStep > 0) {
                            const minQtyForNotional = ceilToStep(minNotionalTarget / price, rules.qtyStep);
                            if (Number.isFinite(minQtyForNotional) && minQtyForNotional > workingQty) {
                                const adjustedQty = Number(minQtyForNotional.toFixed(12));
                                const adjustedNotional = adjustedQty * price;
                                if (adjustedNotional >= minNotionalTarget) {
                                    workingQty = adjustedQty;
                                    workingNotional = adjustedNotional;
                                }
                            }
                        }
                    }
                    if (minNotionalTarget > 0 && workingNotional < minNotionalTarget) {
                        orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "MIN_NOTIONAL" });
                        const suggest = Math.max(rules.minNotional * 1.05, minNotionalTarget);
                        const msg = `${side}: MIN_NOTIONAL <${rules.minNotional.toFixed(4)} ${quoteAsset}; suggest >= ${suggest.toFixed(4)} ${quoteAsset}`;
                        recordSkip(msg);
                        return;
                    }

                    // Enhanced inventory checks
                    if (side === "BUY") {
                        if (inventoryQuote < workingNotional) {
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "NO_INVENTORY" });
                            const msg = `${side}: NO_INVENTORY (have ${inventoryQuote.toFixed(2)} ${quoteAsset}, need >= ${workingNotional.toFixed(2)} ${quoteAsset})`;
                            recordSkip(msg);
                            return;
                        }
                    }
                    if (side === "SELL") {
                        if (inventoryBase < workingQty) {
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "SKIP", reason: "NO_INVENTORY" });
                            const msg = `${side}: NO_INVENTORY (have ${inventoryBase.toFixed(0)} ${baseAsset}, need >= ${workingQty.toFixed(0)} ${baseAsset})`;
                            recordSkip(msg);
                            return;
                        }
                    }

                    mmLog({
                        level: "info",
                        configId: config.id,
                        exchange,
                        message: `placing side=${side} symbol=${symbol} qty=${workingQty} price=${price}`,
                        throttleKey: `mmRunner:placing:${config.id}:${side}`,
                        throttleSec: 10,
                    });

                    if (exchange === "nonkyc") {
                        const orderResult = await createNonKycOrder({
                            accessKey: apiKey,
                            secretKey: apiSecret,
                            symbol,
                            side: side.toLowerCase() as "buy" | "sell",
                            quantity: workingQty,
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
                                qty: workingQty,
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
                                qty: String(workingQty),
                                status: "OPEN",
                            });

                            actions.push(`${side}`);
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "PLACED", reason: note });
                        } else {
                            const errorCode = orderResult.reason || "ORDER_FAILED";
                            recordSkip(`${side}: ${errorCode}`);
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "FAILED", reason: errorCode });
                        }
                    } else if (exchange === "dextrade") {
                        const orderResult = await createDexTradeOrder({
                            loginToken: apiKey,
                            secret: apiSecret,
                            pair: symbol,
                            side,
                            tradeType: "LIMIT",
                            volume: workingQty,
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
                                qty: workingQty,
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
                                qty: String(workingQty),
                                status: "OPEN",
                            });

                            actions.push(`${side}`);
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "PLACED", reason: note });
                        } else {
                            recordSkip(`${side}: ORDER_FAILED`);
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "FAILED", reason: "ORDER_FAILED" });
                        }
                    } else if (exchange === "nestex") {
                        const orderResult = await placeNestExLimitOrder({
                            apiKey,
                            apiSecret,
                            cur: symbol,
                            side,
                            qty: workingQty,
                            price,
                            rateLimitKey: `USER:${config.tg_user_id}`,
                            pair: config.pair,
                            baseQty: workingQty,
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
                                qty: workingQty,
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
                                    qty: String(workingQty),
                                    status: "OPEN",
                                });
                            } else {
                                mmLog({
                                    level: "warn",
                                    configId: config.id,
                                    exchange,
                                    message: `nestex order placed but no exchangeOrderId clientOrderId=${clientOrderId}`,
                                    throttleKey: `mmRunner:nestex-no-orderid:${config.id}`,
                                    throttleSec: 30,
                                });
                            }

                            actions.push(`${side}`);
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "PLACED", reason: note });
                            mmLog({
                                level: "info",
                                configId: config.id,
                                exchange,
                                message: `nestex placed exchangeOrderId=${exchangeOrderId ?? "n/a"} clientOrderId=${clientOrderId}`,
                                throttleKey: `mmRunner:nestex-placed:${config.id}:${side}`,
                                throttleSec: 20,
                            });
                        } else {
                            const errorCode = orderResult.error || "ORDER_FAILED";
                            recordSkip(`${side}: ${errorCode}`);
                            orderTrace.push({ side, price, qty: workingQty, notional: workingNotional, status: "FAILED", reason: "ORDER_FAILED" });
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
                    recordSkip(`BUY: ${dextradeTopReason}`, { silent: true });
                    recordSkip(`SELL: ${dextradeTopReason}`, { silent: true });
                    allowBuy = false;
                    allowSell = false;
                } else {
                    if (allowBuy && !hasBestAsk) {
                        recordSkip("BUY: CROSSING_GUARD", { silent: true });
                        allowBuy = false;
                    }
                    if (allowSell && !hasBestBid) {
                        recordSkip("SELL: CROSSING_GUARD", { silent: true });
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
                    mmLog({
                        level: "debug",
                        configId: config.id,
                        exchange,
                        message: `nestex order decision allowBuy=${allowBuy} allowSell=${allowSell} buyReason=${buyReason} sellReason=${sellReason}`,
                        throttleKey: `mmRunner:nestex-order-decision:${config.id}`,
                        throttleSec: 20,
                    });
                }
                const buySlots = allowBuy ? Math.max(0, ordersPerSide - managedOpenBuys.length) : 0;
                const sellSlots = allowSell ? Math.max(0, ordersPerSide - managedOpenSells.length) : 0;
                mmLog({
                    level: "info",
                    configId: config.id,
                    exchange,
                    message: `decision mode=${mmMode} allowBuy=${allowBuy} allowSell=${allowSell} buySlots=${buySlots} sellSlots=${sellSlots} skipReasons=${skipReasons.join(" | ") || "NONE"}`,
                    throttleKey: `mmRunner:decision:${config.id}`,
                    throttleSec: 20,
                });

                const rawBidSample = floorToTick(normalizePrice(quoteMid * (1 - sideSpread)), rules.priceTick);
                const rawAskSample = ceilToTick(normalizePrice(quoteMid * (1 + sideSpread)), rules.priceTick);
                const tick = rules.priceTick;
                const sourceMidTick = roundToTick(normalizePrice(mid), tick);
                const hasSourceMidTick = Number.isFinite(sourceMidTick) && sourceMidTick > 0;
                const buySeenTickUnits = new Set<string>();
                const sellSeenTickUnits = new Set<string>();
                for (const o of managedOpenBuys) {
                    const openPrice = Number(o?.price);
                    if (Number.isFinite(openPrice) && openPrice > 0) {
                        buySeenTickUnits.add(toTickUnitKey(roundToTick(openPrice, tick), tick));
                    }
                }
                for (const o of managedOpenSells) {
                    const openPrice = Number(o?.price);
                    if (Number.isFinite(openPrice) && openPrice > 0) {
                        sellSeenTickUnits.add(toTickUnitKey(roundToTick(openPrice, tick), tick));
                    }
                }
                const buyRawLadder: number[] = [];
                const buyRoundedLadder: number[] = [];
                const buyFinalLadder: number[] = [];
                const sellRawLadder: number[] = [];
                const sellRoundedLadder: number[] = [];
                const sellFinalLadder: number[] = [];

                if (exchange === "nestex" && NESTEX_ORDER_DEBUG) {
                    const bb = Number.isFinite(bestBid as number) ? Number(bestBid) : null;
                    const ba = Number.isFinite(bestAsk as number) ? Number(bestAsk) : null;
                    mmLog({
                        level: "debug",
                        configId: config.id,
                        exchange,
                        message: `nestex quotes mid=${mid} bestBid=${bb} bestAsk=${ba} bidCalc=${rawBidSample} askCalc=${rawAskSample} spreadPct=${spreadPct}`,
                        throttleKey: `mmRunner:nestex-quotes:${config.id}`,
                        throttleSec: 20,
                    });
                }

                // BUY LADDER
                if (allowBuy) {
                    for (let i = 0; i < buySlots; i++) {
                        if (shouldAbort()) {
                            recordSkip("STOPPING", { silent: true });
                            break;
                        }
                        const tierSpread = sideSpread * (i + 1);
                        const rawInput = normalizePrice(quoteMid * (1 - tierSpread));
                        const rawPrice = floorToTick(rawInput, tick);
                        buyRawLadder.push(rawInput);
                        buyRoundedLadder.push(rawPrice);
                        const guard = applyCrossingGuard({
                            bid: rawPrice,
                            bestAsk,
                            bestBid,
                            tick,
                        });
                        if (guard.skipBuy) {
                            recordSkip("BUY: CROSSING_GUARD", { silent: true });
                            continue;
                        }
                        const deduped = moveOutwardByTick({
                            side: "BUY",
                            candidate: guard.bid ?? rawPrice,
                            tick,
                            seenUnits: buySeenTickUnits,
                            maxAttempts: Math.max(16, ordersPerSide * 8),
                        });
                        if (!Number.isFinite(deduped.price) || (deduped.price as number) <= 0) {
                            recordSkip("BUY: DUPLICATE_TICK_PRICE", { silent: true });
                            continue;
                        }
                        const price = deduped.price as number;
                        if (exchange === "dextrade" && hasSourceMidTick && price > sourceMidTick) {
                            recordSkip(`BUY: REF_MID_CAP (${price} > ${sourceMidTick})`, { silent: true });
                            continue;
                        }
                        if (hasBestAsk && price >= (bestAsk as number)) {
                            recordSkip(`BUY: HARD_NO_CROSSING (${price} >= ${bestAsk})`, { silent: true });
                            continue;
                        }
                        buyFinalLadder.push(price);
                        const targetNotional = exchange === "nestex" ? NESTEX_TARGET_NOTIONAL_USDT : buyQuotePerOrder;
                        const calculatedQty = targetNotional / price;
                        const qty = roundToStep(calculatedQty, rules.qtyStep);
                        const notional = qty * price;
                        if (exchange === "nestex") {
                            mmLog({
                                level: "info",
                                configId: config.id,
                                exchange,
                                message: `[NestEx sizing] side=BUY price=${price} targetNotional=1 calculatedQty=${calculatedQty} finalQtyAfterPrecision=${qty} notional=${notional}`,
                            });
                        }
                        await placeOrder("BUY", price, qty, notional, targetNotional, guard.adjustedBuy ? "ADJUSTED" : undefined);
                    }
                }

                // SELL LADDER
                if (allowSell) {
                    for (let i = 0; i < sellSlots; i++) {
                        if (shouldAbort()) {
                            recordSkip("STOPPING", { silent: true });
                            break;
                        }
                        const tierSpread = sideSpread * (i + 1);
                        const rawInput = normalizePrice(quoteMid * (1 + tierSpread));
                        const rawPrice = ceilToTick(rawInput, tick);
                        sellRawLadder.push(rawInput);
                        sellRoundedLadder.push(rawPrice);
                        const guard = applyCrossingGuard({
                            ask: rawPrice,
                            bestAsk,
                            bestBid,
                            tick,
                        });
                        if (guard.skipSell) {
                            recordSkip("SELL: CROSSING_GUARD", { silent: true });
                            continue;
                        }
                        const deduped = moveOutwardByTick({
                            side: "SELL",
                            candidate: guard.ask ?? rawPrice,
                            tick,
                            seenUnits: sellSeenTickUnits,
                            maxAttempts: Math.max(16, ordersPerSide * 8),
                        });
                        if (!Number.isFinite(deduped.price) || (deduped.price as number) <= 0) {
                            recordSkip("SELL: DUPLICATE_TICK_PRICE", { silent: true });
                            continue;
                        }
                        const price = deduped.price as number;
                        if (exchange === "dextrade" && hasSourceMidTick && price < sourceMidTick) {
                            recordSkip(`SELL: REF_MID_FLOOR (${price} < ${sourceMidTick})`, { silent: true });
                            continue;
                        }
                        if (hasBestBid && price <= (bestBid as number)) {
                            recordSkip(`SELL: HARD_NO_CROSSING (${price} <= ${bestBid})`, { silent: true });
                            continue;
                        }
                        sellFinalLadder.push(price);
                        const targetNotional = exchange === "nestex" ? NESTEX_TARGET_NOTIONAL_USDT : sellQuotePerOrder;
                        const calculatedQty = targetNotional / price;
                        const qty = roundToStep(calculatedQty, rules.qtyStep);
                        const notional = qty * price;
                        if (exchange === "nestex") {
                            mmLog({
                                level: "info",
                                configId: config.id,
                                exchange,
                                message: `[NestEx sizing] side=SELL price=${price} targetNotional=1 calculatedQty=${calculatedQty} finalQtyAfterPrecision=${qty} notional=${notional}`,
                            });
                        }
                        await placeOrder("SELL", price, qty, notional, targetNotional, guard.adjustedSell ? "ADJUSTED" : undefined);
                    }
                }

                if (buyRawLadder.length > 0 || sellRawLadder.length > 0) {
                    const fmt = (values: number[]) => values.map((v) => formatPriceByTick(v, tick)).join(",");
                    mmLog({
                        level: "debug",
                        configId: config.id,
                        exchange,
                        message: `ladder tick=${tick} buyRaw=[${fmt(buyRawLadder)}] buyRounded=[${fmt(buyRoundedLadder)}] buyFinal=[${fmt(buyFinalLadder)}] sellRaw=[${fmt(sellRawLadder)}] sellRounded=[${fmt(sellRoundedLadder)}] sellFinal=[${fmt(sellFinalLadder)}]`,
                        throttleKey: `mmRunner:ladder:${config.id}`,
                        throttleSec: 20,
                    });
                }

                if (exchange === "dextrade" && orderTrace.length === 0) {
                    const skipReason = skipReasons[0] || dextradeTopReason || "UNKNOWN";
                    const bb = Number.isFinite(bestBid as number) ? String(bestBid) : "n/a";
                    const ba = Number.isFinite(bestAsk as number) ? String(bestAsk) : "n/a";
                    mmLog({
                        level: "warn",
                        configId: config.id,
                        exchange,
                        message: `dextrade-skip pair=${config.pair} bestBid=${bb} bestAsk=${ba} mid=${mid} rawBid=${rawBidSample} rawAsk=${rawAskSample} tick=${rules.priceTick} skipReason=${skipReason}`,
                        throttleKey: `mmRunner:dextrade-skip:${config.id}:${skipReason}`,
                        throttleSec: 20,
                    });
                }

                const trace = {
                    runner: "mmRunner",
                    configId: config.id,
                    exchange,
                    pair: config.pair,
                    openOrdersSource,
                    midAnchor,
                    rules,
                    orders: orderTrace,
                    openOrders: exchangeOpenOrders.length,
                    placedBuy,
                    placedSell,
                    ordersPerSide,
                    quotePerOrder,
                    cancelledCount: totalCancelled,
                    alreadyClosedCount: totalAlreadyClosed,
                    cancelFailedCount: totalCancelFailed,
                };
                mmLog({
                    level: "debug",
                    configId: config.id,
                    exchange,
                    message: `trace ${JSON.stringify(trace)}`,
                    throttleKey: `mmRunner:trace:${config.id}`,
                    throttleSec: 20,
                });
                mmLog({
                    level: "info",
                    configId: config.id,
                    exchange,
                    message: `summary buyPlaced=${placedBuy} sellPlaced=${placedSell} orders_per_side=${ordersPerSide}`,
                    throttleKey: `mmRunner:summary:${config.id}`,
                    throttleSec: 20,
                });

                // Persist status tracking fields
                const estimatedOpenAfterTick = Math.max(
                    0,
                    exchangeOpenOrders.length - totalCancelled - totalAlreadyClosed
                ) + placedBuy + placedSell;
                const sideSkips = skipReasons.filter((reason) => reason.startsWith("BUY:") || reason.startsWith("SELL:"));
                const lastAction = actions.length > 0
                    ? `PLACED ${actions.join(",")}${sideSkips.length > 0 ? `; SKIP ${sideSkips.slice(0, 2).join(" | ")}` : ""}`
                    : (errors.length > 0 ? "SKIP" : (skipReasons.length > 0 ? `SKIP: ${skipReasons[0]}` : "OK"));
                updateStrategyParams(config.id, JSON.stringify({
                    ...params,
                    spread_pct: spreadPct,
                    quote_per_order: quotePerOrder,
                    orders_per_side: ordersPerSide,
                    // Keep order_quote for backward compatibility
                    order_quote: quotePerOrder,
                    refresh_sec: refreshSec,
                    mid_source: effectiveMidSource === "exchange" ? "exchange" : "aggregated",
                    max_position_base: maxPositionBase,
                    mode: mmMode,
                    min_base_inventory: minBaseInventory,
                    min_quote_inventory: minQuoteInventory,
                    inventory_base: inventoryBase,
                    inventory_quote: inventoryQuote,
                    last_action: lastAction,
                    last_action_at: now,
                    open_orders_count: estimatedOpenAfterTick,
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
                    const skipReason = skipReasons[0] || errors[0] || "unknown";
                    mmLog({
                        level: "warn",
                        configId: config.id,
                        exchange,
                        message: `SKIP reason=${skipReason}`,
                        throttleKey: `mmRunner:skip:${config.id}:${skipReason}`,
                        throttleSec: 20,
                    });
                    if (shouldRecordMmSkipAudit(config.id, skipReason, now)) {
                        insertTradeAudit({
                            ts: now,
                            strategyId: config.id,
                            strategyType: "MM",
                            exchange: config.exchange,
                            pair: config.pair,
                            action: "skip",
                            reason: skipReason,
                        });
                    }
                    insertStrategyEvent({
                        configId: config.id,
                        level: "WARN",
                        message: `MM SKIP: ${skipReason}`,
                    });
                    return {
                        success: false,
                        error: { message: `MM SKIP: ${skipReason}`, code: resolvedCode }
                    };
                }

                mmLog({
                    level: "debug",
                    configId: config.id,
                    exchange,
                    message: `refreshed exchange=${config.exchange} pair=${config.pair}`,
                    throttleKey: `mmRunner:refreshed:${config.id}`,
                    throttleSec: 20,
                });
                return { success: true };

            }, now);
        } finally {
            runningConfigs.delete(configId);
        }
    },
};
