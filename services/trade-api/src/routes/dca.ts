import { Router } from "express";
import { z } from "zod";
import {
    upsertDcaConfig,
    getDcaConfigById,
    setDcaEnabledById,
    setDcaEnabledByKey,
    disableAllDcaConfigs,
    getAllDcaConfigs,
    getRecentStrategyOrders,
    getExchangeKey,
} from "../db.js";
import { supportsReal } from "../lib/exchanges.js";
import { cancelOutstandingOrders } from "../strategies/strategyHelper.js";
import {
    ExchangeName,
    formatPairDisplay,
    getDefaultBudget,
    getQuoteUnit,
    normalizePairSymbol,
    validatePair,
} from "../lib/markets.js";

const router = Router();

const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PDep1ZNhCyqyRwjnQif8K6tPGsE7TvhyT6";

// Mode to config mapping (for /dca_set legacy command)
const MODE_CONFIG = {
    BNB: {
        exchange: "nonkyc" as ExchangeName,
        symbol: "PEPEW_BNB",
    },
    USDT: {
        exchange: "dextrade" as ExchangeName,
        symbol: "PEPEWUSDT",
    },
} as const;

const ModeSchema = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const upper = value.toUpperCase();
    return upper === "BNB" || upper === "USDT" ? upper : undefined;
}, z.enum(["BNB", "USDT"]).optional());

const QuoteAssetSchema = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    return value.toUpperCase();
}, z.enum(["BNB", "USDT"]).optional());

const TradeModeSchema = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    return value.toUpperCase();
}, z.enum(["REAL"]).optional());

const PositiveNumberSchema = z.preprocess((value) => {
    if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
    }
    return value;
}, z.number().positive());

const PositiveIntSchema = z.preprocess((value) => {
    if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
    }
    return value;
}, z.number().int().positive());

const DcaConfigSchema = z.object({
    tgUserId: z.string().min(1),
    mode: ModeSchema,
    exchange: z.enum(["nonkyc", "dextrade", "nestex"]).optional(),
    symbol: z.string().optional(),
    pair: z.string().optional(),
    quoteAsset: QuoteAssetSchema,
    quoteCcy: QuoteAssetSchema,
    intervalSec: PositiveIntSchema.optional(),
    intervalMinutes: PositiveIntSchema.optional(),
    budget: PositiveNumberSchema.optional(),
    budgetQuotePerOrder: PositiveNumberSchema.optional(),
    quoteAmount: PositiveNumberSchema.optional(),
    tradeMode: TradeModeSchema,
    maxTotalSpend: PositiveNumberSchema.optional(),
    runForMinutes: PositiveIntSchema.optional(),
});

const DcaTargetSchema = z.object({
    tgUserId: z.string().min(1),
    configId: z.preprocess((value) => {
        if (typeof value === "string" && value.trim() !== "") return Number(value);
        return value;
    }, z.number().int().positive().optional()),
    exchange: z.enum(["nonkyc", "dextrade", "nestex"]).optional(),
    pair: z.string().optional(),
    tradeMode: TradeModeSchema,
    stopAll: z.boolean().optional(),
});

