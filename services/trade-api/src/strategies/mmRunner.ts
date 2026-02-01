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
} from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { createDexTradeOrder } from "../exchanges/dextrade.js";
import { createNonKycOrder, cancelNonKycOrder, getNonkycMarketRules } from "../exchanges/nonkyc.js";
import { placeNestExLimitOrder } from "../exchanges/nestex.js";
import { ExchangeName, getBaseAsset, getExchangeSymbol, getQuoteUnit } from "../lib/markets.js";
import { getMinNotional, getPricePrecision, getQtyPrecision } from "../lib/exchanges.js";
import { fetchAggregatedPrice, fetchExchangePrice } from "./price.js";
import { StrategyRunner } from "./types.js";
import { wrapStrategyTick } from "../lib/runner-wrapper.js";
import { getNonKycNormalizedBalance } from "../lib/fundsCheck.js";

// Per-strategy lock to avoid overlapping ticks
const runningConfigs = new Set<number>();

const DEFAULT_REFRESH_SEC = 15;

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
    return {
        minNotional: getMinNotional(exchange, quoteCcy),
        minQty: step,
        qtyStep: step,
        priceTick: tick,
        source: "fallback",
    };
}

async function cancelExchangeOrders(exchange: ExchangeName, accessKey: string, secretKey: string, orderIds: string[]): Promise<{ ok: boolean; failed?: number }> {
    if (orderIds.length === 0) return { ok: true };
    if (exchange !== "nonkyc") {
        return { ok: false, failed: orderIds.length };
    }
    let failed = 0;
    for (const orderId of orderIds) {
        const result = await cancelNonKycOrder(accessKey, secretKey, orderId);
        if (!result.ok) {
            // Treat "not found" / "already closed" as success (idempotent cancel)
            const isIdempotentError =
                result.status === 404 ||
                result.reason === "ORDER_NOT_FOUND" ||
                (result.error && /not found|already.*closed|cancelled|canceled/i.test(result.error));

            if (isIdempotentError) {
                console.log(`[mmRunner] cancel orderId=${orderId} idempotent (already closed / not found)`);
            } else {
                failed += 1;
                console.warn(`[mmRunner] cancel orderId=${orderId} failed: ${result.error || result.reason || "unknown"}`);
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

        if (runningConfigs.has(configId)) {
            console.log(`[mmRunner] skip config=${configId}: already running`);
            return;
        }
        runningConfigs.add(configId);

        try {
            await wrapStrategyTick(config, async () => {
                const exchange = config.exchange as ExchangeName;
                const symbol = getExchangeSymbol(exchange, config.pair) || config.pair;
                const quoteCcy = getQuoteUnit(exchange, config.pair) || "USDT";


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

                // Tracking for status display
                let placedBuy = 0;
                let placedSell = 0;
                const skipReasons: string[] = [];
                let inventorySource = "REAL";

                // Log orders_per_side config
                console.log(`[mmRunner] config=${config.id} orders_per_side=${ordersPerSide} quote_per_order=${quotePerOrder}`);

                if (!Number.isFinite(spreadPct) || spreadPct <= 0 || !Number.isFinite(quotePerOrder) || quotePerOrder <= 0) {
                    return {
                        success: false,
                        error: { message: "MM params invalid: check spread/order size." }
                    };
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

                let apiKey = "";
                let apiSecret = "";
                if (config.trade_mode === "REAL") {
                    const keyRecord = getExchangeKey(config.tg_user_id, config.exchange);
                    if (!keyRecord) {
                        return { success: false, error: { message: "Missing API keys for REAL mode", code: "AUTH_FAILED" } };
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

                // Fetch actual balance from NonKYC to get real inventory
                if (exchange === "nonkyc") {
                    try {
                        const balanceResult = await getNonKycNormalizedBalance(apiKey, apiSecret, false);
                        if (balanceResult) {
                            inventoryBase = balanceResult.data.freePEPEW;
                            inventoryQuote = balanceResult.data.freeUSDT;
                            inventorySource = "NonKYC_API";
                            if (process.env.TRADE_DEBUG_STATUS === "1") {
                                console.log(`[mmRunner] REAL balance (getNonKycNormalizedBalance): freePEPEW=${inventoryBase.toExponential(2)} freeUSDT=${inventoryQuote.toFixed(4)} key=${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);
                            }
                        } else {
                            console.warn(`[mmRunner] REAL mode but balance fetch failed`);
                            inventorySource = "UNKNOWN_FALLBACK";
                        }
                    } catch (err: any) {
                        console.warn(`[mmRunner] balance fetch error: ${err?.message}`);
                    }
                }
                apiKey = apiKey; // Satisfy ts

                const openOrders = getOpenStrategyOrders(config.id);

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

                const rules = await getMarketRules(exchange, symbol, quoteCcy);
                const halfSpread = spreadPct / 2;
                const bidPriceRaw = normalizePrice(priceResult.price * (1 - halfSpread));
                const askPriceRaw = normalizePrice(priceResult.price * (1 + halfSpread));
                const bidPrice = roundToTick(bidPriceRaw, rules.priceTick);
                const askPrice = roundToTick(askPriceRaw, rules.priceTick);

                const bidQtyRaw = quotePerOrder / bidPrice;
                const askQtyRaw = quotePerOrder / askPrice;
                const bidQty = roundToStep(bidQtyRaw, rules.qtyStep);
                const askQty = roundToStep(askQtyRaw, rules.qtyStep);
                const bidNotional = bidQty * bidPrice;
                const askNotional = askQty * askPrice;

                const orderTrace: Array<{ side: string; price: number; qty: number; notional: number; status: string; reason?: string }> = [];

                if (openOrders.length > 0) {
                    const orderIds = openOrders.map((order) => order.exchange_order_id).filter((id): id is string => Boolean(id));
                    if (orderIds.length === 0) {
                        cancelOpenStrategyOrders(config.id);
                        insertStrategyEvent({
                            configId: config.id,
                            level: "WARN",
                            message: "MM NOTICE: cleared local open orders without exchange IDs",
                        });
                    } else {
                        const cancelResult = await cancelExchangeOrders(exchange, apiKey, apiSecret, orderIds);
                        if (orderIds.length > 0 && !cancelResult.ok) {
                            insertStrategyEvent({
                                configId: config.id,
                                level: "WARN",
                                message: `MM SKIP: open orders exist, cancel failed (${cancelResult.failed ?? 0})`,
                            });
                            return {
                                success: false,
                                error: { message: "Open orders exist; cancel failed", code: "OPEN_ORDERS" }
                            };
                        }
                        for (const order of openOrders) {
                            updateStrategyOrderStatus(order.id, "CANCELED");
                            // Update registry if exchange ID exists
                            if (order.exchange_order_id) {
                                updateStrategyOrderStatusRegistry(exchange, order.exchange_order_id, "CANCELLED");
                            }
                        }
                    }
                }


                const actions: string[] = [];
                const errors: string[] = [];

                const placeOrder = async (side: "BUY" | "SELL", price: number, qty: number, notional: number): Promise<void> => {
                    const baseAsset = getBaseAsset(exchange, config.pair) || "BASE";
                    const quoteAsset = quoteCcy;

                    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
                        orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "MIN_QTY" });
                        const msg = `${side}: MIN_QTY`;
                        errors.push(msg);
                        skipReasons.push(msg);
                        return;
                    }
                    if (rules.minQty > 0 && qty < rules.minQty) {
                        orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "MIN_QTY" });
                        const msg = `${side}: MIN_QTY (have ${qty.toFixed(0)}, need >= ${rules.minQty.toFixed(0)})`;
                        errors.push(msg);
                        skipReasons.push(msg);
                        return;
                    }
                    if (rules.minNotional > 0 && notional < rules.minNotional) {
                        orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "MIN_NOTIONAL" });
                        const msg = `${side}: MIN_NOTIONAL (have ${notional.toFixed(4)} ${quoteAsset}, need >= ${rules.minNotional.toFixed(4)})`;
                        errors.push(msg);
                        skipReasons.push(msg);
                        return;
                    }

                    // Enhanced inventory checks with detailed messages
                    if (side === "BUY") {
                        const neededQuote = Math.max(quotePerOrder, minQuoteInventory);
                        if (inventoryQuote < neededQuote) {
                            orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "NO_INVENTORY" });
                            const msg = `${side}: NO_INVENTORY (have ${inventoryQuote.toFixed(2)} ${quoteAsset}, need >= ${neededQuote.toFixed(2)} ${quoteAsset})`;
                            errors.push(msg);
                            skipReasons.push(msg);
                            return;
                        }
                    }
                    if (side === "SELL") {
                        const neededBase = Math.max(qty, minBaseInventory);
                        if (inventoryBase < neededBase) {
                            orderTrace.push({ side, price, qty, notional, status: "SKIP", reason: "NO_INVENTORY" });
                            const msg = `${side}: NO_INVENTORY (have ${inventoryBase.toFixed(0)} ${baseAsset}, need >= ${neededBase.toFixed(0)} ${baseAsset})`;
                            errors.push(msg);
                            skipReasons.push(msg);
                            return;
                        }
                    }


                    console.log(`[mmRunner] placing ${side} ${symbol} qty=${qty} price=${price}`);

                    // Final hard gate before exchange call
                    if (side === "BUY" && placedBuy >= ordersPerSide) {
                        console.log(`[mmRunner] HARD GATE skip BUY: placedBuy=${placedBuy} >= ordersPerSide=${ordersPerSide}`);
                        return;
                    }
                    if (side === "SELL" && placedSell >= ordersPerSide) {
                        console.log(`[mmRunner] HARD GATE skip SELL: placedSell=${placedSell} >= ordersPerSide=${ordersPerSide}`);
                        return;
                    }

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
                                quoteQty: quotePerOrder,
                                status: "OPEN",
                                exchangeOrderId,
                            });

                            // New unified registry
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
                            orderTrace.push({ side, price, qty, notional, status: "PLACED" });
                        } else {
                            const errorMsg = orderResult.error || orderResult.reason || "ORDER_FAILED";
                            const errorCode = orderResult.reason || "ORDER_FAILED";
                            console.warn(`[mmRunner] order failed ${side}: ${errorMsg}`);
                            errors.push(`${side}: ${errorCode}`);
                            // Only set as skip reason if it's a "meaningful" skip like MIN_NOTIONAL
                            if (errorCode !== "ORDER_FAILED") {
                                skipReasons.push(`${side}: ${errorCode}`);
                            }
                            orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: errorCode });
                        }
                        return;
                    }
                    if (exchange === "dextrade") {
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

                            const exchangeOrderId = orderResult.data?.order_id ?? orderResult.data?.id ?? null;
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
                                quoteQty: quotePerOrder,
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
                            orderTrace.push({ side, price, qty, notional, status: "PLACED" });
                        } else {
                            console.warn(`[mmRunner] order failed ${side}: ${orderResult.error || "unknown"}`);
                            errors.push(`${side}: ORDER_FAILED`);
                            orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: "ORDER_FAILED" });
                        }
                        return;
                    }
                    if (exchange === "nestex") {
                        const baseAsset = getBaseAsset(exchange, config.pair) || "PEPEW";
                        const orderResult = await placeNestExLimitOrder({
                            apiKey,
                            apiSecret,
                            cur: baseAsset,
                            side,
                            qty,
                            price,
                            rateLimitKey: `${config.tg_user_id}:nestex`,
                        });
                        if (orderResult.ok) {
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
                                quoteQty: quotePerOrder,
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
                            orderTrace.push({ side, price, qty, notional, status: "PLACED" });
                            if (side === "BUY") placedBuy++;
                            else placedSell++;
                        } else {
                            console.warn(`[mmRunner] order failed ${side}: ${orderResult.error || "unknown"}`);
                            const msg = `${side}: ORDER_FAILED`;
                            errors.push(msg);
                            skipReasons.push(msg);
                            orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: "ORDER_FAILED" });
                        }
                        return;
                    }
                    orderTrace.push({ side, price, qty, notional, status: "FAILED", reason: "ORDER_FAILED" });
                    errors.push(`${side}: ORDER_FAILED`);
                };

                // Place orders based on mode with multi-order laddering
                const shouldPlaceBuy = mmMode !== "ONE_SIDED_SELL";
                const shouldPlaceSell = mmMode !== "ONE_SIDED_BUY";

                // BUY LADDER
                if (shouldPlaceBuy && placedBuy < ordersPerSide) {
                    if (maxPositionBase > 0 && inventoryBase >= maxPositionBase) {
                        const msg = "BUY: MAX_POSITION";
                        errors.push(msg);
                        skipReasons.push(msg);
                    } else {
                        // Place multiple orders up to ordersPerSide
                        for (let i = 0; i < ordersPerSide; i++) {
                            if (placedBuy >= ordersPerSide) break;

                            // Each tier is further from mid: 1x, 2x, 3x halfSpread
                            const tierSpread = halfSpread * (i + 1);
                            const priceRaw = normalizePrice(priceResult.price * (1 - tierSpread));
                            const price = roundToTick(priceRaw, rules.priceTick);

                            const qtyRaw = quotePerOrder / price;
                            const qty = roundToStep(qtyRaw, rules.qtyStep);
                            const notional = qty * price;

                            await placeOrder("BUY", price, qty, notional);
                        }
                    }
                }

                // SELL LADDER
                if (shouldPlaceSell && placedSell < ordersPerSide) {
                    // Place multiple orders up to ordersPerSide
                    for (let i = 0; i < ordersPerSide; i++) {
                        if (placedSell >= ordersPerSide) break;

                        const tierSpread = halfSpread * (i + 1);
                        const priceRaw = normalizePrice(priceResult.price * (1 + tierSpread));
                        const price = roundToTick(priceRaw, rules.priceTick);

                        const qtyRaw = quotePerOrder / price;
                        const qty = roundToStep(qtyRaw, rules.qtyStep);
                        const notional = qty * price;

                        await placeOrder("SELL", price, qty, notional);
                    }
                }

                const trace = {
                    runner: "mmRunner",
                    configId: config.id,
                    exchange: config.exchange,
                    pair: config.pair,
                    symbol,
                    ts: now,
                    mid: priceResult.price,
                    bid: bidPrice,
                    ask: askPrice,
                    mode: mmMode,
                    rules,
                    orders: orderTrace,
                    openOrders: openOrders.length,
                    placedBuy,
                    placedSell,
                    ordersPerSide,
                    quotePerOrder,
                    inventorySource,
                };
                console.log(`[mmRunner] trace ${JSON.stringify(trace)}`);
                console.log(`[mmRunner] summary: config=${config.id} buyPlaced=${placedBuy} sellPlaced=${placedSell} orders_per_side=${ordersPerSide}`);

                // Persist status tracking fields
                const lastAction = actions.length > 0 ? `PLACED ${actions.join(",")}` : (errors.length > 0 ? "SKIP" : "OK");
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
                    open_orders_count: openOrders.length,
                    placed_buy: placedBuy,
                    placed_sell: placedSell,
                    skip_reasons: skipReasons.slice(0, 3) || [],
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
