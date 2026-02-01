import fetch from "node-fetch";
import {
    getStrategyConfigById,
    insertOrderLog,
    insertStrategyEvent,
    insertStrategyFill,
    insertStrategyOrder,
    insertStrategyOrderRegistry,
    updateStrategyLastRunAt,
    updateStrategyOrderStatus,
    updateStrategyOrderStatusRegistry,
    getExchangeKey,
    canPlaceOrder,
    setStrategyEnabledById,
    updateStrategyParams,
    getOpenStrategyOrders,
    getStrategyTotalSpend,
    getOpenStrategyOrdersRegistry,
} from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { createDexTradeOrder, listDexTradeOpenOrders, cancelDexTradeOrder } from "../exchanges/dextrade.js";
import { placeNestExLimitOrder } from "../exchanges/nestex.js";
import { createNonKycOrder, getNonkycMarketRules, listNonKycOpenOrders, normalizeNonKycSymbol, cancelNonKycOrder } from "../exchanges/nonkyc.js";
import { ExchangeName, getBaseAsset, getQuoteUnit, normalizePairSymbol } from "../lib/markets.js";
import { getMinNotional, roundQty } from "../lib/exchanges.js";
import { fetchExchangePrice } from "./price.js";
import { StrategyRunner } from "./types.js";
import { cancelOutstandingOrders } from "./strategyHelper.js";
import { wrapStrategyTick } from "../lib/runner-wrapper.js";

// Per-strategy mutex to prevent concurrent ticks
const tickLocks = new Map<number, boolean>();

// Default REAL mode safety limits
const DEFAULT_MAX_ORDERS_PER_HOUR = 20;
const DEFAULT_MAX_QUOTE_PER_DAY_BNB = 0.15;  // ~$90 at current prices
const DEFAULT_MAX_QUOTE_PER_DAY_USDT = 50;

const TELEGRAM_BOT_TOKEN = process.env.TRADE_BOT_TOKEN || process.env.BOT_TOKEN;

function parseDcaParams(paramsJson: string): {
    budget: number;
    intervalSec: number;
    quoteCcy: string;
    symbol?: string;
    maxTotalSpend?: number | null;
    endsAt?: number | null;
} {
    try {
        const parsed = JSON.parse(paramsJson) as {
            budget?: number;
            intervalSec?: number;
            quoteCcy?: string;
            symbol?: string;
            maxTotalSpend?: number | null;
            endsAt?: number | null;
        };
        return {
            budget: parsed.budget ?? 0,
            intervalSec: parsed.intervalSec ?? 0,
            quoteCcy: parsed.quoteCcy ?? "",
            symbol: parsed.symbol,
            maxTotalSpend: parsed.maxTotalSpend,
            endsAt: parsed.endsAt,
        };
    } catch {
        return { budget: 0, intervalSec: 0, quoteCcy: "", maxTotalSpend: null, endsAt: null };
    }
}

async function sendTelegramNotice(tgUserId: string, text: string): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn("[dcaRunner] Telegram notice skipped: missing TRADE_BOT_TOKEN/BOT_TOKEN");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: tgUserId, text }),
        });
    } catch (err: any) {
        console.warn(`[dcaRunner] Telegram notice failed: ${err?.message || err}`);
    }
}

/**
 * Robustly find open BUY orders belonging to this DCA strategy on the exchange.
 * Strategy is identified by clientOrderId prefix: PPW-DCA-{configId}-
 * Fallback to local registry if exchange doesn't support clientOrderId (e.g. DexTrade).
 */
