
import {
    getOpenStrategyOrdersRegistry,
    updateStrategyOrderStatusRegistry,
    cancelLocalStrategyOrdersRegistry,
    getStrategyConfigById,
    getExchangeKey
} from "../db.js";
import { cancelNonKycOrder, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { cancelDexTradeOrder, listDexTradeOpenOrders } from "../exchanges/dextrade.js";
import { cancelNestExOrder, listNestExOpenOrders } from "../exchanges/nestex.js";
import { decryptKeyPair } from "../crypto.js";
import { getExchangeSymbol } from "../lib/markets.js";

function isLikelyNestExOrderId(orderId: string): boolean {
    return /^\d+$/.test(orderId);
}

/**
 * Unified mechanism to cancel all open orders for a strategy.
 * 1. Checks the strategy_order registry for locally tracked OPEN orders.
 * 2. Attempts to cancel them on the exchange.
 * 3. Fallback: Lists open orders on exchange and filters by clientOrderId prefix.
 * 4. Updates DB status for all cancelled orders.
 */
export async function cancelOutstandingOrders(configId: number): Promise<{ cancelled: number; failed: number; total: number; alreadyClosed: number; remaining: number }> {
    const config = getStrategyConfigById(configId);
    if (!config) {
        throw new Error(`Strategy config ${configId} not found`);
    }

    const strategyId = String(configId);
    const exchange = config.exchange;
    const tgUserId = config.tg_user_id;

    if (exchange === "dextrade" || exchange === "dex-trade") {
        console.log(`[strategyHelper] Exchange ${exchange} is disabled. Bypassing remote cancel, marking local orders as CANCELLED.`);
        const localCount = cancelLocalStrategyOrdersRegistry(strategyId);
        return { cancelled: localCount, failed: 0, total: localCount, alreadyClosed: 0, remaining: 0 };
    }

    // Load API keys
    const keyRecord = getExchangeKey(tgUserId, exchange);
    if (!keyRecord) {
        console.warn(`[strategyHelper] No API keys for user ${tgUserId} on ${exchange}. Marking local orders as CANCELLED.`);
        const localCount = cancelLocalStrategyOrdersRegistry(strategyId);
        return { cancelled: localCount, failed: 0, total: localCount, alreadyClosed: 0, remaining: 0 };
    }

    const { apiKey, apiSecret } = decryptKeyPair({
        keyCipher: keyRecord.key_cipher,
        secretCipher: keyRecord.secret_cipher,
        iv: keyRecord.iv,
        tag: keyRecord.tag,
    });

    // 1. Get locally tracked open orders
    const localOpenOrders = getOpenStrategyOrdersRegistry(strategyId);
    const toCancelIds = new Set<string>();
    for (const o of localOpenOrders) {
        const orderId = String(o.order_id || "");
        if (!orderId) continue;
        if (exchange === "nestex" && !isLikelyNestExOrderId(orderId)) {
            console.warn(`[strategyHelper] Skipping non-numeric NestEx order_id in registry: ${orderId}`);
            continue;
        }
        toCancelIds.add(orderId);
    }

    // 2. Fallback: List open orders on exchange and filter by clientOrderId or price ladder if registry is incomplete
    if (exchange === "nonkyc") {
        try {
            const remoteOrders = await listNonKycOpenOrders(apiKey, apiSecret, config.pair);
            if (remoteOrders.ok && remoteOrders.orders) {
                const prefix = `PPW-${config.strategy}-${configId}-`;

                // For GRID fallback, we also prepare the price ladder to match orders by price
                let gridPriceLadder: Set<string> = new Set();
                if (config.strategy === "GRID") {
                    try {
                        const { getMarketRules, roundToTick, normalizePrice } = await import("./gridRunner.js");
                        const params = JSON.parse(config.params_json);
                        const basePrice = params.base_price || 0;
                        const gridLevels = Math.max(1, Math.floor(params.grid_levels || 10));
                        const rawStepPct = params.grid_step_pct || 0.01;
                        const stepPct = rawStepPct >= 1 ? rawStepPct / 100 : rawStepPct;

                        if (basePrice > 0) {
                            const symbol = config.pair; // simplified
                            const rules = await getMarketRules(exchange, symbol, "USDT");
                            const normalizedBase = normalizePrice(basePrice);
                            const toKey = (price: number): string => price.toFixed(14);

                            for (let i = 1; i <= gridLevels; i++) {
                                const buyPrice = roundToTick(normalizedBase * (1 - stepPct * i), rules.priceTick);
                                const sellPrice = roundToTick(normalizedBase * (1 + stepPct * i), rules.priceTick);
                                if (Number.isFinite(buyPrice) && buyPrice > 0) {
                                    gridPriceLadder.add(toKey(buyPrice));
                                }
                                if (Number.isFinite(sellPrice) && sellPrice > 0) {
                                    gridPriceLadder.add(toKey(sellPrice));
                                }
                            }
                        }
                    } catch (err) {
                        console.warn(`[strategyHelper] Failed to prepare GRID price ladder: ${err}`);
                    }
                }

                for (const ro of remoteOrders.orders) {
                    const orderId = String(ro.order_id);
                    if (toCancelIds.has(orderId)) continue;

                    // Match by clientOrderId prefix
                    if (ro.userProvidedId && ro.userProvidedId.startsWith(prefix)) {
                        toCancelIds.add(orderId);
                        continue;
                    }

                    // GRID specific fallback details
                    if (config.strategy === "GRID" && gridPriceLadder.size > 0) {
                        const orderPrice = Number(ro.price);
                        const orderPriceKey = orderPrice.toFixed(14);
                        const isMatchPrice = gridPriceLadder.has(orderPriceKey);

                        // Check if order was created after strategy start (allow 5 min buffer)
                        const startTime = config.created_at - (5 * 60 * 1000);
                        const orderTime = (ro.created_at || 0); // NonKycOpenOrder uses created_at as number
                        const isAfterStart = orderTime > startTime;

                        if (isMatchPrice && isAfterStart) {
                            console.log(`[strategyHelper] GRID fallback match: id=${orderId} price=${ro.price} userProvidedId=${ro.userProvidedId}`);
                            toCancelIds.add(orderId);
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`[strategyHelper] listOpenOrders fallback (nonkyc) failed: ${err}`);
        }
    } else if (exchange === "dextrade") {
        try {
            const remoteOrders = await listDexTradeOpenOrders(apiKey, apiSecret, config.pair);
            if (remoteOrders.ok && remoteOrders.orders) {
                // clientOrderId for MM: PPW-MM-ID-TS-RAND
                const mmPrefix = `PPW-MM-${configId}-`;
                // clientOrderId for GRID: PPW-GRID-ID-TS-RAND
                const gridPrefix = `PPW-GRID-${configId}-`;

                for (const ro of remoteOrders.orders) {
                    const orderId = String(ro.order_id);
                    if (toCancelIds.has(orderId)) continue;

                    // Match by registry is already handled above (toCancelIds from getOpenStrategyOrdersRegistry)

                    // Conservative matching fallback for Dex-Trade:
                    if (config.strategy === "MM" || config.strategy === "GRID") {
                        try {
                            const params = JSON.parse(config.params_json);
                            const orderPrice = Number(ro.price);
                            const orderQty = Number(ro.quantity);
                            const orderTime = Number(ro.created_at);

                            // 1. Time check
                            const startTime = config.created_at - (5 * 60 * 1000);
                            const isAfterStart = orderTime > startTime;

                            // 2. Sizing check
                            const quotePerOrder = params.quote_per_order ?? params.order_quote ?? 1;
                            // We don't have midPrice easily here without fetching, but we can check notional
                            const notional = orderPrice * orderQty;
                            const isNotionalClose = Math.abs(notional - quotePerOrder) / quotePerOrder < 0.3; // 30% tolerance

                            if (isAfterStart && isNotionalClose) {
                                console.log(`[strategyHelper] Dex-Trade fallback match: id=${orderId} price=${ro.price} qty=${ro.quantity}`);
                                toCancelIds.add(orderId);
                            }
                        } catch (err) {
                            // ignore parse errors
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`[strategyHelper] listOpenOrders fallback (dextrade) failed: ${err}`);
        }
    } else if (exchange === "nestex") {
        try {
            const symbol = getExchangeSymbol("nestex", config.pair);
            const remoteOrders = await listNestExOpenOrders(apiKey, apiSecret, symbol, `USER:${tgUserId}`);
            if (remoteOrders.ok && remoteOrders.orders) {
                for (const ro of remoteOrders.orders) {
                    const orderId = String(ro.order_id);
                    if (orderId) {
                        toCancelIds.add(orderId);
                    }
                }
            }
        } catch (err) {
            console.warn(`[strategyHelper] listOpenOrders fallback (nestex) failed: ${err}`);
        }
    }

    let cancelledCount = 0;
    let alreadyClosedCount = 0;
    let failedCount = 0;
    const totalToCancel = toCancelIds.size;

    for (const orderId of toCancelIds) {
        let status: "CANCELLED" | "ALREADY_CLOSED" | "FAILED" = "FAILED";
        if (exchange === "nonkyc") {
            const res = await cancelNonKycOrder(apiKey, apiSecret, orderId);
            if (res.ok) {
                status = "CANCELLED";
            } else if (res.status === 404 || (res.error && /not found|already.*closed|cancelled|canceled/i.test(res.error))) {
                status = "ALREADY_CLOSED";
            } else {
                console.warn(`[strategyHelper] Cancel order ${orderId} failed (nonkyc): ${res.error}`);
            }
        } else if (exchange === "dextrade") {
            const symbol = getExchangeSymbol("dextrade", config.pair);
            const res = await cancelDexTradeOrder(apiKey, apiSecret, orderId, symbol);
            if (res.ok) {
                status = "CANCELLED";
            } else if (res.status === 404 || (res.error && /not found|already.*closed/i.test(res.error))) {
                status = "ALREADY_CLOSED";
            } else {
                console.warn(`[strategyHelper] Cancel order ${orderId} failed (dextrade): ${res.error}`);
            }
        } else if (exchange === "nestex") {
            if (!isLikelyNestExOrderId(orderId)) {
                console.warn(`[strategyHelper] Skipping non-numeric NestEx order_id: ${orderId}`);
                status = "FAILED";
            } else {
                const res = await cancelNestExOrder(apiKey, apiSecret, orderId, `USER:${tgUserId}`);
                if (res.ok && res.alreadyClosed) {
                    status = "ALREADY_CLOSED";
                } else if (res.ok) {
                    status = "CANCELLED";
                } else if (res.status === 404 || (res.error && /not found|already.*closed/i.test(res.error))) {
                    status = "ALREADY_CLOSED";
                } else {
                    console.warn(`[strategyHelper] Cancel order ${orderId} failed (nestex): ${res.error}`);
                }
            }
        } else {
            console.warn(`[strategyHelper] Exchange ${exchange} not supported for unified cancel yet.`);
            status = "FAILED";
        }

        if (status === "CANCELLED") {
            updateStrategyOrderStatusRegistry(exchange, orderId, "CANCELLED");
            cancelledCount++;
        } else if (status === "ALREADY_CLOSED") {
            updateStrategyOrderStatusRegistry(exchange, orderId, "CLOSED");
            alreadyClosedCount++;
        } else {
            failedCount++;
        }
    }

    if (exchange === "nestex") {
        const hardResult = await hardCancelNestExOpenOrders({
            apiKey,
            apiSecret,
            pair: getExchangeSymbol("nestex", config.pair),
            rateLimitKey: `USER:${tgUserId}`,
            maxRetries: 3,
            delayMs: 1000,
        });
        console.log(`[stop cleanup] cancelled=${hardResult.cancelled} remaining=${hardResult.remaining} exchange=nestex config=${configId}`);
    }

    // Summarized stop log
    if (config.strategy === "GRID") {
        console.log(`[grid_stop] attempted=${totalToCancel} cancelled=${cancelledCount} alreadyClosed=${alreadyClosedCount} failed=${failedCount} strategy=${configId}`);
    }

    return {
        cancelled: cancelledCount,
        failed: failedCount,
        total: totalToCancel,
        alreadyClosed: alreadyClosedCount,
        remaining: totalToCancel - cancelledCount - alreadyClosedCount
    };
}

async function hardCancelNestExOpenOrders(params: {
    apiKey: string;
    apiSecret: string;
    pair: string;
    rateLimitKey: string;
    maxRetries: number;
    delayMs: number;
}): Promise<{ cancelled: number; remaining: number }> {
    let cancelled = 0;
    let remaining = 0;

    for (let attempt = 0; attempt < params.maxRetries; attempt++) {
        const open = await listNestExOpenOrders(params.apiKey, params.apiSecret, params.pair, params.rateLimitKey);
        if (!open.ok) {
            console.warn(`[strategyHelper] nestex hard cancel listOpenOrders failed: ${open.error}`);
            break;
        }

        const orders = open.orders || [];
        remaining = orders.length;
        if (remaining === 0) break;

        for (const order of orders) {
            const orderId = String(order.order_id || "");
            if (!orderId) continue;
            if (!isLikelyNestExOrderId(orderId)) {
                console.warn(`[strategyHelper] Skipping non-numeric NestEx order_id in open orders: ${orderId}`);
                continue;
            }
            const res = await cancelNestExOrder(params.apiKey, params.apiSecret, orderId, params.rateLimitKey);
            if (res.ok) {
                cancelled++;
                updateStrategyOrderStatusRegistry("nestex", orderId, "CANCELLED");
            }
        }

        await new Promise((resolve) => setTimeout(resolve, params.delayMs));
    }

    const finalOpen = await listNestExOpenOrders(params.apiKey, params.apiSecret, params.pair, params.rateLimitKey);
    remaining = finalOpen.ok ? (finalOpen.orders || []).length : remaining;
    return { cancelled, remaining };
}
