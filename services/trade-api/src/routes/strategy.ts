import { Router } from "express";
import { z } from "zod";
import {
    getStrategyConfigsByUser,
    getRecentStrategyOrders,
    getRecentStrategyFills,
    upsertStrategyConfig,
    setStrategyEnabledById,
    getStrategyConfigById,
    getExchangeKey,
    getLatestFailure,
    getLatestStrategyEvent,
    getBackoffState,
    getOpenStrategyOrders,
    cancelOpenStrategyOrders,
    updateStrategyOrderStatus,
    getOpenGridOrders,
    cancelOpenGridOrders,
    updateGridOrderStatus,
} from "../db.js";
import { ExchangeName, formatPairDisplay, normalizePairSymbol, validatePair, getExchangeSymbol } from "../lib/markets.js";
import { classifyExchangeError } from "../exchanges/errors.js";
import { decryptKeyPair } from "../crypto.js";
import { computeFundsRequirement, getNonKycNormalizedBalance, checkFundsStatus } from "../lib/fundsCheck.js";
import { fetchExchangePrice } from "../strategies/price.js";
import { cancelNonKycOrder, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { getMarketRules, roundToTick, normalizePrice } from "../strategies/gridRunner.js";
import { cancelOutstandingOrders } from "../strategies/strategyHelper.js";

const router = Router();

const StrategyTypeSchema = z.preprocess(
    (value) => (typeof value === "string" ? value.toUpperCase() : value),
    z.enum(["DCA", "GRID", "MM"])
);

const TradeModeSchema = z.preprocess(
    (value) => (typeof value === "string" ? value.toUpperCase() : value),
    z.enum(["REAL"]).optional()
);

const StrategyUpsertSchema = z.object({
    tgUserId: z.string().min(1),
    exchange: z.enum(["nonkyc", "dextrade", "nestex"]),
    pair: z.string().min(1),
    tradeMode: TradeModeSchema,
    strategy: StrategyTypeSchema,
    enabled: z.boolean().optional(),
    params: z.record(z.any()).optional(),
    paramsJson: z.string().optional(),
    notes: z.string().max(256).optional(),
});

const StrategyToggleSchema = z.object({
    tgUserId: z.string().min(1),
});

function safeParseJson(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

// POST /v1/strategy/config/upsert
router.post("/v1/strategy/config/upsert", (req, res) => {
    try {
        const parsed = StrategyUpsertSchema.parse(req.body);
        const tradeMode = "REAL";
        const strategy = parsed.strategy;

        const normalizedSymbol = normalizePairSymbol(parsed.exchange as ExchangeName, parsed.pair);
        if (!normalizedSymbol || !validatePair(parsed.exchange as ExchangeName, normalizedSymbol)) {
            return res.status(400).json({ ok: false, error: "Unsupported exchange/pair" });
        }
        const pairDisplay = formatPairDisplay(parsed.exchange as ExchangeName, normalizedSymbol);

        let paramsJson = parsed.paramsJson;
        if (!paramsJson && parsed.params) {
            paramsJson = JSON.stringify(parsed.params);
        }
        if (!paramsJson) {
            return res.status(400).json({ ok: false, error: "params or paramsJson is required" });
        }

        const config = upsertStrategyConfig({
            tgUserId: parsed.tgUserId,
            exchange: parsed.exchange,
            pair: pairDisplay,
            tradeMode,
            strategy,
            paramsJson,
            enabled: parsed.enabled ?? false,
            notes: parsed.notes ?? null,
        });

        res.json({
            ok: true,
            config: {
                id: config.id,
                tgUserId: config.tg_user_id,
                exchange: config.exchange,
                pair: config.pair,
                tradeMode: config.trade_mode,
                strategy: config.strategy,
                enabled: config.enabled === 1,
                lastRunAt: config.last_run_at,
                createdAt: config.created_at,
                updatedAt: config.updated_at,
                params: safeParseJson(config.params_json),
                notes: config.notes,
            },
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[strategy] upsert error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /v1/strategy/config/:id/enable
router.post("/v1/strategy/config/:id/enable", (req, res) => {
    try {
        const configId = Number(req.params.id);
        if (!Number.isFinite(configId) || configId <= 0) {
            return res.status(400).json({ ok: false, error: "Invalid config id" });
        }
        const parsed = StrategyToggleSchema.parse(req.body);

        // Get config first to check trade_mode
        const config = getStrategyConfigById(configId);
        if (!config || config.tg_user_id !== parsed.tgUserId) {
            return res.status(404).json({ ok: false, error: "Strategy config not found" });
        }

        // REAL mode guard: check if keys are configured
        // Guard keys check
        const keys = getExchangeKey(parsed.tgUserId, config.exchange);
        if (!keys) {
            console.log(`[strategy] enable blocked: MISSING_KEYS user=${parsed.tgUserId.slice(0, 8)}... exchange=${config.exchange} config=${configId}`);
            return res.status(400).json({
                ok: false,
                error: "MISSING_KEYS",
                message: "API keys not set for this exchange. Use /keys first."
            });
        }

        const updated = setStrategyEnabledById(configId, parsed.tgUserId, true);
        if (!updated) {
            return res.status(404).json({ ok: false, error: "Strategy config not found" });
        }

        // Refresh config after update
        const updatedConfig = getStrategyConfigById(configId);

        res.json({
            ok: true,
            message: "Strategy enabled",
            config: {
                id: updatedConfig!.id,
                tgUserId: updatedConfig!.tg_user_id,
                exchange: updatedConfig!.exchange,
                pair: updatedConfig!.pair,
                tradeMode: updatedConfig!.trade_mode,
                strategy: updatedConfig!.strategy,
                enabled: true,
                lastRunAt: updatedConfig!.last_run_at,
                createdAt: updatedConfig!.created_at,
                updatedAt: updatedConfig!.updated_at,
                params: safeParseJson(updatedConfig!.params_json),
                notes: updatedConfig!.notes,
            },
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[strategy] enable error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /v1/strategy/config/:id/disable
router.post("/v1/strategy/config/:id/disable", (req, res) => {
    try {
        const configId = Number(req.params.id);
        if (!Number.isFinite(configId) || configId <= 0) {
            return res.status(400).json({ ok: false, error: "Invalid config id" });
        }
        const parsed = StrategyToggleSchema.parse(req.body);
        const updated = setStrategyEnabledById(configId, parsed.tgUserId, false);
        const config = getStrategyConfigById(configId);

        if (!updated || !config) {
            return res.status(404).json({ ok: false, error: "Strategy config not found" });
        }

        res.json({
            ok: true,
            message: "Strategy disabled",
            config: {
                id: config.id,
                tgUserId: config.tg_user_id,
                exchange: config.exchange,
                pair: config.pair,
                tradeMode: config.trade_mode,
                strategy: config.strategy,
                enabled: false,
                lastRunAt: config.last_run_at,
                createdAt: config.created_at,
                updatedAt: config.updated_at,
                params: safeParseJson(config.params_json),
                notes: config.notes,
            },
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[strategy] disable error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/strategy/status?tg_user_id=...
router.get("/v1/strategy/status", async (req, res) => {
    try {
        const tgUserId = (req.query.tg_user_id || req.query.tgUserId) as string;
        if (!tgUserId) {
            return res.status(400).json({ ok: false, error: "tg_user_id query param required" });
        }

        const configs = getStrategyConfigsByUser(tgUserId);
        const orders = getRecentStrategyOrders(tgUserId, 20);
        const fills = getRecentStrategyFills(tgUserId, 10);

        // Fetch shared balance if there are NonKYC strategies
        const hasNonKyc = configs.some(c => c.exchange === "nonkyc");
        let sharedBalance: any = null;
        if (hasNonKyc) {
            const keyRecord = getExchangeKey(tgUserId, "nonkyc");
            if (keyRecord) {
                try {
                    const decrypted = decryptKeyPair({
                        keyCipher: keyRecord.key_cipher,
                        secretCipher: keyRecord.secret_cipher,
                        iv: keyRecord.iv,
                        tag: keyRecord.tag,
                    });
                    const balanceResult = await getNonKycNormalizedBalance(decrypted.apiKey, decrypted.apiSecret);
                    if (balanceResult) {
                        sharedBalance = balanceResult;
                        if (process.env.TRADE_DEBUG_STATUS === "1") {
                            console.log(`[strategy] status: fetched shared balance for NonKYC REAL: USDT=${sharedBalance.data.freeUSDT}, PEPEW=${sharedBalance.data.freePEPEW}`);
                        }
                    }
                } catch (err) {
                    console.warn(`[strategy] status: failed to fetch shared balance: ${err}`);
                }
            }
        }

        const debugEnabled = process.env.TRADE_DEBUG_STATUS === "1" || req.query.debug === "1";

        res.json({
            ok: true,
            debug: (debugEnabled && sharedBalance) ? {
                balance_source: "NonKYC",
                fetchedAt: sharedBalance.metadata.fetchedAt,
                cacheAgeMs: sharedBalance.metadata.cacheAgeMs,
                isCached: sharedBalance.metadata.isCached,
                symbolsFound: sharedBalance.metadata.symbolsFound,
                freeUSDT: sharedBalance.data.freeUSDT,
                freePEPEW: sharedBalance.data.freePEPEW,
            } : null,
            configs: configs.map((config) => {
                const failure = getLatestFailure(config.id);
                const backoff = getBackoffState(config.id);
                const lastEvent = getLatestStrategyEvent(config.id);
                const params = safeParseJson(config.params_json) || {};
                const hasBasePrice = !!(params.base_price && params.base_price > 0);
                const localOpen = config.strategy === "GRID" ? getOpenGridOrders(config.id).length : 0;
                const openBuyCount = config.strategy === "DCA" ? (params.openBuy ?? 0) : 0;


                // If this is a NonKYC REAL strategy and we have a shared balance,
                // we could override/augment the lastAction if it says "have 0"
                // but for now let's just ensure the data is consistent.

                const failureDetails = failure?.details_json ? safeParseJson(failure.details_json) ?? failure.details_json : null;
                const failureCategory = failure && failure.category === "UNKNOWN"
                    ? classifyExchangeError(config.exchange, {
                        httpStatus: failure.last_http_status ?? undefined,
                        message: failure.message,
                        code: failure.last_exchange_code ?? undefined,
                    }).category
                    : failure?.category;
                return {
                    id: config.id,
                    tgUserId: config.tg_user_id,
                    exchange: config.exchange,
                    pair: config.pair,
                    tradeMode: config.trade_mode,
                    strategy: config.strategy,
                    enabled: config.enabled === 1,
                    lastRunAt: config.last_run_at,
                    createdAt: config.created_at,
                    updatedAt: config.updated_at,
                    params: safeParseJson(config.params_json),
                    notes: config.notes,
                    // New failure/backoff fields
                    disabledReason: config.disabled_reason,
                    consecutiveFailures: config.consecutive_failures,
                    lastAction: (lastEvent?.message || null),
                    lastActionAt: lastEvent?.ts || null,
                    // Consistency check: if last action says "have 0" but shared balance has funds
                    inventoryWarning: (config.exchange === "nonkyc" && lastEvent?.message?.includes("have 0") && sharedBalance)
                        ? (function () {
                            const msg = lastEvent?.message || "";
                            if (msg.includes("BUY") && sharedBalance.data.freeUSDT > 0) {
                                return `DISCREPANCY DETECTED: Action reports "have 0 USDT" but current balance is ${sharedBalance.data.freeUSDT.toFixed(2)} USDT.`;
                            }
                            if (msg.includes("SELL") && sharedBalance.data.freePEPEW > 0) {
                                return `DISCREPANCY DETECTED: Action reports "have 0 PEPEW" but current balance is ${sharedBalance.data.freePEPEW.toExponential(2)} PEPEW.`;
                            }
                            return null;
                        })()
                        : null,
                    currentInventory: (config.exchange === "nonkyc" && sharedBalance)
                        ? {
                            PEPEW: sharedBalance.data.freePEPEW,
                            USDT: sharedBalance.data.freeUSDT,
                            fetchedAt: sharedBalance.metadata.fetchedAt
                        }
                        : null,
                    lastFailure: failure ? {
                        category: failureCategory || failure.category,
                        message: failure.message,
                        lastSeenAt: failure.last_seen_at,
                        count: failure.count,
                        httpStatus: failure.last_http_status ?? null,
                        exchangeCode: failure.last_exchange_code ?? null,
                        details: failureDetails,
                    } : null,
                    backoff: backoff.isInBackoff ? {
                        until: backoff.nextAllowedAt,
                        remainingSec: backoff.remainingSec
                    } : null,
                    gridDebug: config.strategy === "GRID" ? {
                        hasBasePrice,
                        openGridOrders: localOpen,
                        lastSkipReason: lastEvent?.message?.includes("SKIP") ? lastEvent.message : null
                    } : null,
                    openBuy: config.strategy === "DCA" ? openBuyCount : undefined
                };

            }),
            recentOrders: orders.map((o) => ({
                id: o.id,
                configId: o.config_id,
                exchange: o.exchange,
                pair: o.pair,
                strategy: o.strategy,
                tradeMode: o.trade_mode,
                side: o.side,
                price: o.price,
                qty: o.qty,
                quoteQty: o.quote_qty,
                status: o.status,
                createdAt: o.created_at,
            })),
            recentFills: fills.map((f) => ({
                id: f.id,
                configId: f.config_id,
                orderId: f.order_id,
                exchange: f.exchange,
                pair: f.pair,
                strategy: f.strategy,
                tradeMode: f.trade_mode,
                side: f.side,
                price: f.price,
                qty: f.qty,
                quoteQty: f.price * f.qty,
                ts: f.ts,
            })),
        });
    } catch (err: any) {
        console.error(`[strategy] status error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Schema for funds check request
const FundsCheckSchema = z.object({
    tgUserId: z.string().min(1),
    exchange: z.enum(["nonkyc", "dextrade", "nestex"]),
    pair: z.string().min(1),
    strategy: StrategyTypeSchema,
    params: z.record(z.any()),
});

// POST /v1/strategy/funds-check
router.post("/v1/strategy/funds-check", async (req, res) => {
    try {
        const parsed = FundsCheckSchema.parse(req.body);

        // Only NonKYC REAL mode supports balance checking for now
        if (parsed.exchange !== "nonkyc") {
            return res.json({
                ok: true,
                status: "PASS",
                messages: ["Funds check only available for NonKYC exchange"],
                need: { needUSDT: 0, needPEPEW: 0, notes: [] },
                available: null,
            });
        }

        // Get API keys
        const keyRecord = getExchangeKey(parsed.tgUserId, parsed.exchange);
        if (!keyRecord) {
            return res.status(400).json({
                ok: false,
                error: "MISSING_KEYS",
                message: "No API keys set for NonKYC. Use /keys first.",
            });
        }

        let accessKey: string, secretKey: string;
        try {
            const decrypted = decryptKeyPair({
                keyCipher: keyRecord.key_cipher,
                secretCipher: keyRecord.secret_cipher,
                iv: keyRecord.iv,
                tag: keyRecord.tag,
            });
            accessKey = decrypted.apiKey;
            secretKey = decrypted.apiSecret;
        } catch {
            return res.status(400).json({
                ok: false,
                error: "DECRYPT_FAILED",
                message: "Failed to decrypt API keys",
            });
        }

        // Get current price for PEPEW calculations
        let midPrice: number | undefined;
        try {
            const priceResult = await fetchExchangePrice(parsed.exchange as ExchangeName, parsed.pair);
            midPrice = priceResult?.price;
        } catch {
            console.warn(`[strategy] funds-check: price fetch failed for ${parsed.pair}`);
        }

        // Compute requirements
        const need = computeFundsRequirement(parsed.strategy, parsed.params, midPrice);

        // Fetch balance
        const balanceResult = await getNonKycNormalizedBalance(accessKey, secretKey);
        if (!balanceResult) {
            return res.status(500).json({
                ok: false,
                error: "BALANCE_FETCH_FAILED",
                message: "Could not fetch NonKYC account balance",
            });
        }
        const available = balanceResult.data;

        // Check status
        const check = checkFundsStatus(need, available);

        console.log(`[strategy] funds-check: user=${parsed.tgUserId.slice(0, 8)}... strategy=${parsed.strategy} status=${check.status}`);

        res.json({
            ok: true,
            status: check.status,
            messages: check.messages,
            need,
            available,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[strategy] funds-check error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/balance/nonkyc?tgUserId=...
router.get("/v1/balance/nonkyc", async (req, res) => {
    try {
        const tgUserId = (req.query.tgUserId || req.query.tg_user_id) as string;
        if (!tgUserId) {
            return res.status(400).json({ ok: false, error: "tgUserId query param required" });
        }

        const keyRecord = getExchangeKey(tgUserId, "nonkyc");
        if (!keyRecord) {
            return res.status(400).json({
                ok: false,
                error: "MISSING_KEYS",
                message: "No API keys set for NonKYC",
            });
        }

        let accessKey: string, secretKey: string;
        try {
            const decrypted = decryptKeyPair({
                keyCipher: keyRecord.key_cipher,
                secretCipher: keyRecord.secret_cipher,
                iv: keyRecord.iv,
                tag: keyRecord.tag,
            });
            accessKey = decrypted.apiKey;
            secretKey = decrypted.apiSecret;
        } catch {
            return res.status(400).json({
                ok: false,
                error: "DECRYPT_FAILED",
                message: "Failed to decrypt API keys",
            });
        }

        const balanceResult = await getNonKycNormalizedBalance(accessKey, secretKey, false); // Don't use cache
        if (!balanceResult) {
            return res.status(500).json({
                ok: false,
                error: "BALANCE_FETCH_FAILED",
                message: "Could not fetch NonKYC account balance",
            });
        }

        res.json({
            ok: true,
            exchange: "nonkyc",
            freeUSDT: balanceResult.data.freeUSDT,
            freePEPEW: balanceResult.data.freePEPEW,
            fetchedAt: Date.now(),
        });
    } catch (err: any) {
        console.error(`[strategy] balance error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /v1/strategy/config/:id/cancel-orders
// POST /v1/strategy/config/:id/cancel-orders
router.post("/v1/strategy/config/:id/cancel-orders", async (req, res) => {
    try {
        const configId = Number(req.params.id);
        if (!Number.isFinite(configId) || configId <= 0) {
            return res.status(400).json({ ok: false, error: "Invalid config id" });
        }
        const parsed = StrategyToggleSchema.parse(req.body);

        const config = getStrategyConfigById(configId);
        if (!config || config.tg_user_id !== parsed.tgUserId) {
            return res.status(404).json({ ok: false, error: "Strategy config not found" });
        }

        // Use unified cancellation mechanism
        const result = await cancelOutstandingOrders(configId);

        // Also call legacy cancel for DB cleanup just in case (e.g. non-registry orders)
        cancelOpenStrategyOrders(configId);
        if (config.strategy === "GRID") cancelOpenGridOrders(configId);

        res.json({
            ok: true,
            ...result,
            message: `Cancelled ${result.cancelled}/${result.total} orders, ${result.failed} failed.`,
        });

    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[strategy] cancel-orders error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
