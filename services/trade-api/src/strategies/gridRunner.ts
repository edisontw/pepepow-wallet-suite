import {
    cancelOpenStrategyOrders,
    getStrategyConfigById,
    getExchangeKey,
    getOpenStrategyOrders,
    insertStrategyEvent,
    insertStrategyFill,
    insertStrategyOrder,
    insertStrategyOrderRegistry,
    updateStrategyLastRunAt,
    updateStrategyOrderStatus,
    updateStrategyOrderStatusRegistry,
    updateStrategyParams,
    insertGridOrder,
    getOpenGridOrders,
    updateGridOrderStatus,
} from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { createDexTradeOrder, cancelDexTradeOrder, listDexTradeOpenOrders } from "../exchanges/dextrade.js";
import { createNonKycOrder, cancelNonKycOrder, getNonkycMarketRules, getNonKycOrderById, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { placeNestExLimitOrder, cancelNestExOrder, listNestExOpenOrders } from "../exchanges/nestex.js";
import { ExchangeName, getBaseAsset, getExchangeSymbol, getQuoteUnit } from "../lib/markets.js";
import { getMinNotional, getPricePrecision, getQtyPrecision } from "../lib/exchanges.js";
import { fetchExchangePrice } from "./price.js";
import { StrategyRunner } from "./types.js";
import { wrapStrategyTick } from "../lib/runner-wrapper.js";
import { getExchangeNormalizedBalance } from "../lib/fundsCheck.js";
import { logStrategyTickContract } from "./logContract.js";

// Per-strategy lock to avoid overlapping ticks
const runningConfigs = new Set<number>();

const DEFAULT_REFRESH_SEC = 30;

type GridParams = {
    base_price?: number;
    grid_levels?: number;
    grid_step_pct?: number;
    total_quote_budget?: number;
    quote_per_order?: number;
    per_order_quote?: number;
    refresh_sec?: number;
    allow_sell?: boolean;
    inventory_base?: number;
    // Tracking fields for status display
    last_action?: string;
    last_action_at?: number;
    open_orders_count?: number;
    placed_buy?: number;
    placed_sell?: number;
    skip_reasons?: string[];
    last_order_ids?: string[];
    // Cumulative statistics
    total_placed?: number;
    total_cancelled?: number;
};

function safeParse(paramsJson: string): GridParams {
    try {
        return JSON.parse(paramsJson) as GridParams;
    } catch {
        return {};
    }
}

export function normalizePrice(value: number): number {
    if (!Number.isFinite(value)) return value;
    return Number(value.toPrecision(12));
}

export type MarketRules = {
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

export function roundToTick(value: number, tick: number): number {
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

function inferTickPrecision(tick: number): number {
    if (!Number.isFinite(tick) || tick <= 0) return 8;
    const text = tick.toString();
    if (text.includes("e-")) {
        const exp = Number(text.split("e-")[1]);
        if (Number.isFinite(exp) && exp >= 0) return exp;
    }
    const dot = text.indexOf(".");
    return dot >= 0 ? text.length - dot - 1 : 0;
}

function buildPriceKey(price: number, tick: number): string {
    const precision = Math.min(14, Math.max(8, inferTickPrecision(tick) + 2));
    return price.toFixed(precision);
}

function buildLegacyPriceKey(price: number): string {
    return price.toFixed(8);
}

function normalizeGridStepPct(raw: number): { stepPct: number; normalizedFromPercent: boolean } {
    if (!Number.isFinite(raw)) return { stepPct: raw, normalizedFromPercent: false };
    if (raw >= 1) {
        return { stepPct: raw / 100, normalizedFromPercent: true };
    }
    return { stepPct: raw, normalizedFromPercent: false };
}

export async function getMarketRules(exchange: ExchangeName, symbol: string, quoteCcy: string): Promise<MarketRules> {
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
    return {
        minNotional: getMinNotional(exchange, quoteCcy),
        minQty: step,
        qtyStep: step,
        priceTick: tick,
        source: "fallback",
    };
}

export const gridRunner: StrategyRunner = {
    type: "GRID",
    async tick(configId: number, now: number): Promise<void> {
        const config = getStrategyConfigById(configId);
        if (!config || config.strategy !== "GRID") return;

        if (runningConfigs.has(configId)) {
            console.log(`[gridRunner] skip config=${configId}: already running`);
            return;
        }
        runningConfigs.add(configId);

        try {
            if (!config.enabled) {
                console.log(`[gridRunner] skip config=${configId}: strategy is disabled`);
                return;
            }
            await wrapStrategyTick(config, async () => {
                const exchange = config.exchange as ExchangeName;
                const symbol = getExchangeSymbol(exchange, config.pair);
                const quoteCcy = getQuoteUnit(exchange, config.pair) || "USDT";


                const params = safeParse(config.params_json);
                const hasBasePrice = !!(params.base_price && params.base_price > 0);
                console.log(`[grid] tick start strategyId=${config.id} hasBasePrice=${hasBasePrice} openOrders=${getOpenGridOrders(config.id).length}`);

                const skipReasons: string[] = [];


                const gridLevels = Math.max(1, Math.floor(params.grid_levels ?? 10));
                const rawStepPct = params.grid_step_pct ?? 0.01;
                const normalizedStep = normalizeGridStepPct(rawStepPct);
                const stepPct = normalizedStep.stepPct;
                const refreshSec = params.refresh_sec ?? DEFAULT_REFRESH_SEC;
                const allowSell = params.allow_sell ?? true;
                const targetBuyLevels = gridLevels;
                const targetSellLevels = allowSell ? gridLevels : 0;
                const targetTotalLevels = targetBuyLevels + targetSellLevels;
                const totalBudget = params.total_quote_budget ?? 0;
                const perOrderQuote = params.quote_per_order || params.per_order_quote || (totalBudget > 0 ? totalBudget / Math.max(1, targetBuyLevels) : 1);

                if (!Number.isFinite(stepPct) || stepPct <= 0 || !Number.isFinite(perOrderQuote) || perOrderQuote <= 0) {
                    return {
                        success: false,
                        error: { message: "GRID params invalid: check step/budget." }
                    };
                }
                if (normalizedStep.normalizedFromPercent) {
                    console.warn(
                        `[gridRunner] strategy=${config.id} normalized grid_step_pct from ${rawStepPct} to ${stepPct} (percent->ratio)`
                    );
                    params.grid_step_pct = stepPct;
                }

                let priceResult;
                try {
                    priceResult = await fetchExchangePrice(config.exchange as ExchangeName, config.pair);
                } catch (err: any) {
                    return {
                        success: false,
                        error: { message: err.message || "Price fetch failed", code: err.code }
                    };
                }

                if (!priceResult || !Number.isFinite(priceResult.price) || priceResult.price <= 0) {
                    return {
                        success: false,
                        error: { message: "Price unavailable", code: "INVALID_MARKET" }
                    };
                }

                let apiKey = "";
                let apiSecret = "";
                const keyRecord = getExchangeKey(config.tg_user_id, config.exchange);
                if (!keyRecord) {
                    return { success: false, error: { message: "Missing API keys", code: "AUTH_FAILED" } };
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

                let basePrice = params.base_price ?? 0;
                if (!Number.isFinite(basePrice) || basePrice <= 0) {
                    basePrice = priceResult.price;
                    params.base_price = basePrice;
                    updateStrategyParams(config.id, JSON.stringify({
                        ...params,
                        base_price: basePrice,
                    }));
                    insertStrategyEvent({
                        configId: config.id,
                        level: "INFO",
                        message: `GRID base price initialized at ${basePrice}`,
                    });
                    // IMMEDIATELY update config with base_price and early return
                    params.base_price = basePrice;
                    updateStrategyParams(config.id, JSON.stringify(params));
                    console.log(`[grid][return] reason=BASE_PRICE_INIT detail=basePrice=${basePrice} strategyId=${config.id}`);
                    return { success: true };
                }



                const rules = await getMarketRules(exchange, symbol, quoteCcy);
                const normalizedBase = normalizePrice(basePrice);

                // --- 1. FETCH OPEN ORDERS (LOCAL ONLY) & BALANCES ---
                // --- 1. FETCH OPEN ORDERS & BALANCES ---
                let localOpenOrders = getOpenGridOrders(config.id);
                let freeQuote = 0;
                let freePEPEW = 0;
                let balanceTs: number | null = null;
                let balanceStalenessMs: number | null = null;

                if (exchange === "nonkyc") {
                    const balanceResult = await getExchangeNormalizedBalance("nonkyc", apiKey, apiSecret, quoteCcy as "USDT" | "BNB", true);
                    if (balanceResult) {
                        freeQuote = balanceResult.data.freeQuote;
                        freePEPEW = balanceResult.data.freePEPEW;
                        balanceTs = balanceResult.metadata.fetchedAt;
                        balanceStalenessMs = balanceResult.metadata.cacheAgeMs;
                    }

                    // SYNC WITH EXCHANGE to fix "phantom orders"
                    try {
                        const exchangeOrders = await listNonKycOpenOrders(apiKey, apiSecret, symbol);
                        if (exchangeOrders.ok && exchangeOrders.orders) {
                            const exchangeIds = exchangeOrders.orders.map(o => String(o.order_id));
                            let syncCount = 0;
                            for (const lo of localOpenOrders) {
                                if (!exchangeIds.includes(String(lo.order_id))) {
                                    // It's gone from exchange. Only sync if it's not brand new (propagation delay)
                                    if (now - lo.created_at > 10000) {
                                        updateGridOrderStatus(lo.order_id, "FILLED");
                                        updateStrategyOrderStatusRegistry(exchange, lo.order_id, "FILLED");
                                        syncCount++;
                                    }
                                }
                            }
                            if (syncCount > 0) {
                                console.log(`[gridRunner] config=${config.id} synced ${syncCount} phantom orders`);
                                localOpenOrders = getOpenGridOrders(config.id);
                            }
                        }
                    } catch (err) {
                        console.warn(`[gridRunner] config=${config.id} sync failed:`, err);
                    }
                } else if (exchange === "dextrade") {
                    const balanceResult = await getExchangeNormalizedBalance("dextrade", apiKey, apiSecret, quoteCcy as "USDT" | "BNB", true);
                    if (balanceResult) {
                        freeQuote = balanceResult.data.freeQuote || 0;
                        freePEPEW = balanceResult.data.freePEPEW || 0;
                        balanceTs = balanceResult.metadata.fetchedAt;
                        balanceStalenessMs = balanceResult.metadata.cacheAgeMs;
                    }

                    // SYNC WITH EXCHANGE to fix "phantom orders"
                    try {
                        const exchangeOrders = await listDexTradeOpenOrders(apiKey, apiSecret, symbol);
                        if (exchangeOrders.ok && exchangeOrders.orders) {
                            const exchangeIds = exchangeOrders.orders.map(o => String(o.order_id));
                            let syncCount = 0;
                            for (const lo of localOpenOrders) {
                                if (!exchangeIds.includes(String(lo.order_id))) {
                                    // It's gone from exchange. Only sync if it's not brand new (propagation delay)
                                    if (now - lo.created_at > 10000) {
                                        updateGridOrderStatus(lo.order_id, "FILLED");
                                        updateStrategyOrderStatusRegistry(exchange, lo.order_id, "FILLED");
                                        syncCount++;
                                    }
                                }
                            }
                            if (syncCount > 0) {
                                console.log(`[gridRunner] config=${config.id} synced ${syncCount} phantom orders (dextrade)`);
                                localOpenOrders = getOpenGridOrders(config.id);
                            }
                        }
                    } catch (err) {
                        console.warn(`[gridRunner] config=${config.id} sync failed (dextrade):`, err);
                    }
                } else if (exchange === "nestex") {
                    const balanceResult = await getExchangeNormalizedBalance("nestex", apiKey, apiSecret, quoteCcy as "USDT" | "BNB", true);
                    if (balanceResult) {
                        freeQuote = balanceResult.data.freeQuote || 0;
                        freePEPEW = balanceResult.data.freePEPEW || 0;
                        balanceTs = balanceResult.metadata.fetchedAt;
                        balanceStalenessMs = balanceResult.metadata.cacheAgeMs;
                    }

                    // SYNC WITH EXCHANGE to avoid stale local tracked orders.
                    try {
                        const exchangeOrders = await listNestExOpenOrders(
                            apiKey,
                            apiSecret,
                            config.pair,
                            `USER:${config.tg_user_id}`,
                            { exhaustive: true, includeNoCur: true }
                        );
                        if (exchangeOrders.ok && Array.isArray(exchangeOrders.orders)) {
                            const exchangeIds = exchangeOrders.orders.map((o: any) => String(o.order_id || o.id || ""));
                            let syncCount = 0;
                            for (const lo of localOpenOrders) {
                                if (!exchangeIds.includes(String(lo.order_id))) {
                                    // It's gone from exchange. Only sync if not brand new (propagation delay).
                                    if (now - lo.created_at > 10000) {
                                        updateGridOrderStatus(lo.order_id, "FILLED");
                                        updateStrategyOrderStatusRegistry(exchange, lo.order_id, "FILLED");
                                        syncCount++;
                                    }
                                }
                            }
                            if (syncCount > 0) {
                                console.log(`[gridRunner] config=${config.id} synced ${syncCount} phantom orders (nestex)`);
                                localOpenOrders = getOpenGridOrders(config.id);
                            }
                        }
                    } catch (err) {
                        console.warn(`[gridRunner] config=${config.id} sync failed (nestex):`, err);
                    }
                }

                logStrategyTickContract({
                    strategyId: config.id,
                    strategyType: "GRID",
                    requestedExchangeId: config.exchange,
                    canonicalPair: config.pair,
                    exchangeSymbol: symbol,
                    balanceTs,
                    balanceStalenessMs,
                    guards: skipReasons,
                });

                // --- 2. RECONCILE (DEDUPLICATE) ---
                // We use price_key (rounded price string) for unique level tracking
                const toTickUnit = (price: number): string => String(Math.round(price / rules.priceTick));
                const baseTickUnit = Math.round(normalizedBase / rules.priceTick);
                const buildGroups = (orders: typeof localOpenOrders): Map<string, typeof localOpenOrders> => {
                    const m = new Map<string, typeof localOpenOrders>();
                    for (const o of orders) {
                        const key = `${o.side}|${o.price_key}`;
                        if (!m.has(key)) m.set(key, []);
                        m.get(key)!.push(o);
                    }
                    return m;
                };
                const cancelOpenGridOrder = async (order: typeof localOpenOrders[number], reason: string): Promise<boolean> => {
                    console.log(`[gridRunner] config=${config.id} ${reason} id=${order.order_id} side=${order.side} priceKey=${order.price_key}`);
                    if (config.trade_mode === "REAL" && exchange === "nonkyc") {
                        const cancelResult = await cancelNonKycOrder(apiKey, apiSecret, order.order_id);
                        if (!(cancelResult.ok || cancelResult.status === 404)) return false;
                    } else if (config.trade_mode === "REAL" && exchange === "dextrade") {
                        const cancelResult = await cancelDexTradeOrder(apiKey, apiSecret, order.order_id, symbol);
                        if (!(cancelResult.ok || cancelResult.status === 404)) return false;
                    } else if (config.trade_mode === "REAL" && exchange === "nestex") {
                        const cancelResult = await cancelNestExOrder(apiKey, apiSecret, order.order_id, `USER:${config.tg_user_id}`);
                        if (!(cancelResult.ok || cancelResult.status === 404)) return false;
                    }
                    updateGridOrderStatus(order.order_id, "CANCELLED");
                    updateStrategyOrderStatusRegistry(exchange, order.order_id, "CANCELLED");
                    return true;
                };
                let groups = buildGroups(localOpenOrders);

                let cancelledDuplicates = 0;
                for (const [key, orders] of groups.entries()) {
                    if (orders.length > 1) {
                        // Keep the latest one, cancel others
                        const toKeep = orders[orders.length - 1];
                        const toCancel = orders.slice(0, -1);
                        for (const o of toCancel) {
                            const cancelled = await cancelOpenGridOrder(o, `DEDUPE_CANCEL key=${key}`);
                            if (cancelled) cancelledDuplicates++;
                        }
                        groups.set(key, [toKeep]);
                    }
                }
                if (cancelledDuplicates > 0) {
                    localOpenOrders = getOpenGridOrders(config.id);
                    groups = buildGroups(localOpenOrders);
                }

                // Cross-side collision cleanup (same tick has both BUY and SELL) to avoid self-trade loops.
                let cancelledCrossSide = 0;
                const byTick = new Map<string, typeof localOpenOrders>();
                for (const o of localOpenOrders) {
                    const px = Number(o.price_key);
                    if (!Number.isFinite(px) || px <= 0) continue;
                    const tickKey = toTickUnit(roundToTick(px, rules.priceTick));
                    if (!byTick.has(tickKey)) byTick.set(tickKey, []);
                    byTick.get(tickKey)!.push(o);
                }
                for (const [tickKey, orders] of byTick.entries()) {
                    const hasBuy = orders.some((o) => o.side === "BUY");
                    const hasSell = orders.some((o) => o.side === "SELL");
                    if (!hasBuy || !hasSell) continue;
                    const unit = Number(tickKey);
                    for (const o of orders) {
                        const cancelBuyAtOrAboveBase = o.side === "BUY" && Number.isFinite(unit) && unit >= baseTickUnit;
                        const cancelSellAtOrBelowBase = o.side === "SELL" && Number.isFinite(unit) && unit <= baseTickUnit;
                        const cancelAtCenterTick = Number.isFinite(unit) && unit === baseTickUnit;
                        if (!cancelBuyAtOrAboveBase && !cancelSellAtOrBelowBase && !cancelAtCenterTick) continue;
                        const cancelled = await cancelOpenGridOrder(o, `CROSS_SIDE_CANCEL tick=${tickKey}`);
                        if (cancelled) cancelledCrossSide++;
                    }
                }
                if (cancelledCrossSide > 0) {
                    localOpenOrders = getOpenGridOrders(config.id);
                    groups = buildGroups(localOpenOrders);
                }

                // Refresh check
                const lastRun = config.last_run_at || 0;
                const currentBuyCountForRefresh = Array.from(groups.values()).filter(g => g[0].side === "BUY").length;
                const currentSellCountForRefresh = Array.from(groups.values()).filter(g => g[0].side === "SELL").length;
                const meetsTargetOnRefresh =
                    currentBuyCountForRefresh >= targetBuyLevels &&
                    currentSellCountForRefresh >= targetSellLevels;
                if (
                    lastRun > 0 &&
                    now - lastRun < refreshSec * 1000 &&
                    cancelledDuplicates === 0 &&
                    cancelledCrossSide === 0 &&
                    localOpenOrders.length > 0 &&
                    meetsTargetOnRefresh
                ) {
                    console.log(`[grid][return] reason=REFRESH_WAIT detail=elapsed=${now - lastRun}ms refreshSec=${refreshSec}`);
                    return { success: true };
                }


                // --- 3. TARGET GENERATION & GAP FILLING ---
                const targetLevels: Array<{
                    side: "BUY" | "SELL";
                    level: number;
                    price: number;
                    qty: number;
                    priceKey: string;
                    legacyPriceKey: string;
                }> = [];
                const buyTickUnits = new Set<string>();
                const sellTickUnits = new Set<string>();
                const existingBuyTickUnits = new Set<string>();
                const existingSellTickUnits = new Set<string>();
                for (const o of localOpenOrders) {
                    const price = Number(o.price_key);
                    if (!Number.isFinite(price) || price <= 0) continue;
                    const unit = toTickUnit(roundToTick(price, rules.priceTick));
                    if (o.side === "BUY") existingBuyTickUnits.add(unit);
                    if (o.side === "SELL") existingSellTickUnits.add(unit);
                }

                for (let level = 1; level <= gridLevels; level++) {
                    // BUY side (base and below): enforce unique tick prices by nudging outward when needed.
                    const bPriceRaw = normalizedBase * (1 - stepPct * level);
                    let bPrice = floorToTick(bPriceRaw, rules.priceTick);
                    let buyNudge = 0;
                    while (Number.isFinite(bPrice) && bPrice > 0 && buyNudge < 128) {
                        const unit = toTickUnit(bPrice);
                        const needSeparation = Number(unit) >= baseTickUnit;
                        const collidesWithOwnBuy = buyTickUnits.has(unit) || existingBuyTickUnits.has(unit);
                        const collidesWithSell = sellTickUnits.has(unit) || existingSellTickUnits.has(unit);
                        if (!needSeparation && !collidesWithOwnBuy && !collidesWithSell) break;
                        bPrice = floorToTick(bPrice - rules.priceTick, rules.priceTick);
                        buyNudge += 1;
                    }
                    if (!Number.isFinite(bPrice) || bPrice <= 0) {
                        skipReasons.push(`SKIP: BUY level=${level} invalid price after tick dedupe`);
                    } else {
                        buyTickUnits.add(toTickUnit(bPrice));
                        targetLevels.push({
                            side: "BUY",
                            level,
                            price: bPrice,
                            qty: roundToStep(perOrderQuote / bPrice, rules.qtyStep),
                            priceKey: buildPriceKey(bPrice, rules.priceTick),
                            legacyPriceKey: buildLegacyPriceKey(bPrice),
                        });
                    }

                    if (allowSell) {
                        const sPriceRaw = normalizedBase * (1 + stepPct * level);
                        let sPrice = ceilToTick(sPriceRaw, rules.priceTick);
                        let sellNudge = 0;
                        while (Number.isFinite(sPrice) && sPrice > 0 && sellNudge < 128) {
                            const unit = toTickUnit(sPrice);
                            const needSeparation = Number(unit) <= baseTickUnit;
                            const collidesWithOwnSell = sellTickUnits.has(unit) || existingSellTickUnits.has(unit);
                            const collidesWithBuy = buyTickUnits.has(unit) || existingBuyTickUnits.has(unit);
                            if (!needSeparation && !collidesWithOwnSell && !collidesWithBuy) break;
                            sPrice = ceilToTick(sPrice + rules.priceTick, rules.priceTick);
                            sellNudge += 1;
                        }
                        if (!Number.isFinite(sPrice) || sPrice <= 0) {
                            skipReasons.push(`SKIP: SELL level=${level} invalid price after tick dedupe`);
                        } else {
                            sellTickUnits.add(toTickUnit(sPrice));
                            targetLevels.push({
                                side: "SELL",
                                level,
                                price: sPrice,
                                qty: roundToStep(perOrderQuote / sPrice, rules.qtyStep),
                                priceKey: buildPriceKey(sPrice, rules.priceTick),
                                legacyPriceKey: buildLegacyPriceKey(sPrice),
                            });
                        }
                    }
                }

                console.log(
                    `[gridRunner] strategy=${config.id} pair=${config.pair} levels=${gridLevels} targetBuy=${targetBuyLevels} targetSell=${targetSellLevels} targetTotal=${targetTotalLevels} stepPct=${stepPct} tick=${rules.priceTick} buyTargets=${targetLevels.filter(t => t.side === "BUY").length} sellTargets=${targetLevels.filter(t => t.side === "SELL").length}`
                );

                const toCreate: typeof targetLevels = [];
                for (const t of targetLevels) {
                    const key = `${t.side}|${t.priceKey}`;
                    const legacyKey = `${t.side}|${t.legacyPriceKey}`;
                    if (!groups.has(key) && !groups.has(legacyKey)) toCreate.push(t);
                }

                // --- 4. LIMITS & FUND PROTECTION ---
                const currentBuyCount = Array.from(groups.values()).filter(g => g[0].side === "BUY").length;
                const currentSellCount = Array.from(groups.values()).filter(g => g[0].side === "SELL").length;

                const buyRoom = Math.max(0, targetBuyLevels - currentBuyCount);
                const sellRoom = Math.max(0, targetSellLevels - currentSellCount);

                const finalToCreateBuy = toCreate.filter(o => o.side === "BUY").slice(0, buyRoom);
                const finalToCreateSell = toCreate.filter(o => o.side === "SELL").slice(0, sellRoom);
                const finalToCreate = [...finalToCreateBuy, ...finalToCreateSell];

                const totalNeededQuote = finalToCreateBuy.reduce((sum, o) => sum + (o.qty * o.price), 0) * 1.05;
                const totalNeededPEPEW = finalToCreateSell.reduce((sum, o) => sum + o.qty, 0) * 1.05;

                if (exchange === "nonkyc") {
                    if (finalToCreateBuy.length > 0 && freeQuote < totalNeededQuote) {
                        const msg = `SKIP: Insufficient ${quoteCcy} (have ${freeQuote.toFixed(quoteCcy === "BNB" ? 4 : 2)}, need ${totalNeededQuote.toFixed(quoteCcy === "BNB" ? 4 : 2)})`;
                        console.warn(`[gridRunner] config=${config.id} ${msg}`);
                        skipReasons.push(msg);
                        finalToCreate.splice(0, finalToCreate.length, ...finalToCreate.filter(o => o.side !== "BUY"));
                    }
                    if (finalToCreateSell.length > 0 && freePEPEW < totalNeededPEPEW) {
                        const msg = `SKIP: Insufficient PEPEW (have ${freePEPEW.toExponential(2)}, need ${totalNeededPEPEW.toExponential(2)})`;
                        console.warn(`[gridRunner] config=${config.id} ${msg}`);
                        skipReasons.push(msg);
                        finalToCreate.splice(0, finalToCreate.length, ...finalToCreate.filter(o => o.side !== "SELL"));
                    }
                }


                // --- 5. EXECUTION ---
                const createdIds: string[] = [];
                let createdBuy = 0;
                let createdSell = 0;
                for (const order of finalToCreate) {
                    const notional = order.qty * order.price;
                    if (rules.minNotional > 0 && notional < rules.minNotional) {
                        const suggest = (rules.minNotional * 1.05);
                        skipReasons.push(`SKIP: ${order.side} level=${order.level} MIN_NOTIONAL <${rules.minNotional.toFixed(4)} ${quoteCcy}; suggest >= ${suggest.toFixed(4)} ${quoteCcy}`);
                        continue;
                    }
                    if (rules.minQty > 0 && order.qty < rules.minQty) {
                        skipReasons.push(`SKIP: ${order.side} level=${order.level} QTY_TOO_SMALL (${order.qty.toExponential(2)} < ${rules.minQty})`);
                        continue;
                    }


                    // Final safety: check grid_order table again before placement
                    const groupKey = `${order.side}|${order.priceKey}`;
                    const legacyGroupKey = `${order.side}|${order.legacyPriceKey}`;
                    const existingOrders = groups.get(groupKey) || groups.get(legacyGroupKey) || [];
                    if (existingOrders.length > 0) {
                        const existingId = existingOrders[0]?.order_id || "unknown";
                        console.log(`[gridRunner] config=${config.id} level ${order.side}|${order.priceKey} already has OPEN order ${existingId}, skipping.`);
                        continue;
                    }

                    if (exchange === "nonkyc") {
                        // Use standardized prefix for fallback cancellation support: PPW-GRID-{id}-
                        const clientOrderId = `PPW-GRID-${config.id}-${order.side}-${order.priceKey}`;

                        const res = await createNonKycOrder({
                            accessKey: apiKey,
                            secretKey: apiSecret,
                            symbol,
                            side: order.side.toLowerCase() as "buy" | "sell",
                            quantity: order.qty,
                            price: order.price,
                            orderType: "limit",
                            userProvidedId: clientOrderId
                        });

                        if (res.ok && res.orderId) {
                            if (order.side === "BUY") createdBuy++;
                            else createdSell++;

                            // Track in grid_order table
                            insertGridOrder({
                                configId: config.id,
                                exchange: config.exchange,
                                pair: config.pair,
                                side: order.side,
                                priceKey: order.priceKey,
                                orderId: res.orderId,
                                status: "OPEN"
                            });

                            // Track in strategy_order registry for unified cancellation
                            insertStrategyOrderRegistry({
                                strategy_id: String(config.id),
                                exchange: config.exchange,
                                pair: config.pair,
                                order_id: res.orderId,
                                client_order_id: clientOrderId,
                                side: order.side,
                                price: String(order.price),
                                qty: String(order.qty),
                                status: "OPEN",
                            });

                            // Legacy log for UI history
                            insertStrategyOrder({
                                configId: config.id,
                                tgUserId: config.tg_user_id,
                                exchange: config.exchange,
                                pair: config.pair,
                                strategy: config.strategy,
                                tradeMode: config.trade_mode,
                                side: order.side,
                                price: order.price,
                                qty: order.qty,
                                quoteQty: notional,
                                status: "OPEN",
                                exchangeOrderId: res.orderId,
                                clientOrderId: clientOrderId
                            });

                            createdIds.push(res.orderId);
                        } else if (res.ok) {
                            console.warn(`[gridRunner] config=${config.id} order placed but no orderId returned!`);
                        } else if (res.error) {
                            // Log failures only if significant
                            console.warn(`[gridRunner] config=${config.id} ${order.side} failed: ${res.error}`);
                        }
                    } else if (exchange === "dextrade") {
                        const clientOrderId = `PPW-GRID-${config.id}-${order.side}-${order.priceKey}`;
                        const res = await createDexTradeOrder({
                            loginToken: apiKey,
                            secret: apiSecret,
                            pair: symbol,
                            side: order.side as "BUY" | "SELL",
                            tradeType: "LIMIT",
                            volume: order.qty,
                            rate: order.price,
                        });

                        if (res.ok) {
                            const exchangeOrderId = res.data?.data?.order_id ?? res.data?.data?.id ?? res.data?.order_id ?? res.data?.id ?? null;
                            if (order.side === "BUY") createdBuy++;
                            else createdSell++;

                            if (exchangeOrderId) {
                                insertGridOrder({
                                    configId: config.id,
                                    exchange: config.exchange,
                                    pair: config.pair,
                                    side: order.side,
                                    priceKey: order.priceKey,
                                    orderId: String(exchangeOrderId),
                                    status: "OPEN"
                                });

                                insertStrategyOrderRegistry({
                                    strategy_id: String(config.id),
                                    exchange: config.exchange,
                                    pair: config.pair,
                                    order_id: String(exchangeOrderId),
                                    client_order_id: clientOrderId,
                                    side: order.side,
                                    price: String(order.price),
                                    qty: String(order.qty),
                                    status: "OPEN",
                                });

                                insertStrategyOrder({
                                    configId: config.id,
                                    tgUserId: config.tg_user_id,
                                    exchange: config.exchange,
                                    pair: config.pair,
                                    strategy: config.strategy,
                                    tradeMode: config.trade_mode,
                                    side: order.side,
                                    price: order.price,
                                    qty: order.qty,
                                    quoteQty: notional,
                                    status: "OPEN",
                                    exchangeOrderId: String(exchangeOrderId),
                                    clientOrderId: clientOrderId
                                });

                                createdIds.push(String(exchangeOrderId));
                            } else {
                                console.warn(`[gridRunner] config=${config.id} dextrade order placed but no orderId returned!`);
                            }
                        } else if (res.error) {
                            console.warn(`[gridRunner] config=${config.id} ${order.side} failed (dextrade): ${res.error}`);
                        }
                    } else if (exchange === "nestex") {
                        const clientOrderId = `PPW-GRID-${config.id}-${order.side}-${order.priceKey}`;
                        const res = await placeNestExLimitOrder({
                            apiKey,
                            apiSecret,
                            cur: symbol,
                            side: order.side as "BUY" | "SELL",
                            qty: order.qty,
                            price: order.price,
                            rateLimitKey: `USER:${config.tg_user_id}`,
                        });

                        if (res.ok && res.orderId) {
                            if (order.side === "BUY") createdBuy++;
                            else createdSell++;

                            insertGridOrder({
                                configId: config.id,
                                exchange: config.exchange,
                                pair: config.pair,
                                side: order.side,
                                priceKey: order.priceKey,
                                orderId: String(res.orderId),
                                status: "OPEN"
                            });

                            insertStrategyOrderRegistry({
                                strategy_id: String(config.id),
                                exchange: config.exchange,
                                pair: config.pair,
                                order_id: String(res.orderId),
                                client_order_id: clientOrderId,
                                side: order.side,
                                price: String(order.price),
                                qty: String(order.qty),
                                status: "OPEN",
                            });

                            insertStrategyOrder({
                                configId: config.id,
                                tgUserId: config.tg_user_id,
                                exchange: config.exchange,
                                pair: config.pair,
                                strategy: config.strategy,
                                tradeMode: config.trade_mode,
                                side: order.side,
                                price: order.price,
                                qty: order.qty,
                                quoteQty: notional,
                                status: "OPEN",
                                exchangeOrderId: String(res.orderId),
                                clientOrderId: clientOrderId
                            });

                            createdIds.push(String(res.orderId));
                        } else if (res.ok) {
                            console.warn(`[gridRunner] config=${config.id} nestex order placed but no orderId returned!`);
                        } else if (res.error) {
                            console.warn(`[gridRunner] config=${config.id} ${order.side} failed (nestex): ${res.error}`);
                        }
                    }
                }

                // Summarized placement log as requested
                const registryWritten = createdIds.length;
                if (finalToCreate.length > 0) {
                    if (registryWritten < finalToCreate.length && createdIds.length > 0) {
                        const missing = finalToCreate.length - registryWritten;
                        console.error(`[grid][BUG] placed=${finalToCreate.length} registryWritten=${registryWritten} missing=${missing} strategy=${config.id} pair=${config.pair}`);
                    } else if (registryWritten > 0) {
                        console.log(`[grid] placed=${registryWritten} registryWritten=${registryWritten} pair=${config.pair} strategy=${config.id}`);
                    }
                }

                // Update tracked order IDs for reliable stopping
                const liveOpenOrders = getOpenGridOrders(config.id);
                const allActiveOrderIds = liveOpenOrders.map((o) => o.order_id);
                const finalBuyCount = liveOpenOrders.filter((o) => o.side === "BUY").length;
                const finalSellCount = liveOpenOrders.filter((o) => o.side === "SELL").length;
                const finalOpenCount = liveOpenOrders.length;

                // Update cumulative counts
                params.total_placed = (params.total_placed || 0) + createdIds.length;
                params.total_cancelled = (params.total_cancelled || 0) + cancelledDuplicates;

                const actionSummary =
                    `GRID: rule=BUY:${targetBuyLevels}+SELL:${targetSellLevels}(total=${targetTotalLevels}) ` +
                    `tracked=${finalOpenCount} (buy=${finalBuyCount} sell=${finalSellCount}) placed=${createdIds.length} cancelled=${cancelledDuplicates} (totalPlaced=${params.total_placed})`;
                const primarySkip = skipReasons[0];
                const lastAction = (createdIds.length === 0 && primarySkip)
                    ? (primarySkip.startsWith("SKIP:") ? primarySkip : `GRID SKIP: ${primarySkip}`)
                    : actionSummary;

                updateStrategyParams(config.id, JSON.stringify({
                    ...params,
                    last_action: lastAction,
                    last_action_at: now,
                    open_orders_count: finalOpenCount,
                    placed_buy: finalBuyCount,
                    placed_sell: finalSellCount,
                    last_order_ids: allActiveOrderIds,
                    skip_reasons: skipReasons.length > 0 ? skipReasons : params.skip_reasons,
                }));

                updateStrategyLastRunAt(config.id, now);

                if (createdIds.length > 0 || cancelledDuplicates > 0) {
                    insertStrategyEvent({
                        configId: config.id,
                        level: "INFO",
                        message: actionSummary,
                    });
                } else if (skipReasons.length > 0) {
                    console.warn(`[gridRunner] SKIP config=${config.id} exchange=${exchange} reason=${lastAction}`);
                    insertStrategyEvent({
                        configId: config.id,
                        level: "WARN",
                        message: lastAction,
                    });
                }
                return { success: true };
            }, now);
        } finally {
            runningConfigs.delete(configId);
        }
    },
};
