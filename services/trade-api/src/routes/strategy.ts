import { Router } from "express";
import { z } from "zod";
import db, {
    getStrategyConfigsByUser,
    getRecentStrategyOrders,
    getRecentStrategyFills,
    upsertStrategyConfig,
    setStrategyEnabledById,
    setStrategyDisabledWithReason,
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
    getDevmmReport,
} from "../db.js";
import { ExchangeName, formatPairDisplay, normalizePairSymbol, validatePair, getExchangeSymbol } from "../lib/markets.js";
import { listExchangeSpecs, getExchangeSpec, normalizeExchangeId } from "../registry/exchanges.js";
import { parsePair } from "../registry/pairs.js";
import { classifyExchangeError } from "../exchanges/errors.js";
import { decryptKeyPair } from "../crypto.js";
import { computeFundsRequirement, getExchangeNormalizedBalance, checkFundsStatus, performFundsCheck } from "../lib/fundsCheck.js";
import { fetchExchangePrice } from "../strategies/price.js";
import { cancelNonKycOrder, listNonKycOpenOrders } from "../exchanges/nonkyc.js";
import { getMarketRules, roundToTick, normalizePrice } from "../strategies/gridRunner.js";
import { cancelOutstandingOrders } from "../strategies/strategyHelper.js";
import { getLastBalanceMeta, getNormalizedBalances, NormalizedBalance } from "../lib/balanceHelper.js";

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
    reason: z.string().min(1).max(64).optional(),
});

