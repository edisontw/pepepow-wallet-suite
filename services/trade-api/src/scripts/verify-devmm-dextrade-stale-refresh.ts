import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

type ManagedOrder = {
    id: string;
    side: "BUY" | "SELL";
    price: number;
    quantity: number;
    filledQuantity: number;
    createdAt: number;
    status?: string;
};

const now = Date.UTC(2026, 2, 7, 12, 0, 0);
const rules = {
    minNotional: 5,
    minQty: 1,
    qtyStep: 1,
    priceTick: 1e-8,
};

async function buildQuotePlan(overrides?: Partial<{
    buyPrice: number;
    sellPrice: number;
    buyQty: number;
    sellQty: number;
    adjustedBuyNotional: number;
    adjustedSellNotional: number;
    priceTickUsed: number;
    forceSpreadMode: boolean;
    forceSpreadTicks: number;
    invalidQuotes: boolean;
    crossSelf: boolean;
}>): Promise<any> {
    const buyPrice = overrides?.buyPrice ?? 0.04998;
    const sellPrice = overrides?.sellPrice ?? 0.05052;
    const buyQty = overrides?.buyQty ?? 105;
    const sellQty = overrides?.sellQty ?? 103;
    return {
        quoteMid: 0.05,
        quoteAnchor: "TEST",
        buyPrice,
        sellPrice,
        buyQty,
        sellQty,
        adjustedBuyNotional: overrides?.adjustedBuyNotional ?? buyPrice * buyQty,
        adjustedSellNotional: overrides?.adjustedSellNotional ?? sellPrice * sellQty,
        priceTickUsed: overrides?.priceTickUsed ?? 1e-8,
        forceSpreadMode: overrides?.forceSpreadMode ?? false,
        forceSpreadTicks: overrides?.forceSpreadTicks ?? 1,
        invalidQuotes: overrides?.invalidQuotes ?? false,
        crossSelf: overrides?.crossSelf ?? false,
    };
}

type DevmmConfigShape = {
    id: number;
    exchange: "dextrade";
    symbol: string;
    min_notional_usdt: number;
    order_quote_usdt: number;
    buy_offset_pct: number;
    sell_offset_pct: number;
    refresh_seconds: number;
    refresh_jitter_seconds: number;
    cooldown_minutes: number;
    cap_ratio: number;
    cap_day_min_usdt: number;
    inventory_target_usdt_share: number;
    inventory_min_usdt_share: number;
    inventory_resume_usdt_share: number;
    inventory_max_usdt_share: number;
    trend_guard_pct: number;
    trend_pause_minutes: number;
    spread_min_pct: number;
    spread_max_pct: number;
    is_enabled: number;
    tg_user_id: string | null;
    created_at: number;
    updated_at: number;
};

function makeConfig(): DevmmConfigShape {
    return {
        id: 999,
        exchange: "dextrade",
        symbol: "PEPEW/USDT",
        min_notional_usdt: 5,
        order_quote_usdt: 5.25,
        buy_offset_pct: 0.02,
        sell_offset_pct: 0.01,
        refresh_seconds: 45,
        refresh_jitter_seconds: 0,
        cooldown_minutes: 0,
        cap_ratio: 0.1,
        cap_day_min_usdt: 10,
        inventory_target_usdt_share: 0.5,
        inventory_min_usdt_share: 0.1,
        inventory_resume_usdt_share: 0.2,
        inventory_max_usdt_share: 0.9,
        trend_guard_pct: 0.5,
        trend_pause_minutes: 5,
        spread_min_pct: 0.0001,
        spread_max_pct: 0.5,
        is_enabled: 1,
        tg_user_id: "test",
        created_at: now,
        updated_at: now,
    };
}

function countDecimals(value: number): number {
    const text = value.toString();
    const dot = text.indexOf(".");
    if (dot === -1) return 0;
    return text.slice(dot + 1).replace(/0+$/, "").length;
}

async function runCase(name: string, fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    try {
        const result = await fn();
        return { name, status: "PASS", ...result };
    } catch (error: any) {
        return { name, status: "FAIL", error: error?.message || String(error) };
    }
}