async function getDCAOpenOrders(config: any, apiKey: string, apiSecret: string): Promise<any[]> {
    const symbol = config.pair;
    const normalizedSymbol = config.exchange === "nonkyc" ? normalizeNonKycSymbol(symbol) : symbol;
    const prefix = `PPW-DCA-${config.id}-`;
    const localOpen = getOpenStrategyOrdersRegistry(String(config.id));
    const localIds = new Set(localOpen.map(o => String(o.order_id)));

    try {
        if (config.exchange === "nonkyc") {
            const res = await listNonKycOpenOrders(apiKey, apiSecret, normalizedSymbol);
            if (res.ok && res.orders) {
                const filtered = res.orders.filter(o => {
                    const sideMatch = String(o.side || "").toLowerCase() === "buy";
                    const idMatch = o.order_id && localIds.has(String(o.order_id));
                    const prefixMatch = !!(o.userProvidedId?.startsWith(prefix));
                    return sideMatch && (idMatch || prefixMatch);
                });

                if (res.orders.length > 0 || localOpen.length > 0) {
                    console.log(`[dcaRunner] getDCAOpenOrders config=${config.id} exchangeCount=${res.orders.length} registryCount=${localOpen.length} matched=${filtered.length}`);
                    if (res.orders.length > 0 && filtered.length === 0) {
                        const first = res.orders[0];
                        console.log(`[dcaRunner] DEBUG: sample exOrder: id=${first.order_id} userProvidedId=${first.userProvidedId} side=${first.side} (prefix expected: ${prefix})`);
                    }
                }
                return filtered;
            } else if (res && !res.ok) {
                throw new Error(`NonKYC listOpenOrders failed: ${res.error}`);
            }
        } else if (config.exchange === "dextrade") {
            const exRes = await listDexTradeOpenOrders(apiKey, apiSecret, symbol);
            if (exRes.ok && exRes.data) {
                const exOrders = Array.isArray(exRes.data) ? exRes.data : (exRes.data.orders || exRes.data.data || []);
                const filtered = exOrders.filter((o: any) => {
                    const id = String(o.id || o.order_id);
                    const sideMatch = String(o.side || "").toUpperCase() === "BUY" || o.type === 0;
                    const idMatch = localIds.has(id);
                    const clientOrderId = String(o.client_order_id || o.userProvidedId || "");
                    const prefixMatch = clientOrderId.startsWith(prefix);
                    return sideMatch && (idMatch || prefixMatch);
                });
                if (exOrders.length > 0 || localOpen.length > 0) {
                    console.log(`[dcaRunner] getDCAOpenOrders config=${config.id} (DexTrade) exCount=${exOrders.length} registryCount=${localOpen.length} matched=${filtered.length}`);
                }
                return filtered;
            }
        } else {
            // Fallback for others: registry only
            return localOpen.filter(o => o.side.toUpperCase() === "BUY");
        }
    } catch (err) {
        console.warn(`[dcaRunner] getDCAOpenOrders failed for config=${config.id}:`, err);
    }

    return [];
}

export const dcaRunner: StrategyRunner = {
    type: "DCA",
    async tick(configId: number, now: number): Promise<void> {
        const config = getStrategyConfigById(configId);
        if (!config || config.strategy !== "DCA") return;

        if (!config.enabled) {
            console.log(`[dcaRunner] skip config=${configId}: strategy is disabled`);
            return;
        }

        // --- Mutex Lock ---
        if (tickLocks.get(configId)) {
            console.log(`[dcaRunner] DCA SKIP: LOCKED configId=${configId}`);
            return;
        }
        tickLocks.set(configId, true);

        try {
            await wrapStrategyTick(config, async () => {

                const params = parseDcaParams(config.params_json);
                const intervalSec = params.intervalSec || 600;
                const budget = params.budget || 0;
                const quoteCcy = params.quoteCcy || getQuoteUnit(config.exchange as ExchangeName, config.pair) || "";

                // 1. Check Duration Cap
                if (params.endsAt && now >= params.endsAt) {
                    const endsAtStr = new Date(params.endsAt).toISOString().replace("T", " ").slice(0, 16);
                    insertStrategyEvent({
                        configId: config.id,
                        level: "INFO",
                        message: `STOP: DURATION_ENDED (limit: ${endsAtStr})`,
                    });
                    setStrategyEnabledById(config.id, config.tg_user_id, false);
                    await cancelOutstandingOrders(config.id).catch(() => { });
                    return { success: true };
                }

                // 2. Check Budget Cap
                const spentTotal = getStrategyTotalSpend(config.id);
                if (params.maxTotalSpend && spentTotal + budget > params.maxTotalSpend) {
                    insertStrategyEvent({
                        configId: config.id,
                        level: "INFO",
                        message: `STOP: BUDGET_CAP_REACHED (spent: ${spentTotal.toFixed(2)} / max: ${params.maxTotalSpend})`,
                    });
                    setStrategyEnabledById(config.id, config.tg_user_id, false);
                    await cancelOutstandingOrders(config.id).catch(() => { });
                    return { success: true };
                }

                if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(intervalSec) || intervalSec <= 0) {
                    return {
                        success: false,
                        error: { message: "DCA params invalid: check budget/interval." }
                    };
                }

                const lastRun = config.last_run_at || 0;
                if (lastRun > 0 && now - lastRun < intervalSec * 1000) {
                    return { success: true }; // Skipped due to interval
                }

                const keyRecord = getExchangeKey(config.tg_user_id, config.exchange);
                if (!keyRecord) {
                    return {
                        success: false,
                        error: { message: "Missing API keys for REAL mode", code: "AUTH_FAILED" }
                    };
                }

                const { apiKey, apiSecret } = decryptKeyPair({
                    keyCipher: keyRecord.key_cipher,
                    secretCipher: keyRecord.secret_cipher,
                    iv: keyRecord.iv,
                    tag: keyRecord.tag,
                });

                // 3. Reliable Single Order Check & Cleanup (HARD RULE)
                // We ALWAYS cancel all open BUYs for this strategy before starting.
                const openDCABuysBefore = await getDCAOpenOrders(config, apiKey, apiSecret);
                if (openDCABuysBefore.length > 0) {
                    console.log(`[dca] tick strategyId=${config.id} hardRule=CANCEL_ALL count=${openDCABuysBefore.length}`);
                    for (const o of openDCABuysBefore) {
                        const orderId = o.order_id || o.id || o.exchange_order_id;
                        if (config.exchange === "nonkyc") {
                            await cancelNonKycOrder(apiKey, apiSecret, orderId).catch(() => { });
                        } else if (config.exchange === "dextrade") {
                            await cancelDexTradeOrder(apiKey, apiSecret, orderId).catch(() => { });
                        }
                    }
                    // Briefly wait after cancellation to let exchange state settle
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                const symbol = params.symbol || normalizePairSymbol(config.exchange as ExchangeName, config.pair) || config.pair;

                // REAL mode safety: rate limiting check
                const maxDaily = quoteCcy === "BNB" ? DEFAULT_MAX_QUOTE_PER_DAY_BNB : DEFAULT_MAX_QUOTE_PER_DAY_USDT;
                const rateCheck = canPlaceOrder(config.id, DEFAULT_MAX_ORDERS_PER_HOUR, maxDaily, budget);
                if (!rateCheck.allowed) {
                    return {
                        success: false,
                        error: { message: rateCheck.reason, httpStatus: 429 }
                    };
                }

                // --- Execute All-In Buy ---
                const executionResult = await executeDcaBuyAllIn({
                    config,
                    params,
                    apiKey,
                    apiSecret,
                    symbol,
                    budget,
                    quoteCcy,
                    now,
                });

                if (executionResult.success) {
                    updateStrategyLastRunAt(config.id, now);
                }

                return executionResult;
            }, now);
        } finally {
            tickLocks.delete(configId);
        }
    },
};

