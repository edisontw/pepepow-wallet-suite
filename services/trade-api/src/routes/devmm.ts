/**
 * DevMM API Routes
 * 
 * Endpoints for managing the Dev Fee Market Making strategy
 */

import { Router } from "express";
import { z } from "zod";
import {
    DevmmExchange,
    disableDevmmConfig,
    getDevmmConfig,
    getDevmmReport,
    getDevmmState,
    getExchangeKey,
    resetDevmmTurnover,
    setDevmmStatus,
    upsertDevmmConfig,
    upsertDevmmState,
    DEVMM_MIN_NOTIONAL,
} from "../db.js";
import db from "../db.js";
import {
    devmmRunner,
    getDevmmBootstrapSnapshot,
    getDevmmPendingCount,
    markDevmmBootstrapStarted,
    resetDevmmBootstrapState,
} from "../strategies/devmmRunner.js";
import { cancelNonKycOrder, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { cancelDexTradeOrder, listDexTradeOpenOrders } from "../exchanges/dextrade.js";
import { cancelNestExOrder, listNestExOpenOrders } from "../exchanges/nestex.js";
import { decryptKeyPair } from "../crypto.js";
import { getExchangeSpec, normalizeExchangeId } from "../registry/exchanges.js";
import { getLastBalanceMeta } from "../lib/balanceHelper.js";
import {
    DevmmPauseReason,
    extractIssueCodesFromText,
    mapPauseReasonToIssueCode,
} from "../strategies/devmmCodes.js";

const router = Router();

const DEVMM_EXCHANGE_ALIASES: Record<string, DevmmExchange> = {
    nonkyc: "nonkyc",
    dextrade: "dextrade",
    "dex-trade": "dextrade",
    nestex: "nestex",
};

function normalizeDevmmExchange(value: unknown): DevmmExchange | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return DEVMM_EXCHANGE_ALIASES[normalized] || null;
}

function splitDevmmError(error: string | null | undefined): { code: string | null; message: string | null } {
    if (!error) return { code: null, message: null };
    const trimmed = String(error).trim();
    if (!trimmed) return { code: null, message: null };
    const match = trimmed.match(/^([A-Z0-9_]+)\s*[:|-]\s*(.+)$/);
    if (match) {
        return { code: match[1], message: match[2] };
    }
    return { code: trimmed, message: trimmed };
}

function deriveDevmmIssueCode(pauseReason: string | null | undefined, lastDecision: string | null | undefined): string | null {
    const fromDecision = extractIssueCodesFromText(lastDecision);
    if (fromDecision.length > 0) return fromDecision.join("|");
    const fromPause = mapPauseReasonToIssueCode(pauseReason);
    if (fromPause) return fromPause;
    return null;
}

function getTaipeiBuckets(now = Date.now()): { day: string; hour: string } {
    const d = new Date(now + 8 * 60 * 60 * 1000);
    return {
        day: d.toISOString().slice(0, 10),
        hour: d.toISOString().slice(0, 13),
    };
}

const ExchangeSchema = z.preprocess(
    (value) => normalizeDevmmExchange(value),
    z.enum(["nonkyc", "dextrade", "nestex"])
);
const PeriodSchema = z.enum(["daily", "weekly", "monthly"]);

const StartSchema = z.object({
    exchange: ExchangeSchema,
    tgUserId: z.string().min(1).optional(),
    orderQuoteUsdt: z.number().positive().optional(),
    refreshSeconds: z.number().int().min(10).max(300).optional(),
    buyOffsetPct: z.number().min(0.001).max(0.1).optional(),
    sellOffsetPct: z.number().min(0.001).max(0.1).optional(),
});

const StopSchema = z.object({
    exchange: ExchangeSchema,
    tgUserId: z.string().min(1).optional(),
});