async function main(): Promise<void> {
    process.env.TRADE_DB_PATH = process.env.TRADE_DB_PATH || path.join(os.tmpdir(), "verify-devmm-dextrade-stale-refresh.db");
    process.env.KEYS_ENC_KEY =
        process.env.KEYS_ENC_KEY ||
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const { maybeRefreshDexTradeStaleOrder } = await import("../strategies/devmmRunner.js");
    const config = makeConfig();
    const cases = [];

    cases.push(await runCase("Case A", async () => {
        const logs: string[] = [];
        const order: ManagedOrder = {
            id: "A-1",
            side: "BUY",
            price: 0.05,
            quantity: 105,
            filledQuantity: 0,
            createdAt: now - 599_000,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "BUY",
                order,
                now,
                rules,
                rawOpenOrders: [order],
            },
            {
                cancelOrder: async () => ({ ok: true }),
                listOpenOrders: async () => ({ ok: true, orders: [order] }),
                getFreshOrderbook: async () => ({ bid: 0.049, ask: 0.051 }),
                placeOrder: async () => ({ ok: true, orderId: "A-new" }),
                buildQuotePlan: async () => buildQuotePlan(),
                log: (_level, message) => logs.push(message),
            }
        );
        assert.equal(result.outcome, "not_stale");
        assert.equal(result.reason, "age_below_threshold");
        assert.ok(logs.some((entry) => entry.includes("stale_check") && entry.includes("decision=no") && entry.includes("reason=age_below_threshold")));
        return {
            outcome: result.outcome,
            reason: result.reason,
            log: logs[0],
        };
    }));

    cases.push(await runCase("Case B", async () => {
        const logs: string[] = [];
        let trackedOrderId = "B-old";
        let cancelCalls = 0;
        let listCalls = 0;
        let placedPrice = 0;
        let placedQty = 0;
        const oldOrder: ManagedOrder = {
            id: "B-old",
            side: "BUY",
            price: 0.05,
            quantity: 105,
            filledQuantity: 0,
            createdAt: now - 601_000,
            status: "OPEN",
        };
        const newOrder: ManagedOrder = {
            id: "B-new",
            side: "BUY",
            price: 0.04998,
            quantity: 105,
            filledQuantity: 0,
            createdAt: now,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "BUY",
                order: oldOrder,
                now,
                rules,
                rawOpenOrders: [oldOrder],
            },
            {
                cancelOrder: async () => {
                    cancelCalls += 1;
                    return { ok: true };
                },
                listOpenOrders: async () => {
                    listCalls += 1;
                    if (listCalls === 1) {
                        return { ok: true, orders: [] };
                    }
                    return { ok: true, orders: [newOrder] };
                },
                getFreshOrderbook: async () => ({ bid: 0.04999, ask: 0.05001, status: "OK", bookSource: "orderbook" }),
                placeOrder: async (_side, price, qty) => {
                    placedPrice = price;
                    placedQty = qty;
                    trackedOrderId = "B-new";
                    return { ok: true, orderId: "B-new" };
                },
                buildQuotePlan: async () => buildQuotePlan({ buyPrice: 0.04998, buyQty: 105 }),
                onTrackedOrderChange: (_side, orderId) => {
                    trackedOrderId = orderId || "";
                },
                log: (_level, message) => logs.push(message),
            }
        );
        assert.equal(cancelCalls, 1);
        assert.equal(result.outcome, "repost_placed");
        assert.equal(result.newOrderId, "B-new");
        assert.equal(trackedOrderId, "B-new");
        assert.ok(placedPrice < 0.05001);
        assert.equal(countDecimals(placedPrice) <= 8, true);
        assert.equal(placedQty >= 100, true);
        assert.ok(logs.some((entry) => entry.includes("stale_cancel_confirmed")));
        assert.ok(logs.some((entry) => entry.includes("stale_repost_placed")));
        return {
            outcome: result.outcome,
            newOrderId: result.newOrderId,
            price: placedPrice,
            qty: placedQty,
            antiCross: placedPrice < 0.05001,
            priceDecimals: countDecimals(placedPrice),
        };
    }));

    cases.push(await runCase("Case C", async () => {
        let placeCalls = 0;
        const logs: string[] = [];
        const order: ManagedOrder = {
            id: "C-old",
            side: "SELL",
            price: 0.06,
            quantity: 90,
            filledQuantity: 0,
            createdAt: now - 601_000,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "SELL",
                order,
                now,
                rules,
                rawOpenOrders: [order],
            },
            {
                cancelOrder: async () => ({ ok: true }),
                listOpenOrders: async () => ({ ok: true, orders: [order] }),
                getFreshOrderbook: async () => ({ bid: 0.049, ask: 0.051 }),
                placeOrder: async () => {
                    placeCalls += 1;
                    return { ok: true, orderId: "C-new" };
                },
                buildQuotePlan: async () => buildQuotePlan(),
                log: (_level, message) => logs.push(message),
            }
        );
        assert.equal(result.outcome, "cancel_not_confirmed");
        assert.equal(placeCalls, 0);
        assert.ok(logs.some((entry) => entry.includes("stale_repost_skipped") && entry.includes("cancel_not_confirmed_still_live")));
        return {
            outcome: result.outcome,
            reason: result.reason,
            placeCalls,
        };
    }));

    cases.push(await runCase("Case D", async () => {
        let placeCalls = 0;
        const logs: string[] = [];
        const order: ManagedOrder = {
            id: "D-old",
            side: "BUY",
            price: 0.05,
            quantity: 100,
            filledQuantity: 99,
            createdAt: now - 601_000,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "BUY",
                order,
                now,
                rules,
                rawOpenOrders: [order],
            },
            {
                cancelOrder: async () => ({ ok: true }),
                listOpenOrders: async () => ({ ok: true, orders: [] }),
                getFreshOrderbook: async () => ({ bid: 0.04999, ask: 0.05001, status: "OK", bookSource: "orderbook" }),
                placeOrder: async () => {
                    placeCalls += 1;
                    return { ok: true, orderId: "D-new" };
                },
                buildQuotePlan: async () => buildQuotePlan({ buyPrice: 0.04998, buyQty: 105 }),
                log: (_level, message) => logs.push(message),
            }
        );
        assert.equal(result.outcome, "repost_skipped");
        assert.equal(result.reason, "min_notional_invalid");
        assert.equal(placeCalls, 0);
        assert.ok(logs.some((entry) => entry.includes("stale_repost_skipped") && entry.includes("min_notional_invalid")));
        return {
            outcome: result.outcome,
            reason: result.reason,
            placeCalls,
        };
    }));

    cases.push(await runCase("Case E", async () => {
        let strategyEnabled = true;
        let placeCalls = 0;
        const order: ManagedOrder = {
            id: "E-old",
            side: "BUY",
            price: 0.05,
            quantity: 105,
            filledQuantity: 0,
            createdAt: now - 601_000,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "BUY",
                order,
                now,
                rules,
                rawOpenOrders: [order],
            },
            {
                cancelOrder: async () => ({ ok: true }),
                listOpenOrders: async () => {
                    strategyEnabled = false;
                    return { ok: true, orders: [] };
                },
                getFreshOrderbook: async () => ({ bid: 0.04999, ask: 0.05001, status: "OK", bookSource: "orderbook" }),
                placeOrder: async () => {
                    placeCalls += 1;
                    return { ok: true, orderId: "E-new" };
                },
                buildQuotePlan: async () => buildQuotePlan({ buyPrice: 0.04998, buyQty: 105 }),
                isStrategyEnabled: () => strategyEnabled,
            }
        );
        assert.equal(result.outcome, "repost_skipped");
        assert.equal(result.reason, "strategy_disabled");
        assert.equal(placeCalls, 0);
        return {
            outcome: result.outcome,
            reason: result.reason,
            placeCalls,
        };
    }));

    cases.push(await runCase("Case F", async () => {
        let cancelCalls = 0;
        let placeCalls = 0;
        const order: ManagedOrder = {
            id: "F-reconciled",
            side: "BUY",
            price: 0.05,
            quantity: 105,
            filledQuantity: 0,
            createdAt: now - 30_000,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "BUY",
                order,
                now,
                rules,
                rawOpenOrders: [order],
            },
            {
                cancelOrder: async () => {
                    cancelCalls += 1;
                    return { ok: true };
                },
                listOpenOrders: async () => ({ ok: true, orders: [order] }),
                getFreshOrderbook: async () => ({ bid: 0.049, ask: 0.051 }),
                placeOrder: async () => {
                    placeCalls += 1;
                    return { ok: true, orderId: "F-new" };
                },
                buildQuotePlan: async () => buildQuotePlan(),
            }
        );

    cases.push(await runCase("AntiCross", async () => {
        const logs: string[] = [];
        const order: ManagedOrder = {
            id: "X-old",
            side: "BUY",
            price: 0.05,
            quantity: 105,
            filledQuantity: 0,
            createdAt: now - 601_000,
            status: "OPEN",
        };
        const result = await maybeRefreshDexTradeStaleOrder(
            {
                config,
                exchange: "dextrade",
                symbol: config.symbol,
                side: "BUY",
                order,
                now,
                rules,
                rawOpenOrders: [order],
            },
            {
                cancelOrder: async () => ({ ok: true }),
                listOpenOrders: async () => ({ ok: true, orders: [] }),
                getFreshOrderbook: async () => ({ bid: 0.05, ask: 0.05, status: "INVALID", bookSource: "orderbook" }),
                placeOrder: async () => ({ ok: true, orderId: "X-new" }),
                buildQuotePlan: async () => buildQuotePlan({ buyPrice: 0.05, sellPrice: 0.05, crossSelf: true }),
                log: (_level, message) => logs.push(message),
            }
        );
        assert.equal(result.outcome, "repost_skipped");
        assert.equal(result.reason, "anti_cross_self");
        assert.ok(logs.some((entry) => entry.includes("stale_repost_skipped") && entry.includes("anti_cross_self")));
        return {
            outcome: result.outcome,
            reason: result.reason,
            log: logs.find((entry) => entry.includes("stale_repost_skipped")),
        };
    }));
        assert.equal(result.outcome, "not_stale");
        assert.equal(cancelCalls, 0);
        assert.equal(placeCalls, 0);
        return {
            outcome: result.outcome,
            reason: result.reason,
            cancelCalls,
            placeCalls,
        };
    }));

    console.log("[verify-devmm-dextrade-stale-refresh] results");
    for (const entry of cases) {
        console.log(JSON.stringify(entry));
    }

    const failed = cases.filter((entry) => entry.status === "FAIL");
    if (failed.length > 0) {
        process.exitCode = 1;
        return;
    }
    console.log("[verify-devmm-dextrade-stale-refresh] PASS");
}

main().catch((error) => {
    console.error("[verify-devmm-dextrade-stale-refresh] FAIL", error);
    process.exit(1);
});