/**
 * Executes a "buy all-in" logic:
 * 1. For exchanges supporting MARKET order (DexTrade): Use MARKET.
 * 2. For others (NonKYC): Use an aggressive Sweep loop (placed at bestAsk + slippage, then immediate cancel).
 */
async function executeDcaBuyAllIn(opts: {
    config: any;
    params: any;
    apiKey: string,
    apiSecret: string,
    symbol: string,
    budget: number,
    quoteCcy: string,
    now: number,
}): Promise<{ success: boolean; error?: any }> {
    const { config, params, apiKey, apiSecret, symbol, budget, quoteCcy, now } = opts;

    // 1. Fetch current price
    let priceResult;
    try {
        priceResult = await fetchExchangePrice(config.exchange as ExchangeName, symbol);
    } catch (err: any) {
        return { success: false, error: { message: `Price fetch failed: ${err.message}`, code: err.code } };
    }

    if (!priceResult || !Number.isFinite(priceResult.price) || priceResult.price <= 0) {
        return { success: false, error: { message: "Price unavailable or invalid" } };
    }

    const currentPrice = priceResult.price;
    let totalFilledQuote = 0;
    let totalFilledQty = 0;
    let attemptsUsed = 0;
    let lastError: string | null = null;

    console.log(`[dca] executeAllIn config=${config.id} exchange=${config.exchange} budget=${budget} price=${currentPrice}`);

    // Option A: Market Order (DexTrade)
    if (config.exchange === "dextrade") {
        attemptsUsed = 1;
        const volumeBase = budget / currentPrice;
        const orderResult = await createDexTradeOrder({
            loginToken: apiKey,
            secret: apiSecret,
            pair: symbol,
            side: "BUY",
            tradeType: "MARKET",
            volume: volumeBase,
        });

        if (orderResult.ok) {
            // DexTrade MARKET orders fill immediately
            totalFilledQuote = budget;
            totalFilledQty = volumeBase;
            recordDcaExecution(config, budget, currentPrice, totalFilledQty, totalFilledQuote, "FILLED", orderResult.data, now);
            updateDcaStatusParams(config, params, totalFilledQuote, 0, attemptsUsed, "ALL_IN_MARKET", now);
            return { success: true };
        } else {
            return { success: false, error: { message: orderResult.error || "DexTrade MARKET failed", code: String(orderResult.code) } };
        }
    }

    // Option B: Sweep Loop (NonKYC / Fallback)
    const MAX_SWEEP_ATTEMPTS = 3;
    let remainingBudget = budget;

    for (let i = 0; i < MAX_SWEEP_ATTEMPTS; i++) {
        attemptsUsed++;
        if (remainingBudget < 0.01) break; // Small residual skip

        // Get fresh best price if possible, or use currentPrice
        const sweepPrice = currentPrice * 1.5; // Very aggressive sweep price
        const rawQty = remainingBudget / sweepPrice;
        const qty = roundQty(config.exchange as ExchangeName, rawQty);

        if (qty <= 0) break;

        const clientOrderId = `PPW-DCA-${config.id}-${Date.now()}-${attemptsUsed}`;
        console.log(`[dca] sweep attempt=${attemptsUsed} budget=${remainingBudget.toFixed(4)} price=${sweepPrice.toFixed(8)} qty=${qty}`);

        const orderResult = await createNonKycOrder({
            accessKey: apiKey,
            secretKey: apiSecret,
            symbol,
            side: "buy",
            quantity: qty,
            price: sweepPrice,
            orderType: "limit",
            userProvidedId: clientOrderId,
        });

        if (!orderResult.ok) {
            lastError = orderResult.error || "Order failed";
            console.warn(`[dca] sweep attempt ${attemptsUsed} failed: ${lastError}`);
            // If it's a critical error (funds, auth), stop sweep
            if (orderResult.reason === "MIN_NOTIONAL" || orderResult.reason === "AUTH_FAILED") break;
            continue;
        }

        const exchangeOrderId = String(orderResult.orderId || "");

        // Wait for fill (simulate IOC)
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 1. Cancel remaining
        await cancelNonKycOrder(apiKey, apiSecret, exchangeOrderId).catch(e => {
            console.warn(`[dca] sweep cancel failed for ${exchangeOrderId}: ${e.message}`);
            return { ok: false };
        });

        // 2. Determine filled amount
        const ordersRes = await listNonKycOpenOrders(apiKey, apiSecret, symbol).catch(() => ({ ok: false, orders: [] as any[] }));
        const stillOpen = (ordersRes.ok && ordersRes.orders) ? ordersRes.orders.find((o: any) => String(o.order_id) === exchangeOrderId) : null;

        let attemptFilledQty = 0;
        if (!stillOpen) {
            // If not found in open, it was either fully filled or cancelled.
            // Let's assume it filled if it's not in open.
            attemptFilledQty = qty;
        } else {
            // It's still open or partially filled
            attemptFilledQty = Number(stillOpen.filled_quantity || 0);
            // Cancel again just in case (already did above)
        }

        const attemptFilledQuote = attemptFilledQty * currentPrice;
        totalFilledQty += attemptFilledQty;
        totalFilledQuote += attemptFilledQuote;
        remainingBudget -= attemptFilledQuote;

        console.log(`[dca] sweep attempt ${attemptsUsed} results: filledQty=${attemptFilledQty} filledQuote=${attemptFilledQuote.toFixed(4)}`);

        if (remainingBudget < 0.01) break;
    }

    if (totalFilledQuote > 0) {
        recordDcaExecution(config, budget, currentPrice, totalFilledQty, totalFilledQuote, "FILLED", null, now);
        updateDcaStatusParams(config, params, totalFilledQuote, 0, attemptsUsed, "SWEEP_COMPLETE", now);
        return { success: true };
    }

    return {
        success: false,
        error: { message: lastError || "Sweep failed to fill any amount", attempts: attemptsUsed }
    };
}