// Helper to get decrypted keys
async function getKeys(exchange: DevmmExchange, tgUserId?: string | null): Promise<{ accessKey: string; secretKey: string } | null> {
    // Use provided tgUserId, or look up from config
    let userId = tgUserId;
    if (!userId) {
        const config = getDevmmConfig(exchange);
        userId = config?.tg_user_id || process.env.DEVMM_TG_USER_ID || "devfee";
    }

    const keyRecord = getExchangeKey(userId, exchange);
    if (!keyRecord) return null;

    try {
        const decrypted = decryptKeyPair({
            keyCipher: keyRecord.key_cipher,
            secretCipher: keyRecord.secret_cipher,
            iv: keyRecord.iv,
            tag: keyRecord.tag,
        });
        return { accessKey: decrypted.apiKey, secretKey: decrypted.apiSecret };
    } catch {
        return null;
    }
}

// Cancel all open orders for DevMM on an exchange
async function cancelAllDevmmOrders(
    exchange: DevmmExchange,
    accessKey: string,
    secretKey: string,
    trackedOrderIds: string[] = []
): Promise<{ cancelled: number; failed: number }> {
    const rateLimitKey = `devmm:${exchange}`;
    let cancelled = 0;
    let failed = 0;
    const normalizeOrderId = (value: string | number | null | undefined): string => String(value ?? "").trim().replace(/\.0+$/, "");
    const isIdempotentCancelError = (error: string | null | undefined): boolean => {
        if (!error) return false;
        const text = String(error).toLowerCase();
        return text.includes("not found") || text.includes("not exist") || text.includes("already") || text.includes("closed") || text.includes("canceled") || text.includes("cancelled");
    };
    const isTargetNestExOrder = (order: any): boolean => {
        if (exchange !== "nestex") return true;
        const raw = order?.raw ?? order ?? {};
        const candidates = [
            raw?.cur,
            raw?.pair,
            raw?.symbol,
            raw?.market,
            raw?.coin,
            order?.cur,
            order?.pair,
            order?.symbol,
        ]
            .map((v) => String(v ?? "").trim().toUpperCase())
            .filter(Boolean);
        if (candidates.length === 0) return true;
        return candidates.some((v) => v === "PEPEW" || (v.includes("PEPEW") && v.includes("USDT")));
    };

    try {
        const orderIds = new Set<string>();
        const attemptedOrderIds = new Set<string>();

        if (exchange === "nonkyc") {
            const res = await listNonKycOpenOrders(accessKey, secretKey, "PEPEW_USDT");
            if (res.ok && Array.isArray(res.data)) {
                for (const o of res.data) {
                    const id = normalizeOrderId((o as any).id);
                    if (id) orderIds.add(id);
                }
            }
        } else if (exchange === "dextrade") {
            const res = await listDexTradeOpenOrders(accessKey, secretKey, "PEPEWUSDT");
            if (res.ok && Array.isArray(res.orders)) {
                for (const o of res.orders) {
                    const id = normalizeOrderId((o as any).id || (o as any).order_id);
                    if (id) orderIds.add(id);
                }
            }
        } else if (exchange === "nestex") {
            const res = await listNestExOpenOrders(accessKey, secretKey, "PEPEW/USDT", rateLimitKey, { exhaustive: true, includeNoCur: true });
            if (res.ok && Array.isArray(res.orders)) {
                for (const o of res.orders) {
                    if (!isTargetNestExOrder(o)) continue;
                    const id = normalizeOrderId((o as any).order_id || (o as any).id);
                    if (id) orderIds.add(id);
                }
            }
        }

        // Fallback when open-orders endpoint is unreliable: also cancel tracked IDs in devmm_state.
        for (const id of trackedOrderIds) {
            const normalized = normalizeOrderId(id);
            if (normalized) orderIds.add(normalized);
        }
        const state = getDevmmState(exchange, "PEPEW/USDT");
        if (state?.open_buy_order_id) orderIds.add(normalizeOrderId(state.open_buy_order_id));
        if (state?.open_sell_order_id) orderIds.add(normalizeOrderId(state.open_sell_order_id));

        const attemptCancel = async (orderId: string): Promise<void> => {
            if (!orderId || attemptedOrderIds.has(orderId)) return;
            attemptedOrderIds.add(orderId);
            try {
                let success = false;
                if (exchange === "nonkyc") {
                    const res = await cancelNonKycOrder(accessKey, secretKey, orderId);
                    success = res.ok;
                    if (!success && isIdempotentCancelError((res as any).error || (res as any).reason)) {
                        success = true;
                    }
                } else if (exchange === "dextrade") {
                    const res = await cancelDexTradeOrder(accessKey, secretKey, orderId, "PEPEWUSDT");
                    success = res.ok || isIdempotentCancelError(res.error || (res as any).reason);
                    if (!success) {
                        const fallbackRes = await cancelDexTradeOrder(accessKey, secretKey, orderId);
                        success = fallbackRes.ok || isIdempotentCancelError(fallbackRes.error || (fallbackRes as any).reason);
                    }
                } else if (exchange === "nestex") {
                    const res = await cancelNestExOrder(accessKey, secretKey, orderId, rateLimitKey);
                    success = res.ok || isIdempotentCancelError(res.error || (res as any).reason);
                }

                if (success) {
                    cancelled++;
                } else {
                    failed++;
                }
            } catch (err: any) {
                if (isIdempotentCancelError(err?.message || "")) {
                    cancelled++;
                    return;
                }
                failed++;
            }
        };

        for (const orderId of orderIds) {
            await attemptCancel(orderId);
        }

        // NestEx open-orders visibility can lag/be partial; do a few extra sweeps and cancel newly discovered IDs.
        if (exchange === "nestex") {
            for (let round = 0; round < 3; round++) {
                const sweep = await listNestExOpenOrders(accessKey, secretKey, "PEPEW/USDT", rateLimitKey, { exhaustive: true, includeNoCur: true });
                if (!sweep.ok || !Array.isArray(sweep.orders)) {
                    break;
                }
                const newIds = sweep.orders
                    .filter((o: any) => isTargetNestExOrder(o))
                    .map((o: any) => normalizeOrderId((o as any).order_id || (o as any).id))
                    .filter((id: string) => !!id && !attemptedOrderIds.has(id));
                if (newIds.length === 0) break;
                for (const id of newIds) {
                    await attemptCancel(id);
                }
            }
        }
    } catch (err) {
        console.error(`[devmmApi] Failed to cancel orders: ${err}`);
    }

    return { cancelled, failed };
}