function safeParseJson(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function collectBalanceSummaryForUser(tgUserId: string): Promise<Array<{
    exchangeId: ExchangeName;
    ok: boolean;
    errCode?: string;
    error?: string;
    lastOkTs?: number;
    snapshot?: any;
    assets: { USDT: number; BNB: number; PEPEW: number };
}>> {
    const supportedExchanges: ExchangeName[] = ["nonkyc", "dextrade", "nestex"];
    const balances: Array<{
        exchangeId: ExchangeName;
        ok: boolean;
        errCode?: string;
        error?: string;
        lastOkTs?: number;
        snapshot?: any;
        assets: { USDT: number; BNB: number; PEPEW: number };
    }> = [];

    for (const ex of supportedExchanges) {
        const keyRecord = getExchangeKey(tgUserId, ex);
        if (!keyRecord) {
            balances.push({
                exchangeId: ex,
                ok: false,
                errCode: "NO_KEYS",
                error: "No API keys configured",
                assets: { USDT: 0, BNB: 0, PEPEW: 0 },
            });
            continue;
        }

        try {
            const decrypted = decryptKeyPair({
                keyCipher: keyRecord.key_cipher,
                secretCipher: keyRecord.secret_cipher,
                iv: keyRecord.iv,
                tag: keyRecord.tag,
            });
            const bal = await getNormalizedBalances(ex, decrypted.apiKey, decrypted.apiSecret, tgUserId);
            const meta = getLastBalanceMeta(ex, decrypted.apiKey, tgUserId);
            balances.push({
                exchangeId: ex,
                ok: bal.ok,
                errCode: bal.errCode || bal.reason || meta.lastErrCode,
                error: bal.error || meta.lastErrMsg,
                lastOkTs: bal.lastOkTs || meta.lastOkTs,
                snapshot: bal.snapshot,
                assets: bal.assets,
            });
        } catch (err: any) {
            balances.push({
                exchangeId: ex,
                ok: false,
                errCode: "BALANCE_FETCH_FAILED",
                error: err?.message || String(err),
                assets: { USDT: 0, BNB: 0, PEPEW: 0 },
            });
        }
    }

    return balances;
}

type ReportPeriod = "daily" | "weekly" | "monthly";
type ReportExchange = "nonkyc" | "dextrade" | "nestex";
type StrategyReportKey = "dca" | "grid" | "mm" | "devmm" | "total";

type StrategyReportMetric = {
    strategy: StrategyReportKey;
    fillCount: number;
    fillBuyCount: number;
    fillSellCount: number;
    orderCount: number;
    orderBuyCount: number;
    orderSellCount: number;
    quoteVolume: number;
    baseVolume: number;
    fee: number;
    netQuote: number;
};

function getIsoWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function resolveReportWindow(period: ReportPeriod, now = Date.now()): { startTs: number; endTs: number; bucket: string } {
    const offsetMs = 8 * 60 * 60 * 1000;
    const localNow = new Date(now + offsetMs);
    const year = localNow.getUTCFullYear();
    const month = localNow.getUTCMonth();
    const date = localNow.getUTCDate();
    let startLocalTs = 0;
    let endLocalTs = 0;
    let bucket = "";

    if (period === "daily") {
        startLocalTs = Date.UTC(year, month, date);
        endLocalTs = Date.UTC(year, month, date + 1);
        bucket = localNow.toISOString().slice(0, 10);
    } else if (period === "weekly") {
        const weekday = localNow.getUTCDay() || 7;
        const mondayDate = date - weekday + 1;
        startLocalTs = Date.UTC(year, month, mondayDate);
        endLocalTs = Date.UTC(year, month, mondayDate + 7);
        bucket = `${year}-W${String(getIsoWeek(localNow)).padStart(2, "0")}`;
    } else {
        startLocalTs = Date.UTC(year, month, 1);
        endLocalTs = Date.UTC(year, month + 1, 1);
        bucket = `${year}-${String(month + 1).padStart(2, "0")}`;
    }

    return {
        startTs: startLocalTs - offsetMs,
        endTs: endLocalTs - offsetMs,
        bucket,
    };
}

function zeroMetric(strategy: StrategyReportKey): StrategyReportMetric {
    return {
        strategy,
        fillCount: 0,
        fillBuyCount: 0,
        fillSellCount: 0,
        orderCount: 0,
        orderBuyCount: 0,
        orderSellCount: 0,
        quoteVolume: 0,
        baseVolume: 0,
        fee: 0,
        netQuote: 0,
    };
}

// POST /v1/strategy/config/upsert
router.post("/v1/strategy/config/upsert", (req, res) => {
    try {
        const parsed = StrategyUpsertSchema.parse(req.body);
        const tradeMode = "REAL";
        const strategy = parsed.strategy;

        let normalizedExchangeId: ExchangeName;
        let pairDisplay: string;
        try {
            const requestedExchangeId = parsed.exchange;
            normalizedExchangeId = normalizeExchangeId(requestedExchangeId);
            const resolvedSpec = getExchangeSpec(normalizedExchangeId);
            if (requestedExchangeId !== normalizedExchangeId || resolvedSpec.adapterKey !== normalizedExchangeId) {
                return res.status(400).json({
                    ok: false,
                    error: "EXCHANGE_RESOLVE_GUARD_FAILED",
                    details: {
                        requestedExchangeId,
                        normalizedExchangeId,
                        resolvedExchangeId: resolvedSpec.exchangeId,
                        adapterKey: resolvedSpec.adapterKey,
                    },
                });
            }

            const parsedPair = parsePair(parsed.pair);
            const normalizedSymbol = normalizePairSymbol(normalizedExchangeId, parsedPair.canonicalPair);
            if (!normalizedSymbol || !validatePair(normalizedExchangeId, normalizedSymbol)) {
                return res.status(400).json({
                    ok: false,
                    error: "UNSUPPORTED_PAIR",
                    message: `UNSUPPORTED_PAIR: exchangeId=${normalizedExchangeId} canonicalPair=${parsedPair.canonicalPair}`,
                });
            }
            pairDisplay = formatPairDisplay(normalizedExchangeId, normalizedSymbol);
        } catch (err: any) {
            return res.status(400).json({ ok: false, error: err?.code || "INVALID_PAIR", message: err?.message || "Invalid pair" });
        }

        let paramsJson = parsed.paramsJson;
        if (!paramsJson && parsed.params) {
            paramsJson = JSON.stringify(parsed.params);
        }
        if (!paramsJson) {
            return res.status(400).json({ ok: false, error: "params or paramsJson is required" });
        }

        const config = upsertStrategyConfig({
            tgUserId: parsed.tgUserId,
            exchange: normalizedExchangeId,
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
        const updated = parsed.reason
            ? setStrategyDisabledWithReason(configId, parsed.tgUserId, parsed.reason)
            : setStrategyEnabledById(configId, parsed.tgUserId, false);
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

        const balanceSummary = await collectBalanceSummaryForUser(tgUserId);
        const balances: NormalizedBalance[] = balanceSummary.map((b) => ({
            ok: b.ok,
            exchange: b.exchangeId,
            assets: b.assets,
            reason: b.errCode,
            errCode: b.errCode,
            error: b.error,
            lastOkTs: b.lastOkTs,
            snapshot: b.snapshot,
        }));

        // Shared balance logic (legacy support for NonKYC debug)
        const nonKycBal = balances.find(b => b.exchange === "nonkyc" && b.ok);
        const sharedBalance = nonKycBal ? {
            data: { freeQuote: nonKycBal.assets.USDT || nonKycBal.assets.BNB, freePEPEW: nonKycBal.assets.PEPEW },
            metadata: { fetchedAt: Date.now(), cacheAgeMs: 0, isCached: false, symbolsFound: ["USDT", "BNB", "PEPEW"] }
        } : null;

        const debugEnabled = process.env.TRADE_DEBUG_STATUS === "1" || req.query.debug === "1";

        res.json({
            ok: true,
            balances,
            debug: (debugEnabled && sharedBalance) ? {
                balance_source: "Multi",
                fetchedAt: sharedBalance.metadata.fetchedAt,
                cacheAgeMs: sharedBalance.metadata.cacheAgeMs,
                isCached: sharedBalance.metadata.isCached,
                symbolsFound: sharedBalance.metadata.symbolsFound,
                freeQuote: sharedBalance.data.freeQuote,
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

                const failureDetails = failure?.details_json ? safeParseJson(failure.details_json) ?? failure.details_json : null;
                const failureCategory = failure && failure.category === "UNKNOWN"
                    ? classifyExchangeError(config.exchange as ExchangeName, {
                        httpStatus: failure.last_http_status ?? undefined,
                        message: failure.message,
                        code: failure.last_exchange_code ?? undefined,
                    }).category
                    : failure?.category;

                // Find balance for this specific config's exchange
                const exBal = balances.find(b => b.exchange === config.exchange);

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
                    disabledReason: config.disabled_reason,
                    consecutiveFailures: config.consecutive_failures,
                    lastAction: (lastEvent?.message || null),
                    lastActionAt: lastEvent?.ts || null,
                    inventoryWarning: (exBal && exBal.ok && lastEvent?.message?.includes("have 0"))
                        ? (function () {
                            const msg = lastEvent?.message || "";
                            const isBNB = config.pair.toUpperCase().endsWith("BNB");
                            const freeQuote = exBal.assets.USDT || exBal.assets.BNB || 0;
                            if (msg.includes("BUY") && freeQuote > 0) {
                                return `DISCREPANCY DETECTED: Action reports "have 0 ${isBNB ? "BNB" : "USDT"}" but current balance is ${freeQuote.toFixed(4)}.`;
                            }
                            if (msg.includes("SELL") && exBal.assets.PEPEW > 0) {
                                return `DISCREPANCY DETECTED: Action reports "have 0 PEPEW" but current balance is ${exBal.assets.PEPEW.toExponential(2)} PEPEW.`;
                            }
                            return null;
                        })()
                        : null,
                    currentInventory: (exBal && exBal.ok)
                        ? {
                            PEPEW: exBal.assets.PEPEW,
                            Quote: exBal.assets.USDT || exBal.assets.BNB || 0,
                            fetchedAt: Date.now()
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

// GET /v1/strategy/report?tg_user_id=...&exchange=...&period=...
router.get("/v1/strategy/report", (req, res) => {
    try {
        const tgUserId = String(req.query.tg_user_id || req.query.tgUserId || "").trim();
        const exchange = String(req.query.exchange || "").trim().toLowerCase() as ReportExchange;
        const period = String(req.query.period || "daily").trim().toLowerCase() as ReportPeriod;

        if (!tgUserId) {
            return res.status(400).json({ ok: false, error: "tg_user_id query param required" });
        }
        if (!["nonkyc", "dextrade", "nestex"].includes(exchange)) {
            return res.status(400).json({ ok: false, error: "INVALID_EXCHANGE" });
        }
        if (!["daily", "weekly", "monthly"].includes(period)) {
            return res.status(400).json({ ok: false, error: "INVALID_PERIOD" });
        }

        const { startTs, endTs, bucket } = resolveReportWindow(period);
        const rows = db.prepare(`
            SELECT
                UPPER(TRIM(o.strategy)) AS strategy,
                COUNT(f.id) AS fill_count,
                COUNT(CASE WHEN UPPER(TRIM(o.side)) = 'BUY' THEN f.id END) AS fill_buy_count,
                COUNT(CASE WHEN UPPER(TRIM(o.side)) = 'SELL' THEN f.id END) AS fill_sell_count,
                COUNT(DISTINCT f.order_id) AS order_count,
                COUNT(DISTINCT CASE WHEN UPPER(TRIM(o.side)) = 'BUY' THEN f.order_id END) AS order_buy_count,
                COUNT(DISTINCT CASE WHEN UPPER(TRIM(o.side)) = 'SELL' THEN f.order_id END) AS order_sell_count,
                SUM(f.qty) AS base_volume,
                SUM(f.price * f.qty) AS quote_volume,
                SUM(COALESCE(f.fee, 0)) AS fee_total,
                SUM(CASE WHEN UPPER(TRIM(o.side)) = 'SELL' THEN (f.price * f.qty) ELSE 0 END)
                - SUM(CASE WHEN UPPER(TRIM(o.side)) = 'BUY' THEN (f.price * f.qty) ELSE 0 END)
                - SUM(COALESCE(f.fee, 0)) AS net_quote
            FROM trade_strategy_fill f
            JOIN trade_strategy_order o ON o.id = f.order_id
            WHERE o.tg_user_id = ?
              AND LOWER(TRIM(o.exchange)) = ?
              AND f.ts >= ?
              AND f.ts < ?
            GROUP BY UPPER(TRIM(o.strategy))
        `).all(tgUserId, exchange, startTs, endTs) as Array<{
            strategy: string;
            fill_count: number;
            fill_buy_count: number;
            fill_sell_count: number;
            order_count: number;
            order_buy_count: number;
            order_sell_count: number;
            base_volume: number;
            quote_volume: number;
            fee_total: number;
            net_quote: number;
        }>;

        const report: Record<StrategyReportKey, StrategyReportMetric> = {
            dca: zeroMetric("dca"),
            grid: zeroMetric("grid"),
            mm: zeroMetric("mm"),
            devmm: zeroMetric("devmm"),
            total: zeroMetric("total"),
        };

        for (const row of rows) {
            const strategy = row.strategy === "DCA"
                ? "dca"
                : row.strategy === "GRID"
                    ? "grid"
                    : row.strategy === "MM"
                        ? "mm"
                        : null;
            if (!strategy) continue;
            report[strategy] = {
                strategy,
                fillCount: Number(row.fill_count || 0),
                fillBuyCount: Number(row.fill_buy_count || 0),
                fillSellCount: Number(row.fill_sell_count || 0),
                orderCount: Number(row.order_count || 0),
                orderBuyCount: Number(row.order_buy_count || 0),
                orderSellCount: Number(row.order_sell_count || 0),
                quoteVolume: Number(row.quote_volume || 0),
                baseVolume: Number(row.base_volume || 0),
                fee: Number(row.fee_total || 0),
                netQuote: Number(row.net_quote || 0),
            };
        }

        const devmm = getDevmmReport(exchange, period, bucket);
        if (devmm) {
            const devmmFee = Number(devmm.totalFeeUsdt || 0);
            report.devmm = {
                strategy: "devmm",
                fillCount: Number(devmm.fillCount || 0),
                fillBuyCount: Number(devmm.buyFillCount || 0),
                fillSellCount: Number(devmm.sellFillCount || 0),
                orderCount: Number(devmm.fillCount || 0),
                orderBuyCount: Number(devmm.buyFillCount || 0),
                orderSellCount: Number(devmm.sellFillCount || 0),
                quoteVolume: Number(devmm.totalTurnoverUsdt || 0),
                baseVolume: Number((devmm.buyQtyPepew || 0) + (devmm.sellQtyPepew || 0)),
                fee: devmmFee,
                netQuote: Number((devmm.netUsdtChange || 0) - devmmFee),
            };
        }

        const total = zeroMetric("total");
        for (const key of ["dca", "grid", "mm", "devmm"] as const) {
            total.fillCount += report[key].fillCount;
            total.fillBuyCount += report[key].fillBuyCount;
            total.fillSellCount += report[key].fillSellCount;
            total.orderCount += report[key].orderCount;
            total.orderBuyCount += report[key].orderBuyCount;
            total.orderSellCount += report[key].orderSellCount;
            total.quoteVolume += report[key].quoteVolume;
            total.baseVolume += report[key].baseVolume;
            total.fee += report[key].fee;
            total.netQuote += report[key].netQuote;
        }
        report.total = total;

        console.log(
            `[strategy] report period=${period} exchange=${exchange} user=${tgUserId.slice(0, 8)}... totals=${JSON.stringify({
                dca: report.dca.quoteVolume,
                grid: report.grid.quoteVolume,
                mm: report.mm.quoteVolume,
                devmm: report.devmm.quoteVolume,
                total: report.total.quoteVolume,
            })}`
        );

        return res.json({
            ok: true,
            period,
            exchange,
            bucket,
            report,
        });
    } catch (err: any) {
        console.error(`[strategy] report error: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
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

        // Get API keys
        const keyRecord = getExchangeKey(parsed.tgUserId, parsed.exchange);
        if (!keyRecord) {
            return res.status(400).json({
                ok: false,
                error: "MISSING_KEYS",
                message: `No API keys set for ${parsed.exchange}. Use /keys first.`,
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

        const { performFundsCheck } = await import("../lib/fundsCheck.js");
        const check = await performFundsCheck(
            parsed.strategy,
            parsed.params,
            parsed.exchange as ExchangeName,
            parsed.pair,
            accessKey,
            secretKey
        );

        if (!check) {
            return res.status(500).json({
                ok: false,
                error: "BALANCE_FETCH_FAILED",
                message: `Could not fetch ${parsed.exchange} account balance`,
            });
        }

        console.log(`[strategy] funds-check: user=${parsed.tgUserId.slice(0, 8)}... strategy=${parsed.strategy} exchange=${parsed.exchange} status=${check.status}`);

        res.json({
            ok: true,
            status: check.status,
            messages: check.messages,
            need: check.need,
            available: check.available,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input", details: err.errors });
        }
        console.error(`[strategy] funds-check error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/balance?tgUserId=...&exchange=...
router.get("/v1/balance", async (req, res) => {
    try {
        const tgUserId = (req.query.tgUserId || req.query.tg_user_id) as string;
        const exchange = req.query.exchange as ExchangeName;

        if (!tgUserId || !exchange) {
            return res.status(400).json({ ok: false, error: "tgUserId and exchange query params required" });
        }

        const keyRecord = getExchangeKey(tgUserId, exchange);
        if (!keyRecord) {
            return res.status(400).json({
                ok: false,
                error: "MISSING_KEYS",
                message: `No API keys set for ${exchange}`,
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

        const balanceResult = await getNormalizedBalances(exchange, accessKey, secretKey, tgUserId);
        if (!balanceResult.ok) {
            return res.status(500).json(balanceResult);
        }

        res.json(balanceResult);
    } catch (err: any) {
        console.error(`[strategy] balance error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/balances/summary?tgUserId=...
router.get("/v1/balances/summary", async (req, res) => {
    try {
        const tgUserId = (req.query.tgUserId || req.query.tg_user_id) as string;
        if (!tgUserId) {
            return res.status(400).json({ ok: false, error: "tgUserId query param required" });
        }
        const balances = await collectBalanceSummaryForUser(tgUserId);
        return res.json({
            ok: true,
            exchanges: balances.map((b) => ({
                exchangeId: b.exchangeId,
                ok: b.ok,
                errCode: b.errCode || null,
                errMsgShort: b.error ? String(b.error).slice(0, 220) : null,
                lastOkTs: b.lastOkTs || null,
                snapshot: b.snapshot || null,
                assets: b.assets,
            })),
        });
    } catch (err: any) {
        console.error(`[strategy] balances summary error: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /v1/registry/exchanges
router.get("/v1/registry/exchanges", (_req, res) => {
    const exchanges = listExchangeSpecs().map((spec) => ({
        exchangeId: spec.exchangeId,
        displayName: spec.displayName,
        adapterKey: spec.adapterKey,
        pairs: spec.pairs,
        symbolMapping: spec.symbolMapping,
        limits: spec.limits,
        precision: spec.precision,
    }));
    res.json({ ok: true, exchanges });
});

// GET /v1/balance/nonkyc?tgUserId=... (DEPRECATED: use /v1/balance)
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

        const balanceResult = await getNormalizedBalances("nonkyc", accessKey, secretKey, tgUserId);
        if (!balanceResult.ok) {
            return res.status(500).json(balanceResult);
        }

        res.json({
            ok: true,
            exchange: "nonkyc",
            freeQuote: balanceResult.assets.USDT || balanceResult.assets.BNB,
            freePEPEW: balanceResult.assets.PEPEW,
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

        // Respond immediately; run cancellation in background.
        res.json({
            ok: true,
            queued: true,
            message: "Cancellation queued",
        });

        setImmediate(async () => {
            try {
                const result = await cancelOutstandingOrders(configId);
                cancelOpenStrategyOrders(configId);
                if (config.strategy === "GRID") cancelOpenGridOrders(configId);
                console.log(
                    `[strategy] cancel-orders done config=${configId} cancelled=${result.cancelled} failed=${result.failed} alreadyClosed=${result.alreadyClosed}`
                );
            } catch (err: any) {
                console.error(`[strategy] cancel-orders async error: ${err?.message || err}`);
            }
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