// POST /v1/dca/config
router.post("/v1/dca/config", (req, res) => {
    try {
        const parsed = DcaConfigSchema.parse(req.body);

        const tradeMode = "REAL";
        const symbolInput = parsed.symbol || parsed.pair || "";

        let exchange: ExchangeName;
        let symbol: string;
        let quoteAsset: string;
        let defaultBudget: number;

        if (parsed.exchange) {
            exchange = parsed.exchange;
            if (!symbolInput) {
                return res.status(400).json({ ok: false, error: "pair is required for exchange-based config" });
            }
            const normalizedSymbol = normalizePairSymbol(exchange, symbolInput);
            if (!normalizedSymbol || !validatePair(exchange, normalizedSymbol)) {
                return res.status(400).json({ ok: false, error: "Unsupported exchange/pair" });
            }
            symbol = normalizedSymbol;
            quoteAsset = getQuoteUnit(exchange, symbol) || "";
            defaultBudget = getDefaultBudget(exchange, symbol) ?? 0;
            if (!quoteAsset || !Number.isFinite(defaultBudget) || defaultBudget <= 0) {
                return res.status(400).json({ ok: false, error: "Invalid market metadata" });
            }
            const quoteOverride = parsed.quoteAsset || parsed.quoteCcy;
            if (quoteOverride && quoteOverride !== quoteAsset) {
                return res.status(400).json({ ok: false, error: "Quote asset mismatch" });
            }
        } else if (parsed.mode) {
            const modeConfig = MODE_CONFIG[parsed.mode];
            exchange = modeConfig.exchange;
            symbol = modeConfig.symbol;
            quoteAsset = getQuoteUnit(exchange, symbol) || "";
            defaultBudget = getDefaultBudget(exchange, symbol) ?? 0;
            if (!quoteAsset || !Number.isFinite(defaultBudget) || defaultBudget <= 0) {
                return res.status(400).json({ ok: false, error: "Invalid market metadata" });
            }
        } else {
            return res.status(400).json({ ok: false, error: "mode or exchange/pair required" });
        }

        if (!supportsReal(exchange)) {
            console.log(`[dca] REAL rejected: exchange=${exchange} supportsReal=false tgUserId=${parsed.tgUserId.slice(0, 8)}...`);
            return res.status(400).json({ ok: false, error: "REAL mode not supported for this exchange yet" });
        }

        const budget = parsed.budget ?? parsed.budgetQuotePerOrder ?? parsed.quoteAmount ?? defaultBudget;
        if (!Number.isFinite(budget) || budget <= 0) {
            return res.status(400).json({ ok: false, error: "Invalid budget amount" });
        }

        let intervalSec = parsed.intervalSec ?? (parsed.intervalMinutes ? parsed.intervalMinutes * 60 : undefined);
        if (!intervalSec) {
            intervalSec = 600;
        }
        if (!Number.isFinite(intervalSec) || intervalSec < 60) {
            return res.status(400).json({ ok: false, error: "Interval must be at least 60 seconds" });
        }

        const maxTotalSpend = parsed.maxTotalSpend;
        let endsAt: number | null = null;
        if (parsed.runForMinutes) {
            endsAt = Date.now() + parsed.runForMinutes * 60 * 1000;
        }

        const pairDisplay = formatPairDisplay(exchange, symbol);
        const config = upsertDcaConfig(
            parsed.tgUserId,
            exchange,
            pairDisplay,
            symbol,
            tradeMode,
            "DCA",
            quoteAsset,
            budget,
            intervalSec,
            maxTotalSpend,
            endsAt
        );

        console.log(`[dca] config upserted: tgUserId=${parsed.tgUserId}, id=${config.id}, exchange=${exchange}, symbol=${symbol}, pair=${pairDisplay}, tradeMode=${tradeMode}, budget=${budget}, interval=${intervalSec}s`);

        res.json({
            ok: true,
            config: {
                id: config.id,
                tgUserId: config.tg_user_id,
                exchange: config.exchange,
                pair: config.pair,
                symbol: config.symbol,
                quoteCcy: config.quote_ccy,
                budget: config.budget,
                intervalSec: config.interval_sec,
                enabled: config.enabled === 1,
                tradeMode: config.trade_mode,
                strategy: config.strategy,
                lastRunAt: config.last_run_at,
                createdAt: config.created_at,
                updatedAt: config.updated_at,
                maxTotalSpend: config.max_total_spend,
                endsAt: config.ends_at,
            },
            donateAddress: DONATE_ADDRESS,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[dca] config error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /v1/dca/start
router.post("/v1/dca/start", (req, res) => {
    try {
        const parsed = DcaTargetSchema.parse(req.body);
        const tradeMode = parsed.tradeMode;
        let config = null;

        if (parsed.configId) {
            config = getDcaConfigById(parsed.tgUserId, parsed.configId);
        } else if (parsed.exchange && parsed.pair) {
            const normalizedSymbol = normalizePairSymbol(parsed.exchange, parsed.pair);
            if (!normalizedSymbol || !validatePair(parsed.exchange, normalizedSymbol)) {
                return res.status(400).json({ ok: false, error: "Unsupported exchange/pair" });
            }
            const pairDisplay = formatPairDisplay(parsed.exchange, normalizedSymbol);
            const candidates = getAllDcaConfigs(parsed.tgUserId).filter(
                (item) => item.exchange === parsed.exchange && item.pair === pairDisplay
            );
            if (!tradeMode) {
                if (candidates.length === 1) {
                    config = candidates[0];
                } else if (candidates.length === 0) {
                    return res.status(404).json({ ok: false, error: "DCA config not found" });
                } else {
                    return res.status(400).json({ ok: false, error: "Multiple trade modes found. Provide tradeMode." });
                }
            } else {
                config = candidates.find((item) => item.trade_mode === tradeMode) || null;
            }
        } else {
            const all = getAllDcaConfigs(parsed.tgUserId);
            if (all.length === 1) {
                config = all[0];
            } else if (all.length === 0) {
                return res.status(404).json({ ok: false, error: "No DCA config found. Create one first with POST /v1/dca/config" });
            } else {
                return res.status(400).json({ ok: false, error: "Multiple configs found. Provide configId or exchange/pair/tradeMode." });
            }
        }

        if (!config) {
            return res.status(404).json({ ok: false, error: "DCA config not found" });
        }

        if (!supportsReal(config.exchange)) {
            console.log(`[dca] start REAL rejected: exchange=${config.exchange} supportsReal=false tgUserId=${parsed.tgUserId.slice(0, 8)}...`);
            return res.status(400).json({ ok: false, error: "REAL mode not supported for this exchange yet" });
        }
        const keys = getExchangeKey(parsed.tgUserId, config.exchange);
        if (!keys) {
            return res.status(400).json({ ok: false, error: "API keys not set for this exchange. Use /keys" });
        }

        const updated = setDcaEnabledById(config.id, parsed.tgUserId, true);
        console.log(`[dca] started: tgUserId=${parsed.tgUserId}, updated=${updated}`);
        console.log(`[dca] selected config: tgUserId=${parsed.tgUserId}, id=${config.id}, exchange=${config.exchange}, pair=${config.pair}`);

        res.json({
            ok: true,
            message: "DCA started",
            config: {
                id: config.id,
                exchange: config.exchange,
                pair: config.pair,
                symbol: config.symbol,
                quoteCcy: config.quote_ccy,
                budget: config.budget,
                intervalSec: config.interval_sec,
                enabled: true,
                tradeMode: config.trade_mode,
                strategy: config.strategy,
                lastRunAt: config.last_run_at,
                createdAt: config.created_at,
                updatedAt: config.updated_at,
                maxTotalSpend: config.max_total_spend,
                endsAt: config.ends_at,
            },
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[dca] start error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /v1/dca/stop
router.post("/v1/dca/stop", async (req, res) => {
    try {
        const parsed = DcaTargetSchema.parse(req.body);
        let updated = false;
        let config = null;

        if (parsed.stopAll) {
            const allDca = getAllDcaConfigs(parsed.tgUserId);
            for (const c of allDca) {
                await cancelOutstandingOrders(c.id).catch(e => console.warn(`[dca] stopall cancel failed for id=${c.id}: ${e.message}`));
            }
            updated = disableAllDcaConfigs(parsed.tgUserId);
        } else if (parsed.configId) {
            config = getDcaConfigById(parsed.tgUserId, parsed.configId);
            if (!config) {
                return res.status(404).json({ ok: false, error: "DCA config not found" });
            }
            updated = setDcaEnabledById(config.id, parsed.tgUserId, false);
        } else if (parsed.exchange && parsed.pair) {
            const normalizedSymbol = normalizePairSymbol(parsed.exchange, parsed.pair);
            if (!normalizedSymbol || !validatePair(parsed.exchange, normalizedSymbol)) {
                return res.status(400).json({ ok: false, error: "Unsupported exchange/pair" });
            }
            const pairDisplay = formatPairDisplay(parsed.exchange, normalizedSymbol);
            const candidates = getAllDcaConfigs(parsed.tgUserId).filter(
                (item) => item.exchange === parsed.exchange && item.pair === pairDisplay
            );
            if (!parsed.tradeMode) {
                if (candidates.length === 1) {
                    config = candidates[0];
                    updated = setDcaEnabledById(config.id, parsed.tgUserId, false);
                } else if (candidates.length === 0) {
                    return res.status(404).json({ ok: false, error: "DCA config not found" });
                } else {
                    return res.status(400).json({ ok: false, error: "Multiple trade modes found. Provide tradeMode." });
                }
            } else {
                const pairDisplay = formatPairDisplay(parsed.exchange, normalizedSymbol);
                config = getAllDcaConfigs(parsed.tgUserId).find(
                    (item) => item.exchange === parsed.exchange && item.pair === pairDisplay && item.trade_mode === parsed.tradeMode
                );
                updated = setDcaEnabledByKey(parsed.tgUserId, parsed.exchange, pairDisplay, parsed.tradeMode, false);
            }
        } else {
            const all = getAllDcaConfigs(parsed.tgUserId);
            if (all.length === 1) {
                config = all[0];
                updated = setDcaEnabledById(config.id, parsed.tgUserId, false);
            } else if (all.length === 0) {
                return res.status(404).json({ ok: false, error: "No DCA config found. Create one first with POST /v1/dca/config" });
            } else {
                return res.status(400).json({ ok: false, error: "Multiple configs found. Provide configId or exchange/pair/tradeMode." });
            }
        }

        if (config?.id || parsed.configId) {
            const stopId = config?.id || parsed.configId;
            if (stopId) {
                console.log(`[dca] stopping configId=${stopId} and cancelling orders...`);
                await cancelOutstandingOrders(stopId);
            }
        }

        console.log(`[dca] stopped: tgUserId=${parsed.tgUserId}, updated=${updated}`);

        res.json({
            ok: true,
            message: updated ? "DCA stopped" : "No matching DCA config found",
            config: config ? {
                id: config.id,
                exchange: config.exchange,
                pair: config.pair,
                symbol: config.symbol,
                quoteCcy: config.quote_ccy,
                budget: config.budget,
                intervalSec: config.interval_sec,
                enabled: false,
                tradeMode: config.trade_mode,
                strategy: config.strategy,
                lastRunAt: config.last_run_at,
                createdAt: config.created_at,
                updatedAt: config.updated_at,
                maxTotalSpend: config.max_total_spend,
                endsAt: config.ends_at,
            } : null,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[dca] stop error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/dca/status
router.get("/v1/dca/status", (req, res) => {
    try {
        const tgUserId = req.query.tgUserId as string;
        if (!tgUserId) {
            return res.status(400).json({ ok: false, error: "tgUserId query param required" });
        }

        const configs = getAllDcaConfigs(tgUserId);
        const orders = getRecentStrategyOrders(tgUserId, 20).filter((o) => o.strategy === "DCA").slice(0, 10);

        res.json({
            ok: true,
            configs: configs.map((config) => ({
                id: config.id,
                tgUserId: config.tg_user_id,
                exchange: config.exchange,
                pair: config.pair,
                symbol: config.symbol,
                quoteCcy: config.quote_ccy,
                budget: config.budget,
                intervalSec: config.interval_sec,
                enabled: config.enabled === 1,
                tradeMode: config.trade_mode,
                strategy: config.strategy,
                lastRunAt: config.last_run_at,
                createdAt: config.created_at,
                updatedAt: config.updated_at,
                maxTotalSpend: config.max_total_spend,
                endsAt: config.ends_at,
            })),
            recentOrders: orders.map((o) => ({
                id: o.id,
                exchange: o.exchange,
                pair: o.pair,
                symbol: normalizePairSymbol(o.exchange as ExchangeName, o.pair) || "UNSUPPORTED_PAIR",
                side: o.side,
                quoteAmount: o.quote_qty ?? 0,
                price: o.price,
                status: o.status,
                tradeMode: o.trade_mode,
                strategy: o.strategy,
                createdAt: o.created_at,
            })),
            donateAddress: DONATE_ADDRESS,
        });
    } catch (err: any) {
        console.error(`[dca] status error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
