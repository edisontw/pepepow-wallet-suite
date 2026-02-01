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
    getGridOrderByLevel,
} from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { createDexTradeOrder } from "../exchanges/dextrade.js";
import { createNonKycOrder, cancelNonKycOrder, getNonkycMarketRules, getNonKycOrderById, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { placeNestExLimitOrder } from "../exchanges/nestex.js";
import { ExchangeName, getBaseAsset, getExchangeSymbol, getQuoteUnit } from "../lib/markets.js";
import { getMinNotional, getPricePrecision, getQtyPrecision } from "../lib/exchanges.js";
import { fetchExchangePrice } from "./price.js";
import { StrategyRunner } from "./types.js";
import { wrapStrategyTick } from "../lib/runner-wrapper.js";
import { getNonKycNormalizedBalance } from "../lib/fundsCheck.js";

// Per-strategy lock to avoid overlapping ticks
const runningConfigs = new Set<number>();

const DEFAULT_REFRESH_SEC = 30;

type GridParams = {
    base_price?: number;
    grid_levels?: number;
    grid_step_pct?: number;
    total_quote_budget?: number;
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
                const symbol = getExchangeSymbol(exchange, config.pair) || config.pair;
                const quoteCcy = getQuoteUnit(exchange, config.pair) || "USDT";


                const params = safeParse(config.params_json);
                const hasBasePrice = !!(params.base_price && params.base_price > 0);
                console.log(`[grid] tick start strategyId=${config.id} hasBasePrice=${hasBasePrice} openOrders=${getOpenGridOrders(config.id).length}`);

                const skipReasons: string[] = [];


                const gridLevels = Math.max(1, Math.floor(params.grid_levels ?? 10));
                const stepPct = params.grid_step_pct ?? 0.01;
                const refreshSec = params.refresh_sec ?? DEFAULT_REFRESH_SEC;
                const allowSell = params.allow_sell ?? true;
                const totalBudget = params.total_quote_budget ?? 0;
                const perOrderQuote = params.per_order_quote ?? (totalBudget > 0 ? totalBudget / gridLevels : 1);

                if (!Number.isFinite(stepPct) || stepPct <= 0 || !Number.isFinite(perOrderQuote) || perOrderQuote <= 0) {
                    return {
                        success: false,
                        error: { message: "GRID params invalid: check step/budget." }
                    };
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
                let freeUSDT = 0;
                let freePEPEW = 0;

                if (exchange === "nonkyc") {
                    const balanceResult = await getNonKycNormalizedBalance(apiKey, apiSecret, false);
                    if (balanceResult) {
                        freeUSDT = balanceResult.data.freeUSDT;
                        freePEPEW = balanceResult.data.freePEPEW;
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
                }

                // --- 2. RECONCILE (DEDUPLICATE) ---
                // We use price_key (rounded price string) for unique level tracking
                const groups = new Map<string, typeof localOpenOrders>();
                for (const o of localOpenOrders) {
                    const key = `${o.side}|${o.price_key}`;
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key)!.push(o);
                }

                let cancelledDuplicates = 0;
                for (const [key, orders] of groups.entries()) {
                    if (orders.length > 1) {
                        // Keep the latest one, cancel others
                        const toKeep = orders[orders.length - 1];
                        const toCancel = orders.slice(0, -1);
                        for (const o of toCancel) {
                            console.log(`[gridRunner] config=${config.id} DEDUPE_CANCEL: ${key} id=${o.order_id}`);
                            if (config.trade_mode === "REAL" && exchange === "nonkyc") {
                                const cancelResult = await cancelNonKycOrder(apiKey, apiSecret, o.order_id);
                                if (cancelResult.ok || cancelResult.status === 404) {
                                    updateGridOrderStatus(o.order_id, "CANCELLED");
                                    updateStrategyOrderStatusRegistry(exchange, o.order_id, "CANCELLED");
                                    cancelledDuplicates++;
                                }
                            } else {
                                updateGridOrderStatus(o.order_id, "CANCELLED");
                                updateStrategyOrderStatusRegistry(exchange, o.order_id, "CANCELLED");
                                cancelledDuplicates++;
                            }
                        }
                        groups.set(key, [toKeep]);
                    }
                }

                // Refresh check
                const lastRun = config.last_run_at || 0;
                if (lastRun > 0 && now - lastRun < refreshSec * 1000 && cancelledDuplicates === 0 && localOpenOrders.length > 0) {
                    console.log(`[grid][return] reason=REFRESH_WAIT detail=elapsed=${now - lastRun}ms refreshSec=${refreshSec}`);
                    return { success: true };
                }


                // --- 3. TARGET GENERATION & GAP FILLING ---
                const targetLevels: Array<{ side: string; price: number; qty: number; priceKey: string }> = [];
                for (let level = 1; level <= gridLevels; level++) {
                    const bPriceRaw = normalizedBase * (1 - stepPct * level);
                    const bPrice = roundToTick(bPriceRaw, rules.priceTick);
                    const bPriceKey = bPrice.toFixed(8);

                    targetLevels.push({
                        side: "BUY",
                        price: bPrice,
                        qty: roundToStep(perOrderQuote / bPrice, rules.qtyStep),
                        priceKey: bPriceKey
                    });

                    if (allowSell) {
                        const sPriceRaw = normalizedBase * (1 + stepPct * level);
                        const sPrice = roundToTick(sPriceRaw, rules.priceTick);
                        const sPriceKey = sPrice.toFixed(8);

                        targetLevels.push({
                            side: "SELL",
                            price: sPrice,
                            qty: roundToStep(perOrderQuote / sPrice, rules.qtyStep),
                            priceKey: sPriceKey
                        });
                    }
                }

                const toCreate: typeof targetLevels = [];
                for (const t of targetLevels) {
                    const key = `${t.side}|${t.priceKey}`;
                    if (!groups.has(key)) toCreate.push(t);
                }

                // --- 4. LIMITS & FUND PROTECTION ---
                const currentBuyCount = Array.from(groups.values()).filter(g => g[0].side === "BUY").length;
                const currentSellCount = Array.from(groups.values()).filter(g => g[0].side === "SELL").length;

                const buyRoom = Math.max(0, gridLevels - currentBuyCount);
                const sellRoom = Math.max(0, gridLevels - currentSellCount);

                const finalToCreateBuy = toCreate.filter(o => o.side === "BUY").slice(0, buyRoom);
                const finalToCreateSell = toCreate.filter(o => o.side === "SELL").slice(0, sellRoom);
                const finalToCreate = [...finalToCreateBuy, ...finalToCreateSell];

                const totalNeededUSDT = finalToCreateBuy.reduce((sum, o) => sum + (o.qty * o.price), 0) * 1.05;
                const totalNeededPEPEW = finalToCreateSell.reduce((sum, o) => sum + o.qty, 0) * 1.05;

                if (exchange === "nonkyc") {
                    if (finalToCreateBuy.length > 0 && freeUSDT < totalNeededUSDT) {
                        const msg = `SKIP: Insufficient USDT (have ${freeUSDT.toFixed(2)}, need ${totalNeededUSDT.toFixed(2)})`;
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
                        skipReasons.push(`SKIP: Notional too small (${notional.toFixed(4)} < ${rules.minNotional})`);
                        continue;
                    }
                    if (rules.minQty > 0 && order.qty < rules.minQty) {
                        skipReasons.push(`SKIP: Qty too small (${order.qty.toExponential(2)} < ${rules.minQty})`);
                        continue;
                    }


                    // Final safety: check grid_order table again before placement
                    const existing = getGridOrderByLevel(config.id, order.side, order.priceKey);
                    if (existing) {
                        console.log(`[gridRunner] config=${config.id} level ${order.side}|${order.priceKey} already has OPEN order ${existing.order_id}, skipping.`);
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
                const allActiveOrderIds = [
                    ...localOpenOrders.map(o => o.order_id),
                    ...createdIds
                ];

                const finalOpenCount = currentBuyCount + currentSellCount + createdIds.length;
                const finalBuyCount = currentBuyCount + createdBuy;
                const finalSellCount = currentSellCount + createdSell;

                // Update cumulative counts
                params.total_placed = (params.total_placed || 0) + createdIds.length;
                params.total_cancelled = (params.total_cancelled || 0) + cancelledDuplicates;

                const actionSummary = `GRID: tracked=${finalOpenCount} (buy=${finalBuyCount} sell=${finalSellCount}) placed=${createdIds.length} cancelled=${cancelledDuplicates} (totalPlaced=${params.total_placed})`;

                updateStrategyParams(config.id, JSON.stringify({
                    ...params,
                    last_action: actionSummary,
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
                }
                return { success: true };
            }, now);
        } finally {
            runningConfigs.delete(configId);
        }
    },
};