function recordDcaExecution(config: any, budget: number, price: number, filledQty: number, filledQuote: number, status: string, exchangeData: any, now: number) {
    insertOrderLog(
        config.tg_user_id,
        config.exchange,
        config.pair,
        config.pair,
        "BUY",
        budget,
        price,
        config.trade_mode === "REAL" ? "REAL" : "PAPER",
        config.trade_mode,
        config.strategy,
        JSON.stringify({
            executedAt: now,
            price: price,
            filledQty,
            filledQuote,
            exchangeData,
        })
    );

    const order = insertStrategyOrder({
        configId: config.id,
        tgUserId: config.tg_user_id,
        exchange: config.exchange,
        pair: config.pair,
        strategy: config.strategy,
        tradeMode: config.trade_mode,
        side: "BUY",
        price: price,
        qty: filledQty,
        quoteQty: filledQuote,
        status: status,
    });

    if (filledQty > 0) {
        insertStrategyFill({
            orderId: order.id,
            configId: config.id,
            price: price,
            qty: filledQty,
        });
    }

    insertStrategyEvent({
        configId: config.id,
        level: "INFO",
        message: `DCA All-In: spent ${filledQuote.toFixed(4)} @ ${price} (attempts: ${status})`,
    });
}

function updateDcaStatusParams(config: any, params: any, filledQuote: number, openBuy: number, attempts: number, mode: string, now: number) {
    updateStrategyParams(config.id, JSON.stringify({
        ...params,
        last_action: `ALL_IN: spent ${filledQuote.toFixed(4)}`,
        last_action_at: now,
        lastFilledQuote: filledQuote,
        openBuy: openBuy,
        attemptsUsed: attempts,
        executionMode: mode,
    }));
}