// POST /v1/devmm/start
router.post("/v1/devmm/start", async (req, res) => {
    try {
        const parsed = StartSchema.parse(req.body);
        const exchange = parsed.exchange as DevmmExchange;
        const tgUserId = parsed.tgUserId || process.env.DEVMM_TG_USER_ID || "devfee";

        console.log(`[devmmApi] start requested exchange=${exchange}`);

        // Check API keys exist
        const keys = await getKeys(exchange, tgUserId);
        if (!keys) {
            return res.status(400).json({
                ok: false,
                error: "MISSING_KEYS",
                message: `No API keys found for user ${tgUserId} on exchange ${exchange}. Use /keys to set them first.`,
            });
        }

        // Auto-adjust orderQuoteUsdt if below minNotional
        let orderQuote = parsed.orderQuoteUsdt ?? DEVMM_MIN_NOTIONAL[exchange] * 1.05;
        if (orderQuote < DEVMM_MIN_NOTIONAL[exchange]) {
            orderQuote = DEVMM_MIN_NOTIONAL[exchange] * 1.05;
        }

        const symbol = "PEPEW/USDT";
        console.log(`[devmm:start] exchange=${exchange}, symbol=${symbol}, params=`, parsed);

        // Create or update config with tgUserId
        const config = upsertDevmmConfig({
            exchange,
            symbol,
            tgUserId,
            orderQuoteUsdt: orderQuote,
            buyOffsetPct: parsed.buyOffsetPct,
            sellOffsetPct: parsed.sellOffsetPct,
            refreshSeconds: parsed.refreshSeconds,
        });

        const startedAt = Date.now();
        // Initialize state
        upsertDevmmState(exchange, symbol, {
            status: "ACTIVE",
            pause_reason: null,
            last_action: "started",
            last_action_at: startedAt,
        });
        markDevmmBootstrapStarted(exchange, symbol, startedAt);

        const persistedRow = getDevmmConfig(exchange, symbol);
        console.log(`[devmm:start] persisted row: id=${persistedRow?.id}, exchange=${persistedRow?.exchange}, symbol=${persistedRow?.symbol}, is_enabled=${persistedRow?.is_enabled}`);

        console.log(`[devmmApi] Started on ${exchange} with order_quote=${orderQuote.toFixed(4)} USDT`);

        console.log(`[devmmRunner] starting id=${config.id} exchange=${exchange}`);
        try {
            await devmmRunner.tick(config.id, Date.now());
        } catch (err: any) {
            console.error(`[devmmRunner] start tick failed: ${err?.message || err}`);
        }

        res.json({
            ok: true,
            message: `DevMM started on ${exchange}`,
            config: {
                exchange: config.exchange,
                symbol: config.symbol,
                orderQuoteUsdt: config.order_quote_usdt,
                minNotionalUsdt: config.min_notional_usdt,
                buyOffsetPct: config.buy_offset_pct,
                sellOffsetPct: config.sell_offset_pct,
                refreshSeconds: config.refresh_seconds,
            },
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[devmmApi] start error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /v1/devmm/stop
router.post("/v1/devmm/stop", async (req, res) => {
    try {
        const parsed = StopSchema.parse(req.body);
        const exchange = parsed.exchange as DevmmExchange;
        const symbol = "PEPEW/USDT";
        console.log(`[devmm:stop] exchange=${exchange}, symbol=${symbol}`);
        const stateBeforeStop = getDevmmState(exchange, symbol);
        const trackedOrderIds = [
            stateBeforeStop?.open_buy_order_id || "",
            stateBeforeStop?.open_sell_order_id || "",
        ].filter(Boolean);

        // Disable config
        disableDevmmConfig(exchange, symbol);

        // Cancel open orders
        const keys = await getKeys(exchange);
        let cancelResult = { cancelled: 0, failed: 0 };
        if (keys) {
            cancelResult = await cancelAllDevmmOrders(exchange, keys.accessKey, keys.secretKey, trackedOrderIds);
        }

        // Update state after cancellation attempt
        setDevmmStatus(exchange, symbol, "STOPPED", null);
        upsertDevmmState(exchange, symbol, {
            open_buy_order_id: null,
            open_sell_order_id: null,
            status: 'STOPPED',
            pause_reason: null,
            last_action: "stopped",
            last_action_at: Date.now(),
        });
        resetDevmmBootstrapState(exchange, symbol);

        console.log(`[devmm:stop] DB updated for ${exchange} ${symbol}`);

        console.log(`[devmmApi] Stopped on ${exchange}, cancelled=${cancelResult.cancelled} failed=${cancelResult.failed}`);

        res.json({
            ok: true,
            message: `DevMM stopped on ${exchange}`,
            ordersCancelled: cancelResult.cancelled,
            ordersFailed: cancelResult.failed,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[devmmApi] stop error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/devmm/turnover
router.get("/v1/devmm/turnover", (req, res) => {
    try {
        const exchangeParam = req.query.exchange as string | undefined;
        const normalizedExchange = exchangeParam ? normalizeDevmmExchange(exchangeParam) : null;
        if (exchangeParam && !normalizedExchange) {
            return res.status(400).json({ ok: false, error: "INVALID_EXCHANGE" });
        }
        const exchanges: DevmmExchange[] = normalizedExchange
            ? [normalizedExchange]
            : ["nonkyc", "dextrade", "nestex"];
        const rows = exchanges.map((exchange) => {
            const symbol = "PEPEW/USDT";
            const config = getDevmmConfig(exchange, symbol);
            const state = getDevmmState(exchange, symbol);
            const vol24h = state?.vol24h_usdt || 0;
            const capDay = config ? Math.max(config.cap_day_min_usdt, vol24h * config.cap_ratio) : 0;
            const capHour = capDay / 24;
            const usedToday = state?.used_turnover_today_usdt || 0;
            const usedHour = state?.used_turnover_hour_usdt || 0;
            return {
                exchange,
                symbol,
                status: state?.status || "STOPPED",
                pauseReason: state?.pause_reason || null,
                turnoverKey: `${exchange}:${symbol}`,
                dayKey: state?.day_bucket || null,
                hourKey: state?.hour_bucket || null,
                usedTodayUsdt: usedToday,
                capDayUsdt: capDay,
                remainingTodayUsdt: Math.max(0, capDay - usedToday),
                usedHourUsdt: usedHour,
                capHourUsdt: capHour,
                remainingHourUsdt: Math.max(0, capHour - usedHour),
                vol24hUsdt: vol24h,
            };
        });
        return res.json({ ok: true, exchanges: rows });
    } catch (err: any) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// POST/GET /v1/devmm/turnover/reset (debug only)
const resetDevmmTurnoverHandler = (req: any, res: any) => {
    try {
        const resetEnabled = process.env.DEVMM_ALLOW_TURNOVER_RESET === "1" || process.env.DEVMM_ALLOW_TURNOVER_RESET === "true";
        if (!resetEnabled) {
            return res.status(403).json({ ok: false, error: "TURNOVER_RESET_DISABLED" });
        }

        const queryExchange = typeof req.query?.exchange === "string" ? req.query.exchange : undefined;
        const bodyExchange = typeof req.body?.exchange === "string" ? req.body.exchange : undefined;
        const exchangeParam = queryExchange || bodyExchange;
        const normalizedExchange = exchangeParam ? normalizeDevmmExchange(exchangeParam) : null;
        if (exchangeParam && !normalizedExchange) {
            return res.status(400).json({ ok: false, error: "INVALID_EXCHANGE" });
        }

        const exchanges: DevmmExchange[] = normalizedExchange
            ? [normalizedExchange]
            : ["nonkyc", "dextrade", "nestex"];
        const symbol = "PEPEW/USDT";
        const buckets = getTaipeiBuckets();
        const resetAt = Date.now();
        const results: any[] = [];

        for (const exchange of exchanges) {
            const before = getDevmmState(exchange, symbol);
            if (!before) {
                upsertDevmmState(exchange, symbol, {
                    status: "STOPPED",
                    day_bucket: buckets.day,
                    hour_bucket: buckets.hour,
                    used_turnover_today_usdt: 0,
                    used_turnover_hour_usdt: 0,
                    last_decision: "MANUAL_TURNOVER_RESET",
                });
            } else {
                resetDevmmTurnover(exchange, symbol, buckets.day, buckets.hour);
                upsertDevmmState(exchange, symbol, { last_decision: "MANUAL_TURNOVER_RESET" });
            }
            const after = getDevmmState(exchange, symbol);
            console.warn(
                `[devmmApi] TURNOVER_RESET exchange=${exchange} symbol=${symbol} beforeUsed=${before?.used_turnover_today_usdt || 0} afterUsed=${after?.used_turnover_today_usdt || 0} dayKey=${after?.day_bucket || "n/a"} hourKey=${after?.hour_bucket || "n/a"} ts=${resetAt}`
            );
            results.push({
                exchange,
                symbol,
                turnoverKey: `${exchange}:${symbol}`,
                beforeUsedTodayUsdt: before?.used_turnover_today_usdt || 0,
                beforeUsedHourUsdt: before?.used_turnover_hour_usdt || 0,
                afterUsedTodayUsdt: after?.used_turnover_today_usdt || 0,
                afterUsedHourUsdt: after?.used_turnover_hour_usdt || 0,
                dayKey: after?.day_bucket || buckets.day,
                hourKey: after?.hour_bucket || buckets.hour,
                resetAt,
            });
        }

        return res.json({
            ok: true,
            resetEnabled: true,
            dayKey: buckets.day,
            hourKey: buckets.hour,
            exchanges: results,
        });
    } catch (err: any) {
        return res.status(500).json({ ok: false, error: err.message });
    }
};

router.post("/v1/devmm/turnover/reset", resetDevmmTurnoverHandler);
router.get("/v1/devmm/turnover/reset", resetDevmmTurnoverHandler);

// GET /v1/devmm/status
router.get("/v1/devmm/status", (req, res) => {
    try {
        const exchangeParam = req.query.exchange as string | undefined;
        const normalizedExchange = exchangeParam ? normalizeDevmmExchange(exchangeParam) : null;
        if (exchangeParam && !normalizedExchange) {
            return res.status(400).json({ ok: false, error: "INVALID_EXCHANGE" });
        }
        const exchanges: DevmmExchange[] = normalizedExchange
            ? [normalizedExchange]
            : ["nonkyc", "dextrade", "nestex"];

        const results: any[] = [];

        for (const ex of exchanges) {
            const symbol = "PEPEW/USDT";
            const config = getDevmmConfig(ex, symbol);
            const state = getDevmmState(ex, symbol);
            const pendingCount = getDevmmPendingCount(ex);
            const bootstrap = getDevmmBootstrapSnapshot(ex, symbol);
            const trackedOpenOrders = (state?.open_buy_order_id ? 1 : 0) + (state?.open_sell_order_id ? 1 : 0);
            const parsedError = splitDevmmError(state?.last_error);
            let balanceLastOkTs: number | null = null;
            let balanceLastOkAgeSec: number | null = null;
            let balanceLastErrCode: string | null = null;
            try {
                const userId = config?.tg_user_id || process.env.DEVMM_TG_USER_ID || "devfee";
                const keyRecord = getExchangeKey(userId, ex);
                if (keyRecord) {
                    const decrypted = decryptKeyPair({
                        keyCipher: keyRecord.key_cipher,
                        secretCipher: keyRecord.secret_cipher,
                        iv: keyRecord.iv,
                        tag: keyRecord.tag,
                    });
                    const meta = getLastBalanceMeta(ex, decrypted.apiKey, `devmm:${ex}`);
                    balanceLastOkTs = meta.lastOkTs || null;
                    balanceLastOkAgeSec = meta.lastOkTs ? Math.max(0, Math.round((Date.now() - meta.lastOkTs) / 1000)) : null;
                    balanceLastErrCode = meta.lastErrCode || null;
                }
            } catch {
                // ignore key/balance meta errors in status endpoint
            }

            if (!config && !state) {
                results.push({
                    exchange: ex,
                    status: "STOPPED", // Standardize on STOPPED for not configured
                    issueCode: null,
                    isEnabled: false,
                    openOrders: 0,
                    pendingCount,
                    turnoverUsed: 0,
                    turnoverCap: 0,
                    turnoverRemaining: 0,
                    turnoverDayKey: null,
                    turnoverHourUsed: 0,
                    turnoverHourCap: 0,
                    turnoverHourRemaining: 0,
                    turnoverHourKey: null,
                    turnoverKey: `${ex}:${symbol}`,
                    turnover: { todayUsdt: 0, capDayUsdt: 0, hourUsdt: 0, capHourUsdt: 0, vol24hUsdt: 0 },
                    market: { bid: null, ask: null, mid: null, ref: null, spread: null },
                    orders: { buyOrderId: null, sellOrderId: null },
                    phase: bootstrap.phase,
                    bootstrapDone: bootstrap.bootstrapDone,
                    bootstrapBypassActive: bootstrap.bootstrapBypassActive,
                    bootstrapStartedAt: bootstrap.bootstrapStartedAt,
                });
                continue;
            }

            // Calculate caps
            const vol24h = state?.vol24h_usdt || 0;
            const capDay = config ? Math.max(config.cap_day_min_usdt, vol24h * config.cap_ratio) : 0;
            const capHour = capDay / 24;
            const turnoverToday = state?.used_turnover_today_usdt || 0;
            const turnoverHour = state?.used_turnover_hour_usdt || 0;
            const turnoverRemaining = Math.max(0, capDay - turnoverToday);
            const turnoverHourRemaining = Math.max(0, capHour - turnoverHour);
            const requestedExchange = config?.exchange || ex;
            const normalizedExchange = normalizeExchangeId(requestedExchange);
            const resolvedSpec = getExchangeSpec(normalizedExchange);
            const resolvedExchange = resolvedSpec.exchangeId;
            const missingBalance = state
                ? state.usdt_balance === null || state.usdt_balance === undefined || state.pepew_balance === null || state.pepew_balance === undefined
                : true;
            const balanceUnavailable =
                state?.pause_reason === DevmmPauseReason.BALANCE_FETCH_FAILED ||
                state?.last_error === DevmmPauseReason.BALANCE_FETCH_FAILED ||
                missingBalance;
            const inventory = balanceUnavailable
                ? { status: "unavailable", reason: DevmmPauseReason.BALANCE_FETCH_FAILED }
                : state
                    ? {
                        usdtBalance: state.usdt_balance ?? null,
                        pepewBalance: state.pepew_balance ?? null,
                        usdtShare: state.usdt_share ?? null,
                    }
                    : null;

            results.push({
                exchange: ex,
                requestedExchange,
                normalizedExchange,
                resolvedExchange,
                adapterKey: resolvedSpec.adapterKey,
                status: state?.status || "STOPPED",
                pauseReason: state?.pause_reason || null,
                issueCode: deriveDevmmIssueCode(state?.pause_reason || null, state?.last_decision || null),
                openOrders: trackedOpenOrders,
                pendingCount,
                turnoverUsed: turnoverToday,
                turnoverCap: capDay,
                turnoverRemaining,
                turnoverDayKey: state?.day_bucket || null,
                turnoverHourUsed: turnoverHour,
                turnoverHourCap: capHour,
                turnoverHourRemaining,
                turnoverHourKey: state?.hour_bucket || null,
                turnoverKey: `${ex}:${symbol}`,
                isEnabled: config?.is_enabled === 1,
                config: config ? {
                    symbol: config.symbol,
                    orderQuoteUsdt: config.order_quote_usdt,
                    minNotionalUsdt: config.min_notional_usdt,
                    buyOffsetPct: config.buy_offset_pct,
                    sellOffsetPct: config.sell_offset_pct,
                    refreshSeconds: config.refresh_seconds,
                    inventoryMinUsdtShare: config.inventory_min_usdt_share,
                    inventoryMaxUsdtShare: config.inventory_max_usdt_share,
                    capRatio: config.cap_ratio,
                } : null,
                turnover: {
                    todayUsdt: turnoverToday,
                    capDayUsdt: capDay,
                    hourUsdt: turnoverHour,
                    capHourUsdt: capHour,
                    vol24hUsdt: vol24h,
                    vol24hEstimate: !state?.vol24h_usdt,
                },
                inventory,
                market: {
                    bid: state?.last_bid || null,
                    ask: state?.last_ask || null,
                    mid: state?.last_mid || null,
                    ref: state?.last_ref || null,
                    spread: state?.last_bid && state?.last_ask && state?.last_mid
                        ? ((state.last_ask - state.last_bid) / state.last_mid)
                        : null,
                },
                orders: {
                    buyOrderId: state?.open_buy_order_id || null,
                    sellOrderId: state?.open_sell_order_id || null,
                },
                lastAction: state?.last_action || null,
                lastActionAt: state?.last_action_at || null,
                lastTickAt: state?.last_tick_at || null,
                lastDecision: state?.last_decision || null,
                lastError: state?.last_error || null,
                lastErrorCode: parsedError.code,
                lastErrorMessage: parsedError.message,
                lastErrorAt: state?.last_error_at || null,
                balanceLastOkTs,
                balanceLastOkAgeSec,
                balanceLastErrCode,
                phase: bootstrap.phase,
                bootstrapDone: bootstrap.bootstrapDone,
                bootstrapBypassActive: bootstrap.bootstrapBypassActive,
                bootstrapStartedAt: bootstrap.bootstrapStartedAt,
                cooldownUntil: state?.cooldown_until || null,
                updatedAt: state?.updated_at || null,
            });
        }

        res.json({
            ok: true,
            exchanges: results,
        });
    } catch (err: any) {
        console.error(`[devmmStatus] status error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/devmm/report
router.get("/v1/devmm/report", (req, res) => {
    try {
        const exchangeParam = req.query.exchange as string | undefined;
        const periodParam = req.query.period as string | undefined;

        const normalizedExchange = exchangeParam ? normalizeDevmmExchange(exchangeParam) : null;
        if (exchangeParam && !normalizedExchange) {
            return res.status(400).json({ ok: false, error: "INVALID_EXCHANGE" });
        }

        const exchanges: DevmmExchange[] = normalizedExchange
            ? [normalizedExchange]
            : ["nonkyc", "dextrade", "nestex"];

        const periods: Array<"daily" | "weekly" | "monthly"> = periodParam
            ? [periodParam as "daily" | "weekly" | "monthly"]
            : ["daily", "weekly", "monthly"];

        const reports: any[] = [];

        for (const ex of exchanges) {
            const config = getDevmmConfig(ex);
            const state = getDevmmState(ex);
            const isConfigured = !!(config || state);

            for (const period of periods) {
                const report = getDevmmReport(ex, period);
                if (report) {
                    reports.push({
                        exchange: ex,
                        period,
                        bucket: report.period,
                        buyTurnoverUsdt: report.buyTurnoverUsdt,
                        sellTurnoverUsdt: report.sellTurnoverUsdt,
                        totalTurnoverUsdt: report.totalTurnoverUsdt,
                        buyQtyPepew: report.buyQtyPepew,
                        sellQtyPepew: report.sellQtyPepew,
                        buyVwap: report.buyVwap,
                        sellVwap: report.sellVwap,
                        overallVwap: report.overallVwap,
                        totalFeeUsdt: report.totalFeeUsdt,
                        netUsdtChange: report.netUsdtChange,
                        netPepewChange: report.netPepewChange,
                        fillCount: report.fillCount,
                    });
                } else if (isConfigured) {
                    reports.push({
                        exchange: ex,
                        period,
                        bucket: null,
                        fillCount: 0,
                        totalTurnoverUsdt: 0,
                        buyTurnoverUsdt: 0,
                        sellTurnoverUsdt: 0,
                        buyQtyPepew: 0,
                        sellQtyPepew: 0,
                        netUsdtChange: 0,
                        netPepewChange: 0,
                        totalFeeUsdt: 0,
                    });
                } else {
                    reports.push({
                        exchange: ex,
                        period,
                        bucket: null,
                        message: "No data",
                        fillCount: 0,
                        totalTurnoverUsdt: 0,
                    });
                }
            }
        }

        res.json({
            ok: true,
            reports,
        });
    } catch (err: any) {
        console.error(`[devmmApi] report error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/devmm/debug/fills (Internal/Debug)
router.get("/v1/devmm/debug/fills", (req, res) => {
    try {
        const limit = Number(req.query.limit || 5);
        const exchange = req.query.exchange as string | undefined;

        let query = "SELECT * FROM devmm_fills";
        const params: any[] = [];

        if (exchange) {
            query += " WHERE exchange = ?";
            params.push(exchange);
        }

        query += " ORDER BY ts DESC LIMIT ?";
        params.push(limit);

        const fills = db.prepare(query).all(...params);
        res.json({ ok: true, fills });
    } catch (err: any) {
        res.status(500).json({ ok: true, error: err.message, fills: [] });
    }
});

export default router;
