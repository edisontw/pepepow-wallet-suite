/**
 * DevMM Runner - Dev Fee Market Making Strategy
 * 
 * Purpose: Provide micro-liquidity depth for PEPEW/USDT by maintaining
 * 1 buy + 1 sell order using post-only limits. Primary goal is depth/activity,
 * secondary is gradual USDT conversion at low market impact.
 * 
 * Supported exchanges: NonKYC, Dex-Trade, NestEx
 */

import {
    DevmmConfig,
    DevmmExchange,
    getDevmmConfigById,
    getDevmmState,
    getExchangeKey,
    incrementDevmmTurnover,
    insertTradeAudit,
    insertDevmmFill,
    resetDevmmTurnover,
    setDevmmStatus,
    updateDevmmAction,
    updateDevmmError,
    upsertDevmmState,
} from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { StrategyRunner } from "./types.js";
import { ExchangeName } from "../lib/markets.js";
import {
    createNonKycOrder,
    cancelNonKycOrder,
    getNonKycOrderById,
    listNonKycOpenOrders,
} from "../exchanges/nonkyc.js";
import {
    createDexTradeOrder,
    cancelDexTradeOrder,
    listDexTradeOpenOrders,
} from "../exchanges/dextrade.js";
import {
    placeNestExLimitOrder,
    cancelNestExOrder,
    listNestExOpenOrders,
    resolveNestExSymbol,
} from "../exchanges/nestex.js";
import { getLastBalanceMeta, getNormalizedBalances } from "../lib/balanceHelper.js";
import { fetchAggregatedPrice, fetchExchangePrice, fetchExchangeTopOfBook } from "./price.js";
import { fetchNestExOrderbookTop } from "../lib/price/sources/nestex.js";
import { logStrategyTickContract } from "./logContract.js";
import { getExchangeSpec, getPairLimits } from "../registry/exchanges.js";
import {
    DevmmIssueCode,
    DevmmPauseReason,
    DevmmSkipReason,
    mapPauseReasonToIssueCode,
    mapSkipReasonToIssueCode,
} from "./devmmCodes.js";
import { tradeLog } from "../lib/tradeLogger.js";

// Per-exchange lock to avoid overlapping ticks
const runningExchanges = new Set<DevmmExchange>();

// Track cancellation failures to avoid infinite retry loops
const cancelFailures = new Map<string, number>(); // orderId -> failureCount

// Reference samples for EMA calculation (keep last 60 minutes of samples)
const refSamples = new Map<DevmmExchange, number[]>();

const SUPPORTED_EXCHANGES: DevmmExchange[] = ["nonkyc", "dextrade", "nestex"];
const BALANCE_STALE_OK_MS = Number(process.env.DEVMM_BALANCE_STALE_OK_MS || 300000);
const DEVMM_BALANCE_FAIL_SOFT_MAX = Number(process.env.DEVMM_BALANCE_FAIL_SOFT_MAX || 3);
const DEVMM_FORCE_SPREAD_TICKS = Math.max(1, Number(process.env.DEVMM_FORCE_SPREAD_TICKS || 1));
const DEVMM_MAX_NEW_ORDERS_PER_TICK = Math.max(1, Number(process.env.DEVMM_MAX_NEW_ORDERS_PER_TICK || 2));
const DEVMM_VISIBILITY_GRACE_MS = Math.max(1_000, Number(process.env.DEVMM_VISIBILITY_GRACE_MS || 90_000));
const DEVMM_VISIBILITY_GRACE_MS_NESTEX = Math.max(
    DEVMM_VISIBILITY_GRACE_MS,
    Number(process.env.DEVMM_VISIBILITY_GRACE_MS_NESTEX || 600_000)
);
const DEVMM_MAX_OPEN_ORDERS_SOFT = Math.max(1, Number(process.env.DEVMM_MAX_OPEN_ORDERS_SOFT || 4));
const DEVMM_DEXTRADE_STALE_REFRESH_MS = Math.max(
    60_000,
    Number(process.env.DEVMM_DEXTRADE_STALE_REFRESH_MS || 600_000)
);
const DEVMM_BOOTSTRAP_ENABLED = process.env.DEVMM_BOOTSTRAP_ENABLED !== "0" && process.env.DEVMM_BOOTSTRAP_ENABLED !== "false";
const DEVMM_BOOTSTRAP_WINDOW_MS = Math.max(1_000, Number(process.env.DEVMM_BOOTSTRAP_WINDOW_MS || 120_000));
const DEVMM_BOOTSTRAP_ORDERS_PER_SIDE = 1;
const DEVMM_BOOTSTRAP_BYPASS_DAILY_CAP =
    process.env.DEVMM_BOOTSTRAP_BYPASS_DAILY_CAP !== "0" && process.env.DEVMM_BOOTSTRAP_BYPASS_DAILY_CAP !== "false";
const DEVMM_TARGET_MIN_ORDERS = Math.max(1, Number(process.env.DEVMM_TARGET_MIN_ORDERS || 2));
const NESTEX_TARGET_NOTIONAL_USDT = 1;

// Log control: avoid spamming on every tick
const DEBUG_DEVMM = process.env.DEBUG_DEVMM === "1" || process.env.DEBUG_DEVMM === "true";
const DEVMM_LOG_THROTTLE_SEC = Math.max(5, Number(process.env.LOG_THROTTLE_SEC || 30));
const DEVMM_SKIP_AUDIT_THROTTLE_MS = Math.max(5_000, Number(process.env.DEVMM_SKIP_AUDIT_THROTTLE_MS || 30_000));
const devmmSkipAuditAt = new Map<string, number>();

function buildDevmmThrottleKey(exchange: DevmmExchange, message: string): string | null {
    const upper = String(message || "").toUpperCase();
    if (!upper) return null;

    const reasonMatch = upper.match(/SKIP_TICK:([A-Z0-9_]+)/);
    if (reasonMatch?.[1]) return `skip:${exchange}:${reasonMatch[1]}`;
    const orderResultMatch = upper.match(/ORDERRESULT\\s+PHASE=([A-Z_]+)\\s+SIDE=([A-Z_]+)\\s+RESULT=([A-Z_]+)/);
    if (orderResultMatch?.[3]) return `orderResult:${exchange}:${orderResultMatch[2]}:${orderResultMatch[3]}`;

    if (upper.startsWith("TICK STRATEGYID=")) return `tick:${exchange}`;
    if (upper.startsWith("OPENORDERS ")) return `openOrders:${exchange}`;
    if (upper.startsWith("ORDERATTEMPT ")) return `orderAttempt:${exchange}`;
    if (upper.includes("PAUSED:")) return `paused:${exchange}:${upper.replace(/[^A-Z0-9_]+/g, "_").slice(0, 64)}`;
    return null;
}

function extractStrategyIdFromMessage(message: string): number | null {
    const match = String(message || "").match(/(?:strategyId|config|id)=(\\d+)/i);
    if (!match?.[1]) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

function shouldRecordDevmmSkipAudit(exchange: DevmmExchange, reason: string, now: number): boolean {
    const key = `${exchange}:${reason}`;
    const prev = devmmSkipAuditAt.get(key) || 0;
    if (now - prev < DEVMM_SKIP_AUDIT_THROTTLE_MS) return false;
    devmmSkipAuditAt.set(key, now);
    return true;
}

function log(level: "info" | "debug" | "error", exchange: DevmmExchange, message: string): void {
    const strategyId = extractStrategyIdFromMessage(message);
    const throttleKey = buildDevmmThrottleKey(exchange, message);
    tradeLog({
        scope: "devmmRunner",
        level,
        strategyId: strategyId ?? null,
        exchange,
        message,
        throttleKey: throttleKey || undefined,
        throttleSec: throttleKey ? DEVMM_LOG_THROTTLE_SEC : undefined,
        // Keep backward compatibility for short-term deep debugging.
        force: level === "debug" && DEBUG_DEVMM,
    });
}

// Timezone helper for Asia/Taipei (UTC+8)
function getTaipeiBuckets(): { day: string; hour: string } {
    const now = Date.now();
    const d = new Date(now + 8 * 60 * 60 * 1000);
    const day = d.toISOString().slice(0, 10);
    const hour = d.toISOString().slice(0, 13);
    return { day, hour };
}

// Round value to tick/step
function roundToTick(value: number, tick: number): number {
    if (tick <= 0 || !Number.isFinite(tick)) return value;
    return Math.round(value / tick) * tick;
}

function floorToTick(value: number, tick: number): number {
    if (tick <= 0 || !Number.isFinite(tick)) return value;
    return Math.floor(value / tick) * tick;
}

function ceilToTick(value: number, tick: number): number {
    if (tick <= 0 || !Number.isFinite(tick)) return value;
    return Math.ceil(value / tick) * tick;
}

function roundToStep(value: number, step: number): number {
    if (step <= 0 || !Number.isFinite(step)) return value;
    return Math.floor(value / step) * step;
}

function resolveOrderQuote(exchange: DevmmExchange, configuredOrderQuote: number): number {
    if (exchange === "nestex") return NESTEX_TARGET_NOTIONAL_USDT;
    return configuredOrderQuote;
}

function inferTickFromPrice(price: number, maxDecimals = 12): number | null {
    if (!Number.isFinite(price) || price <= 0) return null;
    const fixed = price.toFixed(maxDecimals);
    const dot = fixed.indexOf(".");
    if (dot === -1) return 1;
    const frac = fixed.slice(dot + 1).replace(/0+$/, "");
    if (!frac.length) return 1;
    return Math.pow(10, -frac.length);
}

function resolvePriceTick(baseTick: number, candidates: Array<number | null | undefined>): number {
    if (Number.isFinite(baseTick) && baseTick > 0) return baseTick;
    for (const candidate of candidates) {
        if (!Number.isFinite(candidate as number) || (candidate as number) <= 0) continue;
        const inferred = inferTickFromPrice(candidate as number);
        if (Number.isFinite(inferred as number) && (inferred as number) > 0) {
            return inferred as number;
        }
    }
    return 1e-8;
}

function normalizePercentRatio(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    if (value >= 1) return value / 100;
    return value;
}

type PendingOrderSide = "BUY" | "SELL";
type PendingOrder = {
    orderId: string;
    clientOrderId?: string;
    side: PendingOrderSide;
    createdAt: number;
    expiresAt: number;
};

const pendingOrdersByExchange = new Map<DevmmExchange, PendingOrder[]>();
const locallyPlacedOrderIdsByExchange = new Map<DevmmExchange, Set<string>>();
const lastPlacedSideByExchange = new Map<DevmmExchange, PendingOrderSide>();

type DevmmPhase = "BOOTSTRAP" | "NORMAL";

type DevmmBootstrapLifecycle = {
    startedAt: number;
    done: boolean;
    doneAt: number | null;
    firstTickHandled: boolean;
    lastPhase: DevmmPhase;
    lastBypassedDailyCap: boolean;
};

const bootstrapStateByKey = new Map<string, DevmmBootstrapLifecycle>();

function getBootstrapKey(exchange: DevmmExchange, symbol: string): string {
    return `${exchange}:${symbol}`;
}

export function resetDevmmBootstrapState(exchange: DevmmExchange, symbol = "PEPEW/USDT"): void {
    bootstrapStateByKey.delete(getBootstrapKey(exchange, symbol));
}

export function markDevmmBootstrapStarted(exchange: DevmmExchange, symbol = "PEPEW/USDT", startedAt = Date.now()): void {
    bootstrapStateByKey.set(getBootstrapKey(exchange, symbol), {
        startedAt,
        done: false,
        doneAt: null,
        firstTickHandled: false,
        lastPhase: "BOOTSTRAP",
        lastBypassedDailyCap: false,
    });
}

export function getDevmmBootstrapSnapshot(
    exchange: DevmmExchange,
    symbol = "PEPEW/USDT"
): {
    phase: DevmmPhase;
    bootstrapDone: boolean;
    bootstrapBypassActive: boolean;
    bootstrapStartedAt: number | null;
} {
    const state = bootstrapStateByKey.get(getBootstrapKey(exchange, symbol));
    if (!state) {
        return {
            phase: "NORMAL",
            bootstrapDone: false,
            bootstrapBypassActive: false,
            bootstrapStartedAt: null,
        };
    }
    return {
        phase: state.lastPhase,
        bootstrapDone: state.done,
        bootstrapBypassActive: state.lastBypassedDailyCap,
        bootstrapStartedAt: state.startedAt,
    };
}

function ensureBootstrapLifecycle(
    exchange: DevmmExchange,
    symbol: string,
    now: number,
    lastAction: string | null | undefined,
    lastActionAt: number | null | undefined
): DevmmBootstrapLifecycle {
    const key = getBootstrapKey(exchange, symbol);
    const existing = bootstrapStateByKey.get(key);
    const hasStartMarker = lastAction === "started" && Number.isFinite(lastActionAt as number) && (lastActionAt as number) > 0;
    const startMarker = hasStartMarker
        ? (lastActionAt as number)
        : existing?.startedAt ?? now;

    if (!existing || (hasStartMarker && startMarker > existing.startedAt + 1000)) {
        const next: DevmmBootstrapLifecycle = {
            startedAt: startMarker,
            done: false,
            doneAt: null,
            firstTickHandled: false,
            lastPhase: DEVMM_BOOTSTRAP_ENABLED ? "BOOTSTRAP" : "NORMAL",
            lastBypassedDailyCap: false,
        };
        bootstrapStateByKey.set(key, next);
        return next;
    }

    return existing;
}

function getVisibilityGraceMs(exchange: DevmmExchange): number {
    return exchange === "nestex" ? DEVMM_VISIBILITY_GRACE_MS_NESTEX : DEVMM_VISIBILITY_GRACE_MS;
}

export function getDevmmPendingCount(exchange: DevmmExchange): number {
    return pruneAndGetPendingOrders(exchange, Date.now()).length;
}

function pruneAndGetPendingOrders(exchange: DevmmExchange, now: number): PendingOrder[] {
    const current = pendingOrdersByExchange.get(exchange) || [];
    const active = current.filter(o => o.expiresAt > now);
    if (active.length > 0) {
        pendingOrdersByExchange.set(exchange, active);
    } else {
        pendingOrdersByExchange.delete(exchange);
    }
    return active;
}

function addPendingOrder(exchange: DevmmExchange, order: { orderId: string; clientOrderId?: string; side: PendingOrderSide }, now: number): void {
    const active = pruneAndGetPendingOrders(exchange, now);
    const existingIndex = active.findIndex(o => o.orderId === String(order.orderId));
    const visibilityGraceMs = getVisibilityGraceMs(exchange);
    const entry: PendingOrder = {
        orderId: String(order.orderId),
        clientOrderId: order.clientOrderId,
        side: order.side,
        createdAt: now,
        expiresAt: now + visibilityGraceMs,
    };
    if (existingIndex >= 0) {
        // Do not extend visibility TTL on repeated re-adds; otherwise pending can become permanent.
        const existing = active[existingIndex];
        active[existingIndex] = {
            ...existing,
            side: entry.side,
            clientOrderId: entry.clientOrderId || existing.clientOrderId,
        };
    } else {
        active.push(entry);
    }
    pendingOrdersByExchange.set(exchange, active);
}

function removePendingOrders(exchange: DevmmExchange, orderId: string | null | undefined): void {
    if (!orderId) return;
    const active = pendingOrdersByExchange.get(exchange) || [];
    if (active.length === 0) return;
    const filtered = active.filter(o => o.orderId !== orderId);
    if (filtered.length > 0) {
        pendingOrdersByExchange.set(exchange, filtered);
    } else {
        pendingOrdersByExchange.delete(exchange);
    }
}

function reconcilePendingWithVisibleOrders(
    exchange: DevmmExchange,
    now: number,
    visibleOrders: Array<{ id: string; clientOrderId?: string }>
): PendingOrder[] {
    const active = pruneAndGetPendingOrders(exchange, now);
    if (active.length === 0 || visibleOrders.length === 0) return active;

    const visibleIds = new Set(visibleOrders.map(o => String(o.id)));
    const visibleClientIds = new Set(
        visibleOrders
            .map(o => (o.clientOrderId ? String(o.clientOrderId) : ""))
            .filter(Boolean)
    );

    const filtered = active.filter(o => {
        if (visibleIds.has(o.orderId)) return false;
        if (o.clientOrderId && visibleClientIds.has(o.clientOrderId)) return false;
        return true;
    });

    if (filtered.length > 0) {
        pendingOrdersByExchange.set(exchange, filtered);
    } else {
        pendingOrdersByExchange.delete(exchange);
    }
    return filtered;
}

function markLocallyPlacedOrder(exchange: DevmmExchange, orderId: string): void {
    const current = locallyPlacedOrderIdsByExchange.get(exchange) || new Set<string>();
    current.add(String(orderId));
    locallyPlacedOrderIdsByExchange.set(exchange, current);
}

function wasLocallyPlacedOrder(exchange: DevmmExchange, orderId: string | null | undefined): boolean {
    if (!orderId) return false;
    const current = locallyPlacedOrderIdsByExchange.get(exchange);
    return !!current && current.has(String(orderId));
}

function clearLocallyPlacedOrder(exchange: DevmmExchange, orderId: string | null | undefined): void {
    if (!orderId) return;
    const current = locallyPlacedOrderIdsByExchange.get(exchange);
    if (!current || !current.has(String(orderId))) return;
    current.delete(String(orderId));
    if (current.size > 0) {
        locallyPlacedOrderIdsByExchange.set(exchange, current);
    } else {
        locallyPlacedOrderIdsByExchange.delete(exchange);
    }
}

// Calculate simple EMA
function calcEMA(samples: number[], period: number): number | null {
    if (samples.length === 0) return null;
    if (samples.length < period) {
        return samples.reduce((a, b) => a + b, 0) / samples.length;
    }
    const k = 2 / (period + 1);
    let ema = samples[0];
    for (let i = 1; i < samples.length; i++) {
        ema = samples[i] * k + ema * (1 - k);
    }
    return ema;
}

function buildDevmmClientOrderId(configId: number): string {
    return `PPW-DEVMM-${configId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function isSupportedExchange(exchange: string): exchange is DevmmExchange {
    return SUPPORTED_EXCHANGES.includes(exchange as DevmmExchange);
}

function formatResponseSnippet(value: any, maxLen = 800): string {
    if (value === undefined || value === null) return "n/a";
    try {
        const text = JSON.stringify(value);
        if (text.length > maxLen) return `${text.slice(0, maxLen)}...`;
        return text;
    } catch {
        const fallback = String(value);
        if (fallback.length > maxLen) return `${fallback.slice(0, maxLen)}...`;
        return fallback;
    }
}

function normalizeOrderId(value: any): string {
    return String(value ?? "").trim().replace(/\.0+$/, "");
}

function normalizeOrderSide(value: any): "BUY" | "SELL" | "UNKNOWN" {
    if (typeof value === "number") {
        if (value === 0) return "BUY";
        if (value === 1) return "SELL";
    }
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw) return "UNKNOWN";
    if (raw === "0" || raw === "buy" || raw === "bid" || raw === "b") return "BUY";
    if (raw === "1" || raw === "sell" || raw === "ask" || raw === "s") return "SELL";
    if (raw.includes("buy") || raw.includes("bid")) return "BUY";
    if (raw.includes("sell") || raw.includes("ask")) return "SELL";
    return "UNKNOWN";
}

function toNumber(value: any): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function summarizeNonKycFinalOrder(data: any): {
    status: string;
    isCancelled: boolean;
    filledQty: number;
    fillPrice: number | null;
} {
    const status = String(data?.status ?? data?.order_status ?? data?.state ?? "").trim().toUpperCase();
    const isCancelled =
        status.includes("CANCEL") ||
        status.includes("EXPIRE") ||
        status.includes("REJECT") ||
        status.includes("VOID");
    const filledQtyRaw =
        toNumber(data?.filled_quantity) ??
        toNumber(data?.filledQty) ??
        toNumber(data?.executedQty) ??
        toNumber(data?.deal_stock) ??
        toNumber(data?.dealStock) ??
        toNumber(data?.executed_quantity) ??
        0;
    const avgPriceRaw =
        toNumber(data?.avg_price) ??
        toNumber(data?.avgPrice) ??
        toNumber(data?.average_price) ??
        toNumber(data?.price_avg);
    const dealMoney = toNumber(data?.deal_money) ?? toNumber(data?.dealMoney) ?? toNumber(data?.executed_notional);
    const fillPrice = avgPriceRaw ?? ((dealMoney !== null && filledQtyRaw > 0) ? (dealMoney / filledQtyRaw) : null);

    return {
        status,
        isCancelled,
        filledQty: filledQtyRaw > 0 ? filledQtyRaw : 0,
        fillPrice,
    };
}

function formatError(code: string, message?: string): string {
    if (!message) return code;
    const trimmed = message.trim();
    if (!trimmed) return code;
    return `${code}: ${trimmed}`;
}

function extractBalance(entry: any): number | null {
    if (!entry || typeof entry !== "object") return null;
    const candidates = [
        "availableForTrade",
        "available",
        "free",
        "balance",
        "availableBalance",
        "available_balance",
        "available_for_trade",
        "availableForWithdrawal",
        "available_for_withdrawal",
        "total",
        "totalBalance",
    ];
    for (const key of candidates) {
        if (Object.prototype.hasOwnProperty.call(entry, key)) {
            const value = toNumber((entry as any)[key]);
            if (value !== null) return value;
        }
    }
    return null;
}

function findAssetEntry(list: any[], asset: string): any | null {
    const target = asset.toUpperCase();
    for (const entry of list) {
        const symbol = String(entry?.symbol ?? entry?.currency ?? entry?.asset ?? entry?.coin ?? "").toUpperCase();
        if (symbol === target) return entry;
    }
    return null;
}

type NormalizedBalances = {
    free: Record<string, number>;
    locked: Record<string, number>;
    total: Record<string, number>;
};

function normalizeNestExBalances(payload: any): NormalizedBalances | null {
    if (!payload) return null;
    const root = payload?.data ?? payload;
    const balances = root?.balances ?? root?.data?.balances;
    const locked = root?.locked ?? root?.data?.locked ?? {};

    if (balances && typeof balances === "object" && !Array.isArray(balances)) {
        const free: Record<string, number> = {};
        const lockedMap: Record<string, number> = {};
        const total: Record<string, number> = {};
        for (const [symbolRaw, value] of Object.entries(balances)) {
            const symbol = String(symbolRaw).toUpperCase();
            const available = toNumber(value);
            if (available === null) continue;
            const lockedValue = toNumber((locked as any)?.[symbolRaw]) ?? toNumber((locked as any)?.[symbol]) ?? 0;
            free[symbol] = available;
            lockedMap[symbol] = lockedValue;
            total[symbol] = available + lockedValue;
        }
        return Object.keys(free).length > 0 ? { free, locked: lockedMap, total } : null;
    }

    const list = Array.isArray(root)
        ? root
        : Array.isArray(root?.balances)
            ? root.balances
            : Array.isArray(root?.data?.balances)
                ? root.data.balances
                : null;

    if (!list) return null;

    const free: Record<string, number> = {};
    const lockedMap: Record<string, number> = {};
    const total: Record<string, number> = {};

    for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const symbol = String(entry?.symbol ?? entry?.currency ?? entry?.asset ?? entry?.coin ?? "").toUpperCase();
        if (!symbol) continue;
        const available = extractBalance(entry);
        if (available === null) continue;
        const lockedValue = toNumber((entry as any).locked ?? (entry as any).freeze ?? (entry as any).frozen) ?? 0;
        free[symbol] = available;
        lockedMap[symbol] = lockedValue;
        total[symbol] = available + lockedValue;
    }

    return Object.keys(free).length > 0 ? { free, locked: lockedMap, total } : null;
}

// Exchange-specific functions

interface OrderbookTop {
    bid: number | null;
    ask: number | null;
    status?: "OK" | "EMPTY" | "INVALID";
    forcedMid?: boolean;
    bookSource?: "orderbook" | "ticker_fallback" | "ticker_primary" | "ticker" | "mid_fallback";
}

type ManagedOpenOrder = {
    id: string;
    side: "BUY" | "SELL" | "UNKNOWN";
    clientOrderId?: string;
    price?: number | null;
    quantity?: number | null;
    filledQuantity?: number | null;
    createdAt?: number | null;
    status?: string | null;
};

interface BalanceResult {
    ok: boolean;
    usdt: number;
    pepew: number;
    errorCode?: string;
    errorMessage?: string;
    degraded?: boolean;
    source?: "live" | "cached";
    lastOkTs?: number;
    lastOkAgeSec?: number;
    failCount?: number;
}

interface OrderResult {
    ok: boolean;
    orderId?: string;
    error?: string;
    response?: any;
}

interface MarketRules {
    minNotional: number;
    minQty: number;
    qtyStep: number;
    priceTick: number;
}

interface DevmmQuotePlan {
    quoteMid: number;
    quoteAnchor: string;
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
}

type DexTradeStaleRefreshDeps = {
    cancelOrder: (orderId: string) => Promise<{ ok: boolean; error?: string | null }>;
    listOpenOrders: () => Promise<{ ok: boolean; orders: ManagedOpenOrder[]; error?: string | null }>;
    getFreshOrderbook: () => Promise<OrderbookTop>;
    placeOrder: (side: "BUY" | "SELL", price: number, qty: number, clientOrderId: string) => Promise<OrderResult>;
    buildQuotePlan?: (ob: OrderbookTop) => Promise<DevmmQuotePlan>;
    sleep?: (ms: number) => Promise<void>;
    onPendingAdd?: (orderId: string, clientOrderId: string, side: PendingOrderSide) => void;
    onPendingRemove?: (orderId: string) => void;
    onLocalPlacedAdd?: (orderId: string) => void;
    onLocalPlacedRemove?: (orderId: string) => void;
    onTrackedOrderChange?: (side: PendingOrderSide, orderId: string | null) => void;
    onLastPlacedSide?: (side: PendingOrderSide) => void;
    isStrategyEnabled?: () => boolean;
    audit?: (params: {
        action: "cancel" | "place" | "skip" | "error";
        side: PendingOrderSide;
        orderId?: string | null;
        price?: number | null;
        qty?: number | null;
        reason: string;
    }) => void;
    log?: (level: "info" | "debug" | "error", message: string) => void;
};

export interface DexTradeStaleRefreshResult {
    checked: boolean;
    shouldRefresh: boolean;
    suppressPlacement: boolean;
    rawOpenOrders: ManagedOpenOrder[];
    ageSec: number | null;
    outcome:
    | "not_applicable"
    | "not_stale"
    | "cancel_failed"
    | "cancel_not_confirmed"
    | "cancel_confirmed"
    | "repost_skipped"
    | "repost_placed"
    | "repost_pending_not_visible";
    reason: string;
    newOrderId?: string;
}

async function getOrderbook(exchange: DevmmExchange, accessKey: string, secretKey: string): Promise<OrderbookTop> {
    try {
        if (exchange === "nestex") {
            const book = await fetchNestExOrderbookTop();
            const status = book.status;
            return { bid: book.bestBid, ask: book.bestAsk, status, bookSource: book.bookSource };
        }

        // Use fetchExchangeTopOfBook for bid/ask data
        const topOfBook = await fetchExchangeTopOfBook(exchange as ExchangeName, "PEPEW/USDT");
        if (
            topOfBook?.bestBid !== null &&
            topOfBook?.bestAsk !== null &&
            topOfBook.bestBid > 0 &&
            topOfBook.bestAsk > 0
        ) {
            const source = topOfBook.source === "orderbook" ? "orderbook" : "ticker_fallback";
            return {
                bid: topOfBook.bestBid,
                ask: topOfBook.bestAsk,
                forcedMid: topOfBook.forcedMid,
                bookSource: source,
            };
        }
        // Fallback: try using price as mid
        const priceData = await fetchExchangePrice(exchange as ExchangeName, "PEPEW/USDT");
        if (priceData?.price && priceData.price > 0) {
            return { bid: priceData.price, ask: priceData.price, forcedMid: true, bookSource: "mid_fallback" };
        }
        return { bid: null, ask: null };
    } catch (err: any) {
        log("error", exchange, `getOrderbook failed: ${err.message}`);
        return { bid: null, ask: null };
    }
}

async function getBalances(exchange: DevmmExchange, accessKey: string, secretKey: string, rateLimitKey: string): Promise<BalanceResult> {
    const fail = (code: string, message?: string): BalanceResult => ({
        ok: false,
        usdt: 0,
        pepew: 0,
        errorCode: code,
        errorMessage: message,
    });

    try {
        const normalized = await getNormalizedBalances(exchange as ExchangeName, accessKey, secretKey, rateLimitKey);
        const meta = getLastBalanceMeta(exchange, accessKey, rateLimitKey);
        const lastOkTs = normalized.lastOkTs || meta.lastOkTs;
        const lastOkAgeSec = lastOkTs ? Math.max(0, Math.round((Date.now() - lastOkTs) / 1000)) : undefined;

        if (!normalized.ok) {
            return {
                ...fail(normalized.errCode || normalized.reason || "BALANCE_FETCH_FAILED", normalized.error || "Balance fetch failed"),
                lastOkTs,
                lastOkAgeSec,
                failCount: normalized.failCount || meta.failCount || 0,
            };
        }

        return {
            ok: true,
            usdt: normalized.assets.USDT || 0,
            pepew: normalized.assets.PEPEW || 0,
            degraded: !!normalized.degraded,
            source: normalized.snapshot?.source || "live",
            lastOkTs,
            lastOkAgeSec,
            failCount: normalized.failCount || meta.failCount || 0,
            errorCode: normalized.errCode,
            errorMessage: normalized.error,
        };
    } catch (err: any) {
        return fail("BALANCE_FETCH_FAILED", err.message);
    }
}

async function get24hVolume(exchange: DevmmExchange): Promise<number | null> {
    // Note: The current PriceResult type doesn't include volume data.
    // For MVP, we'll return a conservative estimate based on minNotional.
    // This can be enhanced later if exchanges provide volume data.
    try {
        // Return a conservative minimum estimate (100 USDT/day)
        // Real volume fetch would need exchange-specific ticker API
        return 100;
    } catch {
        return null;
    }
}

function getMarketRulesSync(exchange: DevmmExchange): MarketRules {
    try {
        const spec = getExchangeSpec(exchange);
        const limits = getPairLimits(exchange, "PEPEW/USDT");
        const tick = spec.precision.priceTick;
        const step = spec.precision.qtyStep;
        return {
            minNotional: limits.minNotional,
            minQty: step,
            qtyStep: step,
            priceTick: tick,
        };
    } catch {
        if (exchange === "nonkyc") {
            return { minNotional: 1, minQty: 1, qtyStep: 1, priceTick: 1e-12 };
        } else if (exchange === "dextrade") {
            return { minNotional: 5, minQty: 1, qtyStep: 1, priceTick: 1e-8 };
        } else {
            return { minNotional: 0.0015, minQty: 1, qtyStep: 1, priceTick: 1e-8 };
        }
    }
}

function isPostOnlyReject(error: string | undefined): boolean {
    const errLower = String(error || "").toLowerCase();
    return errLower.includes("post") || errLower.includes("maker") || errLower.includes("crossing");
}

async function buildDevmmQuotePlan(
    exchange: DevmmExchange,
    config: DevmmConfig,
    ob: OrderbookTop,
    rules: MarketRules
): Promise<DevmmQuotePlan> {
    const priceTickUsed = resolvePriceTick(rules.priceTick, [ob.bid, ob.ask]);
    const forceSpreadTicks = DEVMM_FORCE_SPREAD_TICKS;
    const spreadAbs = (ob.ask || 0) - (ob.bid || 0);
    const forceSpreadMode = !!ob.forcedMid || !Number.isFinite(spreadAbs) || spreadAbs <= 0;
    const buyOffsetPct = normalizePercentRatio(config.buy_offset_pct, 0.02);
    const sellOffsetPct = normalizePercentRatio(config.sell_offset_pct, 0.01);

    let quoteMid = (ob.bid || 0) > 0 && (ob.ask || 0) > 0 ? ((ob.bid as number) + (ob.ask as number)) / 2 : Math.max(ob.bid || 0, ob.ask || 0);
    let quoteAnchor = "ORDERBOOK_MID";
    const anchorFromExchange = await fetchExchangePrice(exchange as ExchangeName, "PEPEW/USDT").catch(() => null);
    if (anchorFromExchange?.price && anchorFromExchange.price > 0) {
        quoteMid = anchorFromExchange.price;
        quoteAnchor = `EXCHANGE_${anchorFromExchange.source}`;
    }
    if ((!anchorFromExchange || !anchorFromExchange.price || anchorFromExchange.price <= 0) && (forceSpreadMode || ob.bookSource !== "orderbook")) {
        const anchorFromAgg = await fetchAggregatedPrice("PEPEW/USDT").catch(() => null);
        if (anchorFromAgg?.price && anchorFromAgg.price > 0) {
            quoteMid = anchorFromAgg.price;
            quoteAnchor = "AGG";
        }
    }

    let buyPrice = floorToTick(quoteMid * (1 - buyOffsetPct), priceTickUsed);
    let sellPrice = ceilToTick(quoteMid * (1 + sellOffsetPct), priceTickUsed);
    if (forceSpreadMode) {
        buyPrice = floorToTick(quoteMid - forceSpreadTicks * priceTickUsed, priceTickUsed);
        sellPrice = ceilToTick(quoteMid + forceSpreadTicks * priceTickUsed, priceTickUsed);
    }

    const maxBuy = ob.ask && ob.ask > 0 ? floorToTick(ob.ask - priceTickUsed, priceTickUsed) : null;
    const minSell = ob.bid && ob.bid > 0 ? ceilToTick(ob.bid + priceTickUsed, priceTickUsed) : null;
    if (Number.isFinite(maxBuy as number) && (maxBuy as number) > 0 && ob.ask && buyPrice >= ob.ask) {
        buyPrice = maxBuy as number;
    }
    if (Number.isFinite(minSell as number) && (minSell as number) > 0 && ob.bid && sellPrice <= ob.bid) {
        sellPrice = minSell as number;
    }

    const invalidQuotes =
        !Number.isFinite(quoteMid) ||
        quoteMid <= 0 ||
        !Number.isFinite(buyPrice) ||
        !Number.isFinite(sellPrice) ||
        buyPrice <= 0 ||
        sellPrice <= 0;
    const crossSelf = !invalidQuotes && buyPrice >= sellPrice;

    const orderQuote = resolveOrderQuote(exchange, config.order_quote_usdt);
    let buyQty = invalidQuotes ? 0 : roundToStep(orderQuote / buyPrice, rules.qtyStep);
    let sellQty = invalidQuotes ? 0 : roundToStep(orderQuote / sellPrice, rules.qtyStep);
    if (!invalidQuotes && buyPrice * buyQty < rules.minNotional) {
        buyQty = Math.ceil(rules.minNotional * 1.05 / buyPrice / rules.qtyStep) * rules.qtyStep;
    }
    if (!invalidQuotes && sellPrice * sellQty < rules.minNotional) {
        sellQty = Math.ceil(rules.minNotional * 1.05 / sellPrice / rules.qtyStep) * rules.qtyStep;
    }

    return {
        quoteMid,
        quoteAnchor,
        buyPrice,
        sellPrice,
        buyQty,
        sellQty,
        adjustedBuyNotional: buyPrice * buyQty,
        adjustedSellNotional: sellPrice * sellQty,
        priceTickUsed,
        forceSpreadMode,
        forceSpreadTicks,
        invalidQuotes,
        crossSelf,
    };
}

function evaluateDexTradeStaleCandidate(
    order: ManagedOpenOrder,
    now: number,
    rules: MarketRules
): {
    shouldRefresh: boolean;
    ageSec: number | null;
    reason: string;
    remainingQty: number;
    isPartial: boolean;
} {
    const createdAt = Number.isFinite(order.createdAt as number) ? Number(order.createdAt) : null;
    if (!createdAt || createdAt <= 0) {
        return { shouldRefresh: false, ageSec: null, reason: "missing_created_at", remainingQty: 0, isPartial: false };
    }

    const ageMs = Math.max(0, now - createdAt);
    const ageSec = Math.floor(ageMs / 1000);
    const totalQty = Math.max(0, toNumber(order.quantity) || 0);
    const filledQty = Math.max(0, toNumber(order.filledQuantity) || 0);
    const remainingQty = roundToStep(Math.max(0, totalQty - filledQty), rules.qtyStep);
    const isPartial = filledQty > 0;

    if (ageMs < DEVMM_DEXTRADE_STALE_REFRESH_MS) {
        return { shouldRefresh: false, ageSec, reason: "age_below_threshold", remainingQty, isPartial };
    }
    if (isPartial && remainingQty < rules.minQty) {
        return { shouldRefresh: false, ageSec, reason: "remaining_below_min_qty", remainingQty, isPartial };
    }
    return { shouldRefresh: true, ageSec, reason: "stale_refresh", remainingQty, isPartial };
}

export async function maybeRefreshDexTradeStaleOrder(params: {
    config: DevmmConfig;
    exchange: DevmmExchange;
    symbol: string;
    side: PendingOrderSide;
    order: ManagedOpenOrder | null | undefined;
    now: number;
    rules: MarketRules;
    rawOpenOrders: ManagedOpenOrder[];
}, deps: DexTradeStaleRefreshDeps): Promise<DexTradeStaleRefreshResult> {
    const order = params.order;
    const logger = deps.log || (() => { });
    const audit = deps.audit || (() => { });
    const sleep = deps.sleep || (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });

    if (params.exchange !== "dextrade" || !order || order.side !== params.side) {
        return {
            checked: false,
            shouldRefresh: false,
            suppressPlacement: false,
            rawOpenOrders: params.rawOpenOrders,
            ageSec: null,
            outcome: "not_applicable",
            reason: "not_dextrade_or_missing_order",
        };
    }

    const evaluation = evaluateDexTradeStaleCandidate(order, params.now, params.rules);
    logger(
        "info",
        `stale_check strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} ageSec=${evaluation.ageSec ?? "n/a"} status=${order.status || "OPEN"} decision=${evaluation.shouldRefresh ? "yes" : "no"} reason=${evaluation.reason}`
    );

    if (!evaluation.shouldRefresh) {
        return {
            checked: true,
            shouldRefresh: false,
            suppressPlacement: false,
            rawOpenOrders: params.rawOpenOrders,
            ageSec: evaluation.ageSec,
            outcome: "not_stale",
            reason: evaluation.reason,
        };
    }

    logger(
        "info",
        `stale_cancel_requested strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} price=${order.price ?? "n/a"} qty=${order.quantity ?? "n/a"} ageSec=${evaluation.ageSec ?? "n/a"} trigger=stale_refresh`
    );
    audit({
        action: "cancel",
        side: params.side,
        orderId: order.id,
        price: order.price ?? null,
        qty: order.quantity ?? null,
        reason: "STALE_CANCEL_REQUESTED",
    });

    const cancelResult = await deps.cancelOrder(order.id);
    if (!cancelResult.ok) {
        logger(
            "error",
            `stale_cancel_failed strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=${cancelResult.error || "cancel_failed"}`
        );
        audit({
            action: "error",
            side: params.side,
            orderId: order.id,
            price: order.price ?? null,
            qty: order.quantity ?? null,
            reason: "STALE_CANCEL_FAILED",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: params.rawOpenOrders,
            ageSec: evaluation.ageSec,
            outcome: "cancel_failed",
            reason: cancelResult.error || "cancel_failed",
        };
    }

    const confirmResult = await deps.listOpenOrders();
    if (!confirmResult.ok) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=cancel_not_confirmed`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: order.price ?? null,
            qty: order.quantity ?? null,
            reason: "STALE_REPOST_SKIPPED_CONFIRM_FAILED",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: params.rawOpenOrders,
            ageSec: evaluation.ageSec,
            outcome: "cancel_not_confirmed",
            reason: "cancel_not_confirmed",
        };
    }

    const refreshedOrders = confirmResult.orders;
    if (refreshedOrders.some((entry) => entry.id === order.id)) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=cancel_not_confirmed_still_live`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: order.price ?? null,
            qty: order.quantity ?? null,
            reason: "STALE_REPOST_SKIPPED_STILL_LIVE",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "cancel_not_confirmed",
            reason: "cancel_not_confirmed_still_live",
        };
    }

    deps.onPendingRemove?.(order.id);
    deps.onLocalPlacedRemove?.(order.id);
    deps.onTrackedOrderChange?.(params.side, null);
    logger(
        "info",
        `stale_cancel_confirmed strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id}`
    );

    if (deps.isStrategyEnabled && !deps.isStrategyEnabled()) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=strategy_disabled`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: order.price ?? null,
            qty: order.quantity ?? null,
            reason: "STALE_REPOST_SKIPPED_STRATEGY_DISABLED",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "strategy_disabled",
        };
    }

    if (refreshedOrders.some((entry) => entry.side === params.side)) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=same_side_order_visible`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: order.price ?? null,
            qty: order.quantity ?? null,
            reason: "STALE_REPOST_SKIPPED_SAME_SIDE_VISIBLE",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "same_side_order_visible",
        };
    }

    const freshOb = await deps.getFreshOrderbook();
    if (!freshOb.bid || !freshOb.ask || freshOb.bid <= 0 || freshOb.ask <= 0) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=orderbook_unavailable`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: order.price ?? null,
            qty: order.quantity ?? null,
            reason: "STALE_REPOST_SKIPPED_NO_BOOK",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "orderbook_unavailable",
        };
    }

    const quotePlan = deps.buildQuotePlan
        ? await deps.buildQuotePlan(freshOb)
        : await buildDevmmQuotePlan(params.exchange, params.config, freshOb, params.rules);
    if (quotePlan.invalidQuotes) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=invalid_quote`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            reason: "STALE_REPOST_SKIPPED_INVALID_QUOTE",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "invalid_quote",
        };
    }
    if (quotePlan.crossSelf) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=anti_cross_self`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            reason: "STALE_REPOST_SKIPPED_ANTI_CROSS",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "anti_cross_self",
        };
    }

    let repostPrice = params.side === "BUY" ? quotePlan.buyPrice : quotePlan.sellPrice;
    let repostQty = params.side === "BUY" ? quotePlan.buyQty : quotePlan.sellQty;
    if (evaluation.isPartial) {
        repostQty = evaluation.remainingQty;
    }

    if (!Number.isFinite(repostQty) || repostQty < params.rules.minQty) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=remaining_too_small`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: repostPrice,
            qty: repostQty,
            reason: "STALE_REPOST_SKIPPED_REMAINING_TOO_SMALL",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "remaining_too_small",
        };
    }

    const notional = repostPrice * repostQty;
    if (!Number.isFinite(notional) || notional < params.rules.minNotional) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=min_notional_invalid`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: repostPrice,
            qty: repostQty,
            reason: "STALE_REPOST_SKIPPED_MIN_NOTIONAL",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "min_notional_invalid",
        };
    }

    if ((params.side === "BUY" && repostPrice >= freshOb.ask) || (params.side === "SELL" && repostPrice <= freshOb.bid)) {
        logger(
            "info",
            `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=anti_cross_blocked`
        );
        audit({
            action: "skip",
            side: params.side,
            orderId: order.id,
            price: repostPrice,
            qty: repostQty,
            reason: "STALE_REPOST_SKIPPED_ANTI_CROSS",
        });
        return {
            checked: true,
            shouldRefresh: true,
            suppressPlacement: true,
            rawOpenOrders: refreshedOrders,
            ageSec: evaluation.ageSec,
            outcome: "repost_skipped",
            reason: "anti_cross_blocked",
        };
    }

    let placedOrderId: string | undefined;
    let verifyOrders = refreshedOrders;
    let currentPrice = repostPrice;
    for (let retries = 0; retries < 3; retries++) {
        const clientOrderId = buildDevmmClientOrderId(params.config.id);
        const placeResult = await deps.placeOrder(params.side, currentPrice, repostQty, clientOrderId);
        if (placeResult.ok && placeResult.orderId) {
            placedOrderId = placeResult.orderId;
            deps.onLocalPlacedAdd?.(placeResult.orderId);
            deps.onLastPlacedSide?.(params.side);
            deps.onPendingAdd?.(placeResult.orderId, clientOrderId, params.side);
            deps.onTrackedOrderChange?.(params.side, placeResult.orderId);
            audit({
                action: "place",
                side: params.side,
                orderId: placeResult.orderId,
                price: currentPrice,
                qty: repostQty,
                reason: "STALE_REPOST_PLACED",
            });

            let visible = false;
            for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
                if (verifyAttempt > 0) {
                    await sleep(1000);
                }
                const verifyResult = await deps.listOpenOrders();
                if (!verifyResult.ok) continue;
                verifyOrders = verifyResult.orders;
                if (verifyOrders.some((entry) => entry.id === placeResult.orderId)) {
                    visible = true;
                    break;
                }
            }

            if (visible) {
                deps.onPendingRemove?.(placeResult.orderId);
                logger(
                    "info",
                    `stale_repost_placed strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} oldOrderId=${order.id} newOrderId=${placeResult.orderId} price=${currentPrice} qty=${repostQty} ageSec=${evaluation.ageSec ?? "n/a"}`
                );
                return {
                    checked: true,
                    shouldRefresh: true,
                    suppressPlacement: true,
                    rawOpenOrders: verifyOrders,
                    ageSec: evaluation.ageSec,
                    outcome: "repost_placed",
                    reason: "repost_placed",
                    newOrderId: placeResult.orderId,
                };
            }

            logger(
                "info",
                `stale_repost_placed strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} oldOrderId=${order.id} newOrderId=${placeResult.orderId} price=${currentPrice} qty=${repostQty} visibility=pending_not_visible`
            );
            return {
                checked: true,
                shouldRefresh: true,
                suppressPlacement: true,
                rawOpenOrders: verifyOrders,
                ageSec: evaluation.ageSec,
                outcome: "repost_pending_not_visible",
                reason: "pending_not_visible",
                newOrderId: placeResult.orderId,
            };
        }

        if (!isPostOnlyReject(placeResult.error)) {
            logger(
                "info",
                `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=${placeResult.error || "place_failed"}`
            );
            audit({
                action: "error",
                side: params.side,
                orderId: order.id,
                price: currentPrice,
                qty: repostQty,
                reason: "STALE_REPOST_PLACE_FAILED",
            });
            return {
                checked: true,
                shouldRefresh: true,
                suppressPlacement: true,
                rawOpenOrders: refreshedOrders,
                ageSec: evaluation.ageSec,
                outcome: "repost_skipped",
                reason: placeResult.error || "place_failed",
            };
        }

        currentPrice = params.side === "BUY"
            ? floorToTick(currentPrice - quotePlan.priceTickUsed, quotePlan.priceTickUsed)
            : ceilToTick(currentPrice + quotePlan.priceTickUsed, quotePlan.priceTickUsed);
        if (
            currentPrice <= 0 ||
            (params.side === "BUY" && currentPrice >= freshOb.ask) ||
            (params.side === "SELL" && currentPrice <= freshOb.bid)
        ) {
            break;
        }
    }

    logger(
        "info",
        `stale_repost_skipped strategyId=${params.config.id} exchange=${params.exchange} symbol=${params.symbol} side=${params.side} orderId=${order.id} reason=post_only_retry_exhausted`
    );
    audit({
        action: "error",
        side: params.side,
        orderId: order.id,
        price: repostPrice,
        qty: repostQty,
        reason: "STALE_REPOST_POST_ONLY_RETRY_EXHAUSTED",
    });
    return {
        checked: true,
        shouldRefresh: true,
        suppressPlacement: true,
        rawOpenOrders: refreshedOrders,
        ageSec: evaluation.ageSec,
        outcome: "repost_skipped",
        reason: "post_only_retry_exhausted",
    };
}

function transitionDevmmState(
    exchange: DevmmExchange,
    symbol: string,
    to: "ACTIVE" | "DEGRADED" | "PAUSED",
    reason: string | null,
    extra?: { lastOkAgeSec?: number; failCount?: number; bookSource?: string; lastDecision?: string; cooldownUntil?: number | null }
): void {
    const current = getDevmmState(exchange, symbol);
    const from = current?.status || "STOPPED";
    const shouldLog = from !== to || (current?.pause_reason || null) !== (reason || null);
    if (shouldLog) {
        log(
            "info",
            exchange,
            `DEVMM_STATE_TRANSITION exchangeId=${exchange} from=${from} to=${to} reason=${reason || "NONE"} lastOkAgeSec=${extra?.lastOkAgeSec ?? "n/a"} failCount=${extra?.failCount ?? "n/a"} bookSource=${extra?.bookSource ?? "n/a"}`
        );
    }
    upsertDevmmState(exchange, symbol, {
        status: to as any,
        pause_reason: reason,
        last_decision: extra?.lastDecision,
        cooldown_until: extra?.cooldownUntil,
    });
}

async function placeOrder(
    exchange: DevmmExchange,
    accessKey: string,
    secretKey: string,
    rateLimitKey: string,
    side: "BUY" | "SELL",
    price: number,
    qty: number,
    clientOrderId?: string
): Promise<OrderResult> {
    try {
        if (exchange === "nonkyc") {
            const res = await createNonKycOrder({
                accessKey,
                secretKey,
                symbol: "PEPEW_USDT",
                side: side === "BUY" ? "buy" : "sell",
                quantity: qty,
                price,
                orderType: "limit",
                userProvidedId: clientOrderId,
            });
            if (res.ok && res.orderId) {
                return { ok: true, orderId: res.orderId, response: res.data ?? res };
            }
            return { ok: false, error: res.error || res.reason || "Order failed", response: res.data ?? res };
        } else if (exchange === "dextrade") {
            const res = await createDexTradeOrder({
                loginToken: accessKey,
                secret: secretKey,
                pair: "PEPEWUSDT",
                side: side,  // Already "BUY" or "SELL" which matches DexTradeOrderSide
                tradeType: "LIMIT",
                volume: qty,
                rate: price,
            });
            const dexOrderId = res.data?.id ?? res.data?.order_id ?? res.data?.data?.id ?? res.data?.data?.order_id;
            if (res.ok && dexOrderId) {
                return { ok: true, orderId: normalizeOrderId(dexOrderId), response: res.data ?? res };
            }
            return { ok: false, error: res.error || "Order failed", response: res.data ?? res };
        } else if (exchange === "nestex") {
            const res = await placeNestExLimitOrder({
                apiKey: accessKey,
                apiSecret: secretKey,
                cur: resolveNestExSymbol("PEPEW/USDT"),
                side: side,
                qty,
                price,
                rateLimitKey,
                pair: "PEPEW/USDT",
            });
            if (res.ok && res.orderId) {
                return { ok: true, orderId: normalizeOrderId(res.orderId), response: res.data ?? res };
            }
            return { ok: false, error: res.error || "Order failed", response: res.data ?? res };
        }
        return { ok: false, error: "Unknown exchange" };
    } catch (err: any) {
        return { ok: false, error: err.message };
    }
}

async function cancelOrder(
    exchange: DevmmExchange,
    accessKey: string,
    secretKey: string,
    rateLimitKey: string,
    orderId: string
): Promise<boolean> {
    try {
        if (exchange === "nonkyc") {
            const res = await cancelNonKycOrder(accessKey, secretKey, orderId);
            return res.ok;
        } else if (exchange === "dextrade") {
            const res = await cancelDexTradeOrder(accessKey, secretKey, orderId, "PEPEWUSDT");
            return res.ok;
        } else if (exchange === "nestex") {
            const res = await cancelNestExOrder(accessKey, secretKey, orderId, rateLimitKey);
            // Note: nestex adapter now returns ok: true for NOT_FOUND
            return res.ok;
        }
        return false;
    } catch (err: any) {
        tradeLog({
            scope: "devmmRunner",
            level: "warn",
            exchange,
            message: `cancelOrder exception orderId=${orderId} err=${err.message}`,
            throttleKey: `devmm:cancel-exception:${exchange}`,
            throttleSec: 20,
        });
        return false;
    }
}

async function listOpenOrders(
    exchange: DevmmExchange,
    accessKey: string,
    secretKey: string,
    rateLimitKey: string
): Promise<ManagedOpenOrder[]> {
    try {
        if (exchange === "nonkyc") {
            const res = await listNonKycOpenOrders(accessKey, secretKey, "PEPEW_USDT");
            if (!res.ok) return [];
            const rawOrders = Array.isArray(res.orders)
                ? res.orders
                : (Array.isArray(res.data) ? res.data : (Array.isArray((res as any)?.data?.orders) ? (res as any).data.orders : []));
            return rawOrders.map((o: any) => ({
                id: normalizeOrderId(o.order_id || o.id),
                side: normalizeOrderSide(o.side),
                clientOrderId: o.userProvidedId || o.clientOrderId || undefined,
                price: toNumber(o.price),
                quantity: toNumber(o.quantity),
                filledQuantity: toNumber(o.filled_quantity) ?? toNumber(o.executedQty),
                createdAt: toNumber(o.created_at),
                status: String(o.status || "OPEN"),
            }));
        } else if (exchange === "dextrade") {
            const res = await listDexTradeOpenOrders(accessKey, secretKey, "PEPEWUSDT");
            if (!res.ok || !Array.isArray(res.orders)) return [];
            return res.orders.map((o: any) => ({
                id: normalizeOrderId(o.id || o.order_id),
                side: normalizeOrderSide(o.side ?? o.type),
                clientOrderId: undefined,
                price: toNumber(o.price),
                quantity: toNumber(o.quantity),
                filledQuantity: toNumber(o.filled_quantity),
                createdAt: toNumber(o.created_at),
                status: String(o.status || "OPEN"),
            }));
        } else if (exchange === "nestex") {
            const res = await listNestExOpenOrders(accessKey, secretKey, "PEPEW/USDT", rateLimitKey, { exhaustive: true });
            if (!res.ok || !Array.isArray(res.orders)) return [];
            return res.orders.map((o: any) => ({
                id: normalizeOrderId(o.order_id || o.id),
                side: normalizeOrderSide(o.side ?? o.type ?? o.order_type),
                clientOrderId: o.client_order_id || o.clientOrderId || undefined,
                price: toNumber(o.price),
                quantity: toNumber(o.qty ?? o.quantity ?? o.volume),
                filledQuantity: toNumber(o.filled_qty ?? o.filled_quantity ?? o.executedQty),
                createdAt: toNumber(o.created_at ?? o.timestamp),
                status: String(o.status || "OPEN"),
            }));
        }
        return [];
    } catch {
        return [];
    }
}

function summarizeOpenOrdersBySide(orders: Array<{ side: string }>): { buy: number; sell: number; unknown: number } {
    let buy = 0;
    let sell = 0;
    let unknown = 0;
    for (const order of orders) {
        if (order.side === "BUY") buy++;
        else if (order.side === "SELL") sell++;
        else unknown++;
    }
    return { buy, sell, unknown };
}

// Main tick function
async function tickDevmm(config: DevmmConfig, now: number): Promise<void> {
    const exchangeRaw = String(config.exchange || "");
    if (!isSupportedExchange(exchangeRaw)) {
        const requestedExchange = exchangeRaw || "unknown";
        const available = SUPPORTED_EXCHANGES.join(",");
        tradeLog({
            scope: "devmmRunner",
            level: "error",
            exchange: requestedExchange,
            message: `INVALID_EXCHANGE available=${available}`,
        });
        upsertDevmmState(requestedExchange as DevmmExchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.INVALID_EXCHANGE });
        updateDevmmError(requestedExchange as DevmmExchange, config.symbol, DevmmPauseReason.INVALID_EXCHANGE);
        return;
    }

    const exchange = exchangeRaw as DevmmExchange;

    if (runningExchanges.has(exchange)) {
        log("debug", exchange, "Skipping tick: already running");
        return;
    }
    runningExchanges.add(exchange);

    try {
        if (config.is_enabled !== 1) {
            log("debug", exchange, "Config disabled or not found");
            return;
        }

        // Get API keys using tgUserId from config
        const tgUserId = config.tg_user_id || process.env.DEVMM_TG_USER_ID || "devfee";
        const keyRecord = getExchangeKey(tgUserId, exchange);
        if (!keyRecord) {
            log("error", exchange, `No API keys found for user=${tgUserId}`);
            upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.NO_API_KEYS });
            return;
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
        } catch (err: any) {
            log("error", exchange, `Failed to decrypt keys: ${err.message}`);
            upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.KEY_DECRYPT_FAILED });
            return;
        }

        const rateLimitKey = `devmm:${exchange}`;

        // Get or create state
        let state = getDevmmState(exchange, config.symbol);
        if (!state) {
            state = upsertDevmmState(exchange, config.symbol, { status: "ACTIVE" });
        }
        const bootstrapLifecycle = ensureBootstrapLifecycle(exchange, config.symbol, now, state.last_action, state.last_action_at);
        if (!DEVMM_BOOTSTRAP_ENABLED && !bootstrapLifecycle.done) {
            bootstrapLifecycle.done = true;
            bootstrapLifecycle.doneAt = now;
        }
        if (!bootstrapLifecycle.done && now - bootstrapLifecycle.startedAt > DEVMM_BOOTSTRAP_WINDOW_MS) {
            bootstrapLifecycle.done = true;
            bootstrapLifecycle.doneAt = now;
        }
        let phase: DevmmPhase = !bootstrapLifecycle.done ? "BOOTSTRAP" : "NORMAL";
        bootstrapLifecycle.lastPhase = phase;
        let dailyCapBypassed = false;
        const orderAttempts: string[] = [];
        const orderResults: string[] = [];
        const skipReasons = new Set<DevmmSkipReason>();
        const issueCodes = new Set<DevmmIssueCode>();

        // Mark tick start
        upsertDevmmState(exchange, config.symbol, { last_tick_at: now });

        const configId = config.id;
        if (state?.last_action === "started" && state.last_action_at && now - state.last_action_at < 2 * 60_000) {
            log("info", exchange, `starting id=${configId} exchange=${exchange}`);
        }

        // Check cooldown
        if (state.cooldown_until && now < state.cooldown_until) {
            const remaining = Math.round((state.cooldown_until - now) / 1000);
            log("info", exchange, `In cooldown for ${remaining}s more (reason: ${state.pause_reason || "cooldown"})`);
            return;
        }

        // Check turnover bucket resets
        const buckets = getTaipeiBuckets();
        if (state.day_bucket !== buckets.day) {
            resetDevmmTurnover(exchange, config.symbol, buckets.day, buckets.hour);
            state = getDevmmState(exchange, config.symbol)!;
            log("info", exchange, `Day bucket reset to ${buckets.day}`);
        } else if (state.hour_bucket !== buckets.hour) {
            upsertDevmmState(exchange, config.symbol, { hour_bucket: buckets.hour, used_turnover_hour_usdt: 0 });
            state = getDevmmState(exchange, config.symbol)!;
            log("debug", exchange, `Hour bucket reset to ${buckets.hour}`);
        }

        const balances = await getBalances(exchange, accessKey, secretKey, rateLimitKey);
        const guardHits: string[] = [];
        const degradedReasons: string[] = [];
        if (!balances.ok) {
            const errorCode = balances.errorCode || DevmmPauseReason.BALANCE_FETCH_FAILED;
            const errorMessage = balances.errorMessage || "Unknown error";
            const reason = balances.lastOkTs ? "BALANCE_TOO_STALE" : DevmmPauseReason.BALANCE_FETCH_FAILED;
            const decision = `PAUSED: ${reason}`;
            guardHits.push(DevmmPauseReason.BALANCE_FETCH_FAILED);
            logStrategyTickContract({
                strategyId: config.id,
                strategyType: "DEVMM",
                requestedExchangeId: exchange,
                canonicalPair: config.symbol,
                exchangeSymbol: config.symbol.replace("/", "_"),
                guards: guardHits,
            });
            log("error", exchange, `Failed to fetch balances: ${errorCode} ${errorMessage}`);
            transitionDevmmState(exchange, config.symbol, "PAUSED", reason, {
                lastOkAgeSec: balances.lastOkAgeSec,
                failCount: balances.failCount,
                lastDecision: decision,
            });
            updateDevmmError(exchange, config.symbol, formatError(errorCode, errorMessage));
            log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=n/a ask=n/a inv=n/a decision=${decision}`);
            return;
        }
        if (balances.degraded) {
            const failCount = balances.failCount || 0;
            const lastOkAgeMs = balances.lastOkTs ? now - balances.lastOkTs : Infinity;
            if (failCount >= DEVMM_BALANCE_FAIL_SOFT_MAX || lastOkAgeMs >= BALANCE_STALE_OK_MS) {
                const reason = failCount >= DEVMM_BALANCE_FAIL_SOFT_MAX ? "BALANCE_TOO_MANY_FAILURES" : "BALANCE_TOO_STALE";
                const decision = `PAUSED: ${reason}`;
                transitionDevmmState(exchange, config.symbol, "PAUSED", reason, {
                    lastOkAgeSec: balances.lastOkAgeSec,
                    failCount,
                    lastDecision: decision,
                });
                updateDevmmError(exchange, config.symbol, formatError(reason, balances.errorMessage));
                log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=n/a ask=n/a inv=n/a decision=${decision}`);
                return;
            }
            degradedReasons.push(DevmmPauseReason.BALANCE_CACHED);
            transitionDevmmState(exchange, config.symbol, "DEGRADED", DevmmPauseReason.BALANCE_CACHED, {
                lastOkAgeSec: balances.lastOkAgeSec,
                failCount,
                lastDecision: `DEGRADED: ${DevmmPauseReason.BALANCE_CACHED}`,
            });
        }

        // 2. Fetch orderbook
        const ob = await getOrderbook(exchange, accessKey, secretKey);
        if (!ob.bid || !ob.ask || ob.bid <= 0 || ob.ask <= 0) {
            const decision = "PAUSED: ORDERBOOK_UNAVAILABLE";
            guardHits.push("ORDERBOOK_UNAVAILABLE");
            logStrategyTickContract({
                strategyId: config.id,
                strategyType: "DEVMM",
                requestedExchangeId: exchange,
                canonicalPair: config.symbol,
                exchangeSymbol: config.symbol.replace("/", "_"),
                guards: guardHits,
            });
            log("error", exchange, "Invalid orderbook: bid/ask missing or <= 0");
            transitionDevmmState(exchange, config.symbol, "PAUSED", "NO_BOOK", {
                lastOkAgeSec: balances.lastOkAgeSec,
                failCount: balances.failCount,
                bookSource: ob.bookSource,
                lastDecision: decision,
            });
            updateDevmmError(exchange, config.symbol, "ORDERBOOK_UNAVAILABLE");
            log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=n/a ask=n/a inv=n/a decision=${decision}`);
            return;
        }

        const rules = getMarketRulesSync(exchange);
        const priceTickUsed = resolvePriceTick(rules.priceTick, [ob.bid, ob.ask]);
        const forceSpreadTicks = DEVMM_FORCE_SPREAD_TICKS;
        const spreadAbs = ob.ask - ob.bid;
        const forceSpreadMode = !!ob.forcedMid || !Number.isFinite(spreadAbs) || spreadAbs <= 0;
        if (forceSpreadMode) {
            guardHits.push(DevmmPauseReason.ZERO_SPREAD);
            degradedReasons.push(DevmmPauseReason.ZERO_SPREAD);
            issueCodes.add(DevmmIssueCode.F07_ZERO_SPREAD_LOOP);
            log(
                "info",
                exchange,
                `FORCE_SPREAD enabled reason=${ob.forcedMid ? "FORCED_MID" : "NON_POSITIVE_SPREAD"} forceSpreadTicks=${forceSpreadTicks} priceTickUsed=${priceTickUsed}`
            );
        }
        if (ob.bookSource === "ticker_fallback" || ob.bookSource === "ticker_primary") {
            degradedReasons.push(DevmmPauseReason.TICKER_FALLBACK_BOOK);
            transitionDevmmState(exchange, config.symbol, "DEGRADED", DevmmPauseReason.TICKER_FALLBACK_BOOK, {
                lastOkAgeSec: balances.lastOkAgeSec,
                failCount: balances.failCount,
                bookSource: ob.bookSource,
                lastDecision: `DEGRADED: ${DevmmPauseReason.TICKER_FALLBACK_BOOK}`,
            });
        }

        const midCandidate = (ob.bid + ob.ask) / 2;
        const mid = Number.isFinite(midCandidate) && midCandidate > 0
            ? midCandidate
            : Math.max(ob.bid, ob.ask);
        if (!Number.isFinite(mid) || mid <= 0) {
            const decision = "PAUSED: ORDERBOOK_UNAVAILABLE";
            guardHits.push("ORDERBOOK_UNAVAILABLE");
            log("error", exchange, `Invalid mid from orderbook bid=${ob.bid} ask=${ob.ask}`);
            transitionDevmmState(exchange, config.symbol, "PAUSED", "NO_BOOK", {
                lastOkAgeSec: balances.lastOkAgeSec,
                failCount: balances.failCount,
                bookSource: ob.bookSource,
                lastDecision: decision,
            });
            log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=n/a ask=n/a inv=n/a decision=${decision}`);
            return;
        }
        const spread = spreadAbs / mid;
        logStrategyTickContract({
            strategyId: config.id,
            strategyType: "DEVMM",
            requestedExchangeId: exchange,
            canonicalPair: config.symbol,
            exchangeSymbol: config.symbol.replace("/", "_"),
            bestBid: ob.bid,
            bestAsk: ob.ask,
            guards: guardHits,
        });

        // Update reference samples for EMA
        let samples = refSamples.get(exchange) || [];
        samples.push(mid);
        if (samples.length > 60) samples = samples.slice(-60);
        refSamples.set(exchange, samples);
        const ref = calcEMA(samples, 60) || mid;

        // Update 24h volume periodically
        let vol24h = state.vol24h_usdt;
        const volAge = state.vol24h_updated_at ? now - state.vol24h_updated_at : Infinity;
        if (volAge > 5 * 60 * 1000) {
            const newVol = await get24hVolume(exchange);
            if (newVol !== null) {
                vol24h = newVol;
                upsertDevmmState(exchange, config.symbol, { vol24h_usdt: vol24h, vol24h_updated_at: now });
            }
        }

        const totalValue = balances.usdt + balances.pepew * mid;
        const usdtShare = totalValue > 0 ? balances.usdt / totalValue : 0;

        // Update state with current market data
        upsertDevmmState(exchange, config.symbol, {
            last_bid: ob.bid,
            last_ask: ob.ask,
            last_mid: mid,
            last_ref: ref,
            usdt_balance: balances.usdt,
            pepew_balance: balances.pepew,
            usdt_share: usdtShare,
        });

        // Refresh state after updates
        state = getDevmmState(exchange, config.symbol)!;

        // === GUARDS ===

        // 1. Spread Guard
        if (!forceSpreadMode && spread < config.spread_min_pct) {
            const decision = `PAUSED: ${DevmmPauseReason.SPREAD_TOO_NARROW}`;
            guardHits.push(DevmmPauseReason.SPREAD_TOO_NARROW);
            log("info", exchange, `PAUSED: spread ${(spread * 100).toFixed(3)}% < min ${(config.spread_min_pct * 100).toFixed(2)}%`);
            upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.SPREAD_TOO_NARROW, last_decision: decision });
            log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=${ob.bid} ask=${ob.ask} inv=n/a decision=${decision}`);
            return;
        }
        if (spread > config.spread_max_pct) {
            const decision = `PAUSED: ${DevmmPauseReason.SPREAD_TOO_WIDE}`;
            guardHits.push(DevmmPauseReason.SPREAD_TOO_WIDE);
            log("info", exchange, `PAUSED: spread ${(spread * 100).toFixed(3)}% > max ${(config.spread_max_pct * 100).toFixed(2)}%`);
            upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.SPREAD_TOO_WIDE, last_decision: decision });
            log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=${ob.bid} ask=${ob.ask} inv=n/a decision=${decision}`);
            return;
        }

        // 2. Trend Guard
        const trendDev = Math.abs(mid / ref - 1);
        if (trendDev > config.trend_guard_pct) {
            const pauseUntil = now + config.trend_pause_minutes * 60 * 1000;
            const decision = `PAUSED: ${DevmmPauseReason.TREND_DEVIATION}`;
            guardHits.push(DevmmPauseReason.TREND_DEVIATION);
            log("info", exchange, `PAUSED: trend deviation ${(trendDev * 100).toFixed(2)}% > ${(config.trend_guard_pct * 100).toFixed(1)}%`);
            upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.TREND_DEVIATION, cooldown_until: pauseUntil, last_decision: decision });
            log("info", exchange, `tick phase=${phase} bootstrapDone=${bootstrapLifecycle.done} openOrders=n/a pendingCount=n/a dailyCapBypassed=${dailyCapBypassed} status=PAUSED bid=${ob.bid} ask=${ob.ask} inv=n/a decision=${decision}`);
            return;
        }

        // 3. Turnover Cap (applies later only when replenishment is needed)
        const capDay = Math.max(config.cap_day_min_usdt, (vol24h || 0) * config.cap_ratio);
        const capHour = capDay / 24;

        // 4. Inventory Guard
        let skipBuy = false;
        let skipSell = false;
        let inventoryBlockedBuy = false;
        let inventoryBlockedSell = false;
        const maxNewOrdersPerTick = DEVMM_MAX_NEW_ORDERS_PER_TICK;
        let capBlockedDaily = false;
        let capBlockedHourly = false;

        if (usdtShare < config.inventory_min_usdt_share) {
            skipBuy = true;
            inventoryBlockedBuy = true;
            log("debug", exchange, `Inventory guard: skip BUY, usdt_share ${(usdtShare * 100).toFixed(1)}% < min ${(config.inventory_min_usdt_share * 100).toFixed(0)}%`);
        }
        if (usdtShare > config.inventory_max_usdt_share) {
            skipSell = true;
            inventoryBlockedSell = true;
            log("debug", exchange, `Inventory guard: skip SELL, usdt_share ${(usdtShare * 100).toFixed(1)}% > max ${(config.inventory_max_usdt_share * 100).toFixed(0)}%`);
        }

        const quotePlan = await buildDevmmQuotePlan(exchange, config, ob, rules);
        let buyPrice = quotePlan.buyPrice;
        let sellPrice = quotePlan.sellPrice;
        let buyQty = quotePlan.buyQty;
        let sellQty = quotePlan.sellQty;
        let adjustedBuyNotional = quotePlan.adjustedBuyNotional;
        let adjustedSellNotional = quotePlan.adjustedSellNotional;
        if (quotePlan.forceSpreadMode) {
            log(
                "info",
                exchange,
                `FORCE_SPREAD quotes bid=${buyPrice} ask=${sellPrice} quoteMid=${quotePlan.quoteMid} anchor=${quotePlan.quoteAnchor} forceSpreadTicks=${quotePlan.forceSpreadTicks} priceTickUsed=${quotePlan.priceTickUsed}`
            );
        }
        if (quotePlan.invalidQuotes) {
            guardHits.push(DevmmSkipReason.NO_CROSSING);
            skipBuy = true;
            skipSell = true;
            skipReasons.add(DevmmSkipReason.NO_CROSSING);
            log("error", exchange, `SKIP_TICK:${DevmmSkipReason.NO_CROSSING} invalid guarded quote buy=${buyPrice} sell=${sellPrice}`);
        }

        // 5. Cross-Self Guard
        if (!skipReasons.has(DevmmSkipReason.NO_CROSSING) && quotePlan.crossSelf) {
            guardHits.push(DevmmSkipReason.NO_CROSSING);
            skipBuy = true;
            skipSell = true;
            skipReasons.add(DevmmSkipReason.NO_CROSSING);
            log("error", exchange, `SKIP_TICK:${DevmmSkipReason.NO_CROSSING} cross-self guard buy=${buyPrice} sell=${sellPrice}`);
        }
        const orderQuote = resolveOrderQuote(exchange, config.order_quote_usdt);

        if (exchange === "nestex") {
            const rawBuyQty = buyPrice > 0 ? (orderQuote / buyPrice) : 0;
            const rawSellQty = sellPrice > 0 ? (orderQuote / sellPrice) : 0;
            log("info", exchange, `[NestEx sizing] side=BUY price=${buyPrice} targetNotional=1 calculatedQty=${rawBuyQty} finalQtyAfterPrecision=${buyQty} notional=${adjustedBuyNotional}`);
            log("info", exchange, `[NestEx sizing] side=SELL price=${sellPrice} targetNotional=1 calculatedQty=${rawSellQty} finalQtyAfterPrecision=${sellQty} notional=${adjustedSellNotional}`);
        }

        if (!Number.isFinite(adjustedBuyNotional) || adjustedBuyNotional < rules.minNotional) {
            skipBuy = true;
            skipReasons.add(DevmmSkipReason.MIN_NOTIONAL);
        }
        if (!Number.isFinite(adjustedSellNotional) || adjustedSellNotional < rules.minNotional) {
            skipSell = true;
            skipReasons.add(DevmmSkipReason.MIN_NOTIONAL);
        }

        // Check if we have enough inventory
        if (balances.usdt < orderQuote) {
            skipBuy = true;
            log("debug", exchange, `Insufficient USDT for buy: have ${balances.usdt.toFixed(2)}, need ${orderQuote.toFixed(2)}`);
        }
        if (balances.pepew < sellQty) {
            skipSell = true;
            log("debug", exchange, `Insufficient PEPEW for sell: have ${balances.pepew.toFixed(0)}, need ${sellQty.toFixed(0)}`);
        }

        if (exchange === "nestex") {
            log("info", exchange, `[DEBUG] Proceeding with order: price=${buyPrice}/${sellPrice} qty=${buyQty}/${sellQty} rules.minNotional=${rules.minNotional} notional=${adjustedBuyNotional.toFixed(4)}/${adjustedSellNotional.toFixed(4)} skip=${skipBuy}/${skipSell}`);
        }

        // === ORDER RECONCILIATION & FILL RECORDING ===

        // List current open orders
        let rawOpenOrders = await listOpenOrders(exchange, accessKey, secretKey, rateLimitKey);
        const hasDevmmClientPrefix = (clientOrderId?: string): boolean => {
            return typeof clientOrderId === "string" && clientOrderId.startsWith("PPW-DEVMM-");
        };

        // Try adopting open orders by clientOrderId when tracked ids are missing (common after restart).
        const adoptUpdates: { open_buy_order_id?: string | null; open_sell_order_id?: string | null } = {};
        if (!state.open_buy_order_id) {
            const adoptBuy = rawOpenOrders.find((o) => o.side === "BUY" && hasDevmmClientPrefix(o.clientOrderId));
            if (adoptBuy?.id) adoptUpdates.open_buy_order_id = adoptBuy.id;
        }
        if (!state.open_sell_order_id) {
            const adoptSell = rawOpenOrders.find((o) => o.side === "SELL" && hasDevmmClientPrefix(o.clientOrderId));
            if (adoptSell?.id) adoptUpdates.open_sell_order_id = adoptSell.id;
        }
        if (Object.keys(adoptUpdates).length > 0) {
            state = upsertDevmmState(exchange, config.symbol, adoptUpdates);
            log(
                "info",
                exchange,
                `RECONCILE_ADOPT trackedBuy=${state.open_buy_order_id || "none"} trackedSell=${state.open_sell_order_id || "none"} source=clientOrderId`
            );
        }

        const isManagedOrder = (order: { id: string; clientOrderId?: string }): boolean => {
            const isTracked = order.id === state.open_buy_order_id || order.id === state.open_sell_order_id;
            return isTracked || hasDevmmClientPrefix(order.clientOrderId);
        };

        // Managed DevMM orders: tracked IDs or explicit DevMM clientOrderId prefix.
        let openOrders = rawOpenOrders.filter(isManagedOrder);
        let rawOpenSummary = summarizeOpenOrdersBySide(rawOpenOrders);
        let managedOpenSummary = summarizeOpenOrdersBySide(openOrders);
        log(
            "info",
            exchange,
            `openOrders raw=${rawOpenOrders.length} managed=${openOrders.length} rawBuy=${rawOpenSummary.buy} rawSell=${rawOpenSummary.sell} rawUnknown=${rawOpenSummary.unknown} managedBuy=${managedOpenSummary.buy} managedSell=${managedOpenSummary.sell} trackedBuy=${state.open_buy_order_id || "none"} trackedSell=${state.open_sell_order_id || "none"}`
        );
        const noTrackedOrders = !state.open_buy_order_id && !state.open_sell_order_id;
        if (rawOpenOrders.length > 0 && openOrders.length === 0 && noTrackedOrders) {
            issueCodes.add(DevmmIssueCode.F08_UNKNOWN_ORDERS_PRESENT);
            skipBuy = true;
            skipSell = true;
            const unknownReason = "UNKNOWN_ORDERS_PRESENT";
            if (!degradedReasons.includes(unknownReason)) {
                degradedReasons.push(unknownReason);
            }
            log(
                "info",
                exchange,
                `OPEN_ORDERS_UNMANAGED raw=${rawOpenOrders.length} managed=${openOrders.length} action=PAUSE_NEW_QUOTES issueCode=${DevmmIssueCode.F08_UNKNOWN_ORDERS_PRESENT}`
            );
        }
        let pendingOrders = reconcilePendingWithVisibleOrders(exchange, now, rawOpenOrders);

        // Hard Guard: Max open orders per exchange
        const MAX_TOTAL_ORDERS = 6;
        if (openOrders.length > MAX_TOTAL_ORDERS) {
            log("info", exchange, `Hard guard triggered: ${openOrders.length} orders found, limit is ${MAX_TOTAL_ORDERS}. Cancelling surplus.`);
            // Sort by id (assuming higher id is newer) and cancel oldest surplus
            const sorted = [...openOrders].sort((a, b) => a.id.localeCompare(b.id));
            const surplus = sorted.slice(0, openOrders.length - MAX_TOTAL_ORDERS);
            for (const o of surplus) {
                log("info", exchange, `Cancelling surplus ${o.side} order ${o.id}`);
                const cancelled = await cancelOrder(exchange, accessKey, secretKey, rateLimitKey, o.id);
                insertTradeAudit({
                    strategyId: config.id,
                    strategyType: "DEVMM",
                    exchange,
                    pair: config.symbol,
                    action: cancelled ? "cancel" : "error",
                    side: o.side,
                    orderId: o.id,
                    reason: cancelled ? "CANCEL_SURPLUS" : "CANCEL_SURPLUS_FAILED",
                });
                removePendingOrders(exchange, o.id);
                clearLocallyPlacedOrder(exchange, o.id);
            }
            // Re-fetch open orders after cleanup
            const refreshed = await listOpenOrders(exchange, accessKey, secretKey, rateLimitKey);
            rawOpenOrders = refreshed;
            const filtered = refreshed.filter(isManagedOrder);
            openOrders = filtered;
            pendingOrders = reconcilePendingWithVisibleOrders(exchange, now, refreshed);
        }

        // Cleanup: If there are ANY orders that are NOT the ones we currently track as "latest", 
        // we should attempt to cancel them (stray orders).
        for (const o of openOrders) {
            if (o.id !== state.open_buy_order_id && o.id !== state.open_sell_order_id) {
                log("info", exchange, `Cancelling stray ${o.side} order ${o.id}`);
                const ok = await cancelOrder(exchange, accessKey, secretKey, rateLimitKey, o.id);
                insertTradeAudit({
                    strategyId: config.id,
                    strategyType: "DEVMM",
                    exchange,
                    pair: config.symbol,
                    action: ok ? "cancel" : "error",
                    side: o.side,
                    orderId: o.id,
                    reason: ok ? "CANCEL_STRAY" : "CANCEL_STRAY_FAILED",
                });
                if (!ok) {
                    const failures = (cancelFailures.get(o.id) || 0) + 1;
                    cancelFailures.set(o.id, failures);
                    log("error", exchange, `Failed to cancel stray order ${o.id} (failure #${failures})`);
                    if (failures >= 3) {
                        log("error", exchange, `PAUSED: excessive cancellation failures for order ${o.id}`);
                        upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.CANCEL_FAILED, last_decision: `PAUSED: ${DevmmPauseReason.CANCEL_FAILED}` });
                        updateDevmmError(exchange, config.symbol, `${DevmmPauseReason.CANCEL_FAILED}: order ${o.id} failed to cancel 3 times`);
                        return;
                    }
                } else {
                    cancelFailures.delete(o.id);
                    removePendingOrders(exchange, o.id);
                    clearLocallyPlacedOrder(exchange, o.id);
                }
            }
        }

        // Check for fills (orders that were tracked but are no longer in openOrders)
        const checkFill = async (side: "BUY" | "SELL", trackedOrderId: string | null) => {
            if (!trackedOrderId) return;
            const pendingInvisible = pendingOrders.some(o => o.orderId === trackedOrderId);
            if (pendingInvisible) {
                return;
            }
            const clearTrackedSide = () => {
                if (side === "BUY") {
                    upsertDevmmState(exchange, config.symbol, { open_buy_order_id: null });
                } else {
                    upsertDevmmState(exchange, config.symbol, { open_sell_order_id: null });
                }
            };
            const stillOpen = rawOpenOrders.some(o => o.id === trackedOrderId);
            if (stillOpen) {
                removePendingOrders(exchange, trackedOrderId);
                return;
            }
            if (!stillOpen) {
                if (exchange === "nestex" || exchange === "dextrade") {
                    if (wasLocallyPlacedOrder(exchange, trackedOrderId)) {
                        if (exchange === "nestex") {
                            const oppositeSide: PendingOrderSide = side === "BUY" ? "SELL" : "BUY";
                            const oppositeSideVisible = rawOpenOrders.some((o) => o.side === oppositeSide);
                            if (!oppositeSideVisible) {
                                addPendingOrder(exchange, { orderId: trackedOrderId, side }, now);
                                pendingOrders = pruneAndGetPendingOrders(exchange, now);
                                log(
                                    "info",
                                    exchange,
                                    `ORDER_NOT_VISIBLE side=${side} order_id=${trackedOrderId} action=KEEP_PENDING_NOT_VISIBLE pendingCount=${pendingOrders.length} visibilityGraceMs=${getVisibilityGraceMs(exchange)}`
                                );
                                return;
                            }
                            log("info", exchange, `ASSUMED_FILL side=${side} order_id=${trackedOrderId} reason=OPPOSITE_SIDE_VISIBLE`);
                        } else {
                            log("info", exchange, `ASSUMED_FILL side=${side} order_id=${trackedOrderId} reason=VISIBILITY_TIMEOUT`);
                        }
                        try {
                            const price = side === "BUY" ? state.last_bid || mid : state.last_ask || mid;
                            const qty = roundToStep(orderQuote / price, rules.qtyStep);
                            insertDevmmFill({
                                exchange,
                                symbol: "PEPEW/USDT",
                                side,
                                price,
                                qtyPepew: qty,
                                quoteUsdt: orderQuote,
                                orderId: trackedOrderId,
                                tradeId: exchange === "nestex" ? "ASSUMED_OPPOSITE_SIDE_VISIBLE" : "ASSUMED_VISIBILITY_TIMEOUT",
                            });
                            incrementDevmmTurnover(exchange, config.symbol, orderQuote);
                            insertTradeAudit({
                                strategyId: config.id,
                                strategyType: "DEVMM",
                                exchange,
                                pair: config.symbol,
                                action: "fill",
                                side,
                                price,
                                qty,
                                orderId: trackedOrderId,
                                reason: exchange === "nestex" ? "ASSUMED_OPPOSITE_SIDE_VISIBLE" : "ASSUMED_VISIBILITY_TIMEOUT",
                            });
                        } catch (err: any) {
                            log("error", exchange, `Failed to record assumed fill: ${err.message}`);
                        }
                        removePendingOrders(exchange, trackedOrderId);
                        clearLocallyPlacedOrder(exchange, trackedOrderId);
                        clearTrackedSide();
                        return;
                    }
                    log("info", exchange, `ORDER_NOT_VISIBLE side=${side} order_id=${trackedOrderId} action=CLEAR_STALE_TRACKED`);
                    removePendingOrders(exchange, trackedOrderId);
                    clearTrackedSide();
                    return;
                }
                if (exchange === "nonkyc") {
                    try {
                        const orderInfo = await getNonKycOrderById(accessKey, secretKey, trackedOrderId);
                        if (orderInfo.ok) {
                            const summary = summarizeNonKycFinalOrder(orderInfo.data);
                            if (summary.filledQty <= 0 && summary.isCancelled) {
                                log("info", exchange, `ORDER_CLOSED_NO_FILL side=${side} order_id=${trackedOrderId} status=${summary.status || "UNKNOWN"}`);
                                removePendingOrders(exchange, trackedOrderId);
                                clearLocallyPlacedOrder(exchange, trackedOrderId);
                                clearTrackedSide();
                                return;
                            }
                            if (summary.filledQty > 0) {
                                const qty = roundToStep(summary.filledQty, rules.qtyStep);
                                if (qty > 0) {
                                    const fallbackPrice = side === "BUY" ? state.last_bid || mid : state.last_ask || mid;
                                    const price = summary.fillPrice && summary.fillPrice > 0 ? summary.fillPrice : fallbackPrice;
                                    const quoteUsdt = qty * price;
                                    insertDevmmFill({
                                        exchange,
                                        symbol: "PEPEW/USDT",
                                        side,
                                        price,
                                        qtyPepew: qty,
                                        quoteUsdt,
                                        orderId: trackedOrderId,
                                        tradeId: "NONKYC_ORDER_QUERY",
                                    });
                                    incrementDevmmTurnover(exchange, config.symbol, quoteUsdt);
                                    insertTradeAudit({
                                        strategyId: config.id,
                                        strategyType: "DEVMM",
                                        exchange,
                                        pair: config.symbol,
                                        action: "fill",
                                        side,
                                        price,
                                        qty,
                                        orderId: trackedOrderId,
                                        reason: "FILL_DETECTED_VERIFIED_NONKYC",
                                    });
                                    removePendingOrders(exchange, trackedOrderId);
                                    clearLocallyPlacedOrder(exchange, trackedOrderId);
                                    clearTrackedSide();
                                    return;
                                }
                            }
                        }
                    } catch (verifyErr: any) {
                        log("error", exchange, `NonKYC fill verify failed for order ${trackedOrderId}: ${verifyErr?.message || verifyErr}`);
                    }
                }
                log("info", exchange, `Detected FILL for ${side} order ${trackedOrderId}`);
                // Record fill in DB
                try {
                    const price = side === "BUY" ? state.last_bid || mid : state.last_ask || mid;
                    const qty = roundToStep(orderQuote / price, rules.qtyStep);

                    insertDevmmFill({
                        exchange,
                        symbol: "PEPEW/USDT",
                        side,
                        price,
                        qtyPepew: qty,
                        quoteUsdt: orderQuote,
                        orderId: trackedOrderId,
                    });
                    incrementDevmmTurnover(exchange, config.symbol, orderQuote);
                    insertTradeAudit({
                        strategyId: config.id,
                        strategyType: "DEVMM",
                        exchange,
                        pair: config.symbol,
                        action: "fill",
                        side,
                        price,
                        qty,
                        orderId: trackedOrderId,
                        reason: "FILL_DETECTED",
                    });
                } catch (err: any) {
                    log("error", exchange, `Failed to record fill: ${err.message}`);
                }
                removePendingOrders(exchange, trackedOrderId);
                clearLocallyPlacedOrder(exchange, trackedOrderId);
                clearTrackedSide();
            }
        };

        await checkFill("BUY", state.open_buy_order_id);
        await checkFill("SELL", state.open_sell_order_id);
        pendingOrders = pruneAndGetPendingOrders(exchange, now);
        const pendingCount = pendingOrders.length;

        let currentBuyOrder = openOrders.find(o => o.side === "BUY");
        let currentSellOrder = openOrders.find(o => o.side === "SELL");

        let staleSuppressedBuy = false;
        let staleSuppressedSell = false;
        if (exchange === "dextrade") {
            const listDexTradeOrdersDetailed = async (): Promise<{ ok: boolean; orders: ManagedOpenOrder[]; error?: string | null }> => {
                const res = await listDexTradeOpenOrders(accessKey, secretKey, "PEPEWUSDT");
                if (!res.ok || !Array.isArray(res.orders)) {
                    return { ok: false, orders: [], error: res.error || "LIST_OPEN_ORDERS_FAILED" };
                }
                return {
                    ok: true,
                    orders: res.orders.map((o: any) => ({
                        id: normalizeOrderId(o.id || o.order_id),
                        side: normalizeOrderSide(o.side ?? o.type),
                        clientOrderId: undefined,
                        price: toNumber(o.price),
                        quantity: toNumber(o.quantity),
                        filledQuantity: toNumber(o.filled_quantity),
                        createdAt: toNumber(o.created_at),
                        status: String(o.status || "OPEN"),
                    })),
                };
            };
            const refreshTrackedOrder = async (side: PendingOrderSide, trackedOrderId: string | null | undefined): Promise<void> => {
                if (!trackedOrderId) return;
                const trackedOrder = rawOpenOrders.find((entry) => entry.id === trackedOrderId && entry.side === side);
                const result = await maybeRefreshDexTradeStaleOrder(
                    {
                        config,
                        exchange,
                        symbol: config.symbol,
                        side,
                        order: trackedOrder,
                        now,
                        rules,
                        rawOpenOrders,
                    },
                    {
                        cancelOrder: async (orderId: string) => {
                            const res = await cancelDexTradeOrder(accessKey, secretKey, orderId, "PEPEWUSDT");
                            return { ok: res.ok, error: res.error || null };
                        },
                        listOpenOrders: listDexTradeOrdersDetailed,
                        getFreshOrderbook: async () => getOrderbook(exchange, accessKey, secretKey),
                        placeOrder: async (placeSide, price, qty, clientOrderId) =>
                            placeOrder(exchange, accessKey, secretKey, rateLimitKey, placeSide, price, qty, clientOrderId),
                        onPendingAdd: (orderId, clientOrderId, pendingSide) => addPendingOrder(exchange, { orderId, clientOrderId, side: pendingSide }, now),
                        onPendingRemove: (orderId) => removePendingOrders(exchange, orderId),
                        onLocalPlacedAdd: (orderId) => markLocallyPlacedOrder(exchange, orderId),
                        onLocalPlacedRemove: (orderId) => clearLocallyPlacedOrder(exchange, orderId),
                        onTrackedOrderChange: (trackedSide, orderId) => {
                            if (trackedSide === "BUY") {
                                upsertDevmmState(exchange, config.symbol, { open_buy_order_id: orderId });
                            } else {
                                upsertDevmmState(exchange, config.symbol, { open_sell_order_id: orderId });
                            }
                        },
                        onLastPlacedSide: (placedSide) => lastPlacedSideByExchange.set(exchange, placedSide),
                        isStrategyEnabled: () => (getDevmmConfigById(config.id)?.is_enabled || 0) === 1,
                        audit: ({ action, side: auditSide, orderId, price, qty, reason }) => {
                            insertTradeAudit({
                                strategyId: config.id,
                                strategyType: "DEVMM",
                                exchange,
                                pair: config.symbol,
                                action,
                                side: auditSide,
                                orderId,
                                price,
                                qty,
                                reason,
                            });
                        },
                        log: (level, message) => log(level, exchange, message),
                    }
                );
                rawOpenOrders = result.rawOpenOrders;
                state = getDevmmState(exchange, config.symbol)!;
                openOrders = rawOpenOrders.filter(isManagedOrder);
                pendingOrders = reconcilePendingWithVisibleOrders(exchange, now, rawOpenOrders);
                currentBuyOrder = openOrders.find((entry) => entry.side === "BUY");
                currentSellOrder = openOrders.find((entry) => entry.side === "SELL");
                if (side === "BUY") staleSuppressedBuy = result.suppressPlacement;
                if (side === "SELL") staleSuppressedSell = result.suppressPlacement;
            };

            await refreshTrackedOrder("BUY", state.open_buy_order_id);
            await refreshTrackedOrder("SELL", state.open_sell_order_id);
        }

        // Hard cap for new placements: use all visible orders (not only tracked/prefixed) to avoid over-placement.
        const unknownSideCount = rawOpenOrders.filter(o => o.side === "UNKNOWN").length;
        if (unknownSideCount > 0 && exchange === "nestex") {
            issueCodes.add(DevmmIssueCode.F03_NESTEX_SIDE_UNKNOWN);
            log("info", exchange, `OPEN_ORDERS_SIDE_UNKNOWN count=${unknownSideCount} issueCode=${DevmmIssueCode.F03_NESTEX_SIDE_UNKNOWN}`);
        }
        const visibleBuyCount = rawOpenOrders.filter(o => o.side === "BUY" || o.side === "UNKNOWN").length;
        const visibleSellCount = rawOpenOrders.filter(o => o.side === "SELL" || o.side === "UNKNOWN").length;
        const pendingBuyCount = pendingOrders.filter(o => o.side === "BUY").length;
        const pendingSellCount = pendingOrders.filter(o => o.side === "SELL").length;
        const existingBuyCount = visibleBuyCount + pendingBuyCount;
        const existingSellCount = visibleSellCount + pendingSellCount;

        if (visibleBuyCount > 0) {
            log("debug", exchange, `BUY hard cap: already have ${existingBuyCount} BUY orders open. Skipping BUY.`);
            skipBuy = true;
            // Clear tracking if it's there but we didn't see it last time (maybe it reappeared or it's a ghost)
            if (!state.open_buy_order_id) {
                upsertDevmmState(exchange, config.symbol, { open_buy_order_id: currentBuyOrder?.id || null });
            }
        }
        if (visibleSellCount > 0) {
            log("debug", exchange, `SELL hard cap: already have ${existingSellCount} SELL orders open. Skipping SELL.`);
            skipSell = true;
            if (!state.open_sell_order_id) {
                upsertDevmmState(exchange, config.symbol, { open_sell_order_id: currentSellOrder?.id || null });
            }
        }
        if (pendingBuyCount > 0 && visibleBuyCount === 0) {
            skipBuy = true;
            skipReasons.add(DevmmSkipReason.PENDING_NOT_VISIBLE);
            const pendingBuyId = pendingOrders.find(o => o.side === "BUY")?.orderId;
            if (!state.open_buy_order_id && pendingBuyId) {
                upsertDevmmState(exchange, config.symbol, { open_buy_order_id: pendingBuyId });
            }
        }
        if (pendingSellCount > 0 && visibleSellCount === 0) {
            skipSell = true;
            skipReasons.add(DevmmSkipReason.PENDING_NOT_VISIBLE);
            const pendingSellId = pendingOrders.find(o => o.side === "SELL")?.orderId;
            if (!state.open_sell_order_id && pendingSellId) {
                upsertDevmmState(exchange, config.symbol, { open_sell_order_id: pendingSellId });
            }
        }
        if (staleSuppressedBuy) {
            skipBuy = true;
        }
        if (staleSuppressedSell) {
            skipSell = true;
        }

        // If one side exists but the opposite side is missing, relax inventory guard once to restore 2-sided quoting.
        const hasAnyBuy = visibleBuyCount + pendingBuyCount > 0;
        const hasAnySell = visibleSellCount + pendingSellCount > 0;
        if (hasAnyBuy && !hasAnySell && inventoryBlockedSell && balances.pepew >= sellQty) {
            skipSell = false;
            inventoryBlockedSell = false;
            log("info", exchange, "Inventory guard relaxed for SELL to restore two-sided quoting");
        }
        if (hasAnySell && !hasAnyBuy && inventoryBlockedBuy && balances.usdt >= orderQuote) {
            skipBuy = false;
            inventoryBlockedBuy = false;
            log("info", exchange, "Inventory guard relaxed for BUY to restore two-sided quoting");
        }

        const sinceStartMs = Math.max(0, now - bootstrapLifecycle.startedAt);
        const bootstrapWindowOpen =
            DEVMM_BOOTSTRAP_ENABLED &&
            !bootstrapLifecycle.done &&
            sinceStartMs <= DEVMM_BOOTSTRAP_WINDOW_MS;
        const bootstrapFirstTick = bootstrapWindowOpen && !bootstrapLifecycle.firstTickHandled;
        const bootstrapSeedByVisibility =
            bootstrapWindowOpen &&
            openOrders.length === 0 &&
            pendingCount === 0 &&
            sinceStartMs < DEVMM_BOOTSTRAP_WINDOW_MS;
        const bootstrapActive = bootstrapWindowOpen && (bootstrapFirstTick || bootstrapSeedByVisibility);

        phase = bootstrapActive ? "BOOTSTRAP" : "NORMAL";
        bootstrapLifecycle.firstTickHandled = true;
        bootstrapLifecycle.lastPhase = phase;
        dailyCapBypassed = bootstrapActive && DEVMM_BOOTSTRAP_BYPASS_DAILY_CAP;
        bootstrapLifecycle.lastBypassedDailyCap = dailyCapBypassed;
        if (bootstrapActive) {
            if (inventoryBlockedBuy && balances.usdt >= orderQuote) {
                skipBuy = false;
                inventoryBlockedBuy = false;
                log("info", exchange, `BOOTSTRAP_OVERRIDE inventory_guard=BUY usdt=${balances.usdt.toFixed(2)} need=${orderQuote.toFixed(2)}`);
            }
            if (inventoryBlockedSell && balances.pepew >= sellQty) {
                skipSell = false;
                inventoryBlockedSell = false;
                log("info", exchange, `BOOTSTRAP_OVERRIDE inventory_guard=SELL pepew=${balances.pepew.toFixed(0)} need=${sellQty.toFixed(0)}`);
            }
        }
        if (phase === "BOOTSTRAP" && DEVMM_BOOTSTRAP_ORDERS_PER_SIDE === 1) {
            if (existingBuyCount >= 1) skipBuy = true;
            if (existingSellCount >= 1) skipSell = true;
        }
        if (!bootstrapWindowOpen && !bootstrapLifecycle.done) {
            bootstrapLifecycle.done = true;
            bootstrapLifecycle.doneAt = now;
        }

        const needsReplenish =
            existingBuyCount === 0 ||
            existingSellCount === 0 ||
            rawOpenOrders.length + pendingCount < DEVMM_TARGET_MIN_ORDERS;

        if (needsReplenish && !dailyCapBypassed) {
            if (state.used_turnover_today_usdt >= capDay) {
                capBlockedDaily = true;
                skipBuy = true;
                skipSell = true;
                skipReasons.add(DevmmSkipReason.DAILY_CAP_REACHED);
                guardHits.push(DevmmSkipReason.DAILY_CAP_REACHED);
                if (!degradedReasons.includes(DevmmSkipReason.DAILY_CAP_REACHED)) {
                    degradedReasons.push(DevmmSkipReason.DAILY_CAP_REACHED);
                }
                const turnoverUsed = state.used_turnover_today_usdt;
                const turnoverRemaining = Math.max(0, capDay - turnoverUsed);
                const issueCode = mapSkipReasonToIssueCode(DevmmSkipReason.DAILY_CAP_REACHED, { phase });
                if (issueCode) issueCodes.add(issueCode);
                log(
                    "info",
                    exchange,
                    `SKIP_TICK:${DevmmSkipReason.DAILY_CAP_REACHED} used=${turnoverUsed.toFixed(2)} cap=${capDay.toFixed(2)} remaining=${turnoverRemaining.toFixed(2)} dayKey=${state.day_bucket || "n/a"} hourKey=${state.hour_bucket || "n/a"} turnoverKey=${exchange}:${config.symbol} phase=${phase}`
                );
            } else if (state.used_turnover_hour_usdt >= capHour) {
                capBlockedHourly = true;
                skipBuy = true;
                skipSell = true;
                skipReasons.add(DevmmSkipReason.HOURLY_CAP_REACHED);
                guardHits.push(DevmmSkipReason.HOURLY_CAP_REACHED);
                if (!degradedReasons.includes(DevmmSkipReason.HOURLY_CAP_REACHED)) {
                    degradedReasons.push(DevmmSkipReason.HOURLY_CAP_REACHED);
                }
                log(
                    "info",
                    exchange,
                    `SKIP_TICK:${DevmmSkipReason.HOURLY_CAP_REACHED} used=${state.used_turnover_hour_usdt.toFixed(2)} cap=${capHour.toFixed(2)} phase=${phase}`
                );
            }
        }
        if (dailyCapBypassed) {
            log(
                "info",
                exchange,
                `DAILY_CAP_BYPASS phase=BOOTSTRAP bypass=${DEVMM_BOOTSTRAP_BYPASS_DAILY_CAP} capUsed=${state.used_turnover_today_usdt.toFixed(2)} capDay=${capDay.toFixed(2)} openOrders=${openOrders.length} pendingCount=${pendingCount} windowMs=${DEVMM_BOOTSTRAP_WINDOW_MS}`
            );
        }

        if (skipReasons.has(DevmmSkipReason.PENDING_NOT_VISIBLE)) {
            const issueCode = mapSkipReasonToIssueCode(DevmmSkipReason.PENDING_NOT_VISIBLE, { phase });
            if (issueCode) issueCodes.add(issueCode);
            log(
                "info",
                exchange,
                `SKIP_TICK:${DevmmSkipReason.PENDING_NOT_VISIBLE} pendingCount=${pendingCount} visibleOpenOrders=${rawOpenOrders.length} maxNewOrdersPerTick=${maxNewOrdersPerTick}`
            );
        }

        if (rawOpenOrders.length + pendingCount >= DEVMM_MAX_OPEN_ORDERS_SOFT) {
            skipBuy = true;
            skipSell = true;
            skipReasons.add(DevmmSkipReason.MAX_OPEN_ORDERS_SOFT);
            log(
                "info",
                exchange,
                `SKIP_TICK:${DevmmSkipReason.MAX_OPEN_ORDERS_SOFT} openPlusPending=${rawOpenOrders.length + pendingCount} softCap=${DEVMM_MAX_OPEN_ORDERS_SOFT} pendingCount=${pendingCount}`
            );
        }

        if (!skipBuy && !skipSell && maxNewOrdersPerTick === 1 && phase !== "BOOTSTRAP") {
            const lastPlacedSide = lastPlacedSideByExchange.get(exchange);
            if (lastPlacedSide === "BUY") {
                skipBuy = true;
                log("debug", exchange, "Alternating side placement: prioritize SELL this tick");
            } else if (lastPlacedSide === "SELL") {
                skipSell = true;
                log("debug", exchange, "Alternating side placement: prioritize BUY this tick");
            }
        }

        // Place new orders with post-only retry logic
        let placedBuy = false;
        let placedSell = false;
        let newOrdersPlacedThisTick = 0;

        if (!skipBuy) {
            if (newOrdersPlacedThisTick >= maxNewOrdersPerTick) {
                skipBuy = true;
                skipReasons.add(DevmmSkipReason.MAX_NEW_ORDERS_PER_TICK);
                log(
                    "info",
                    exchange,
                    `SKIP_TICK:${DevmmSkipReason.MAX_NEW_ORDERS_PER_TICK} side=BUY placedThisTick=${newOrdersPlacedThisTick} maxNewOrdersPerTick=${maxNewOrdersPerTick}`
                );
            }
        }

        if (!skipBuy) {
            let retries = 0;
            let currentBuyPrice = buyPrice;

            while (retries < 3) {
                const clientOrderId = buildDevmmClientOrderId(configId);
                const buyQuoteAttempt = currentBuyPrice * buyQty;
                orderAttempts.push(`BUY:${currentBuyPrice}:${buyQty}:${buyQuoteAttempt.toFixed(8)}`);
                log(
                    "info",
                    exchange,
                    `orderAttempt phase=${phase} side=BUY price=${currentBuyPrice} qty=${buyQty} quote=${buyQuoteAttempt.toFixed(8)}`
                );
                const result = await placeOrder(
                    exchange,
                    accessKey,
                    secretKey,
                    rateLimitKey,
                    "BUY",
                    currentBuyPrice,
                    buyQty,
                    clientOrderId
                );
                if (result.ok && result.orderId) {
                    orderResults.push(`BUY:PLACED:${result.orderId}`);
                    markLocallyPlacedOrder(exchange, result.orderId);
                    lastPlacedSideByExchange.set(exchange, "BUY");
                    addPendingOrder(exchange, { orderId: result.orderId, clientOrderId, side: "BUY" }, now);
                    pendingOrders = pruneAndGetPendingOrders(exchange, now);
                    upsertDevmmState(exchange, config.symbol, { open_buy_order_id: result.orderId });
                    placedBuy = true;
                    newOrdersPlacedThisTick += 1;
                    insertTradeAudit({
                        strategyId: config.id,
                        strategyType: "DEVMM",
                        exchange,
                        pair: config.symbol,
                        action: "place",
                        side: "BUY",
                        price: currentBuyPrice,
                        qty: buyQty,
                        orderId: result.orderId,
                        reason: `phase=${phase}`,
                    });

                    // Verify order visibility with retries
                    let found = false;
                    for (let v = 0; v < 3; v++) {
                        if (v > 0) await new Promise(resolve => setTimeout(resolve, 1000));
                        const verifyRaw = await listOpenOrders(exchange, accessKey, secretKey, rateLimitKey);
                        if (verifyRaw.some(o => o.id === result.orderId)) {
                            found = true;
                            break;
                        }
                        log("debug", exchange, `Order ${result.orderId} not visible yet (buy side), retry ${v + 1}/3...`);
                    }

                    if (found) {
                        removePendingOrders(exchange, result.orderId);
                        pendingOrders = pruneAndGetPendingOrders(exchange, now);
                        log("info", exchange, `Placed BUY order ${result.orderId} clientOrderId=${clientOrderId} @ ${currentBuyPrice} qty=${buyQty}`);
                        log("info", exchange, `orderResult phase=${phase} side=BUY result=placed orderId=${result.orderId}`);
                    } else {
                        const responseSnippet = formatResponseSnippet(result.response);
                        log(
                            "info",
                            exchange,
                            `ORDER_NOT_VISIBLE side=BUY order_id=${result.orderId} client_order_id=${clientOrderId} symbol=PEPEW/USDT price=${currentBuyPrice} qty=${buyQty} pendingCount=${pendingOrders.length} visibilityGraceMs=${getVisibilityGraceMs(exchange)} response=${responseSnippet}`
                        );
                        log("info", exchange, `orderResult phase=${phase} side=BUY result=pending_not_visible orderId=${result.orderId}`);
                    }
                    break;
                } else {
                    orderResults.push(`BUY:FAILED:${result.error || "UNKNOWN"}`);
                    insertTradeAudit({
                        strategyId: config.id,
                        strategyType: "DEVMM",
                        exchange,
                        pair: config.symbol,
                        action: "error",
                        side: "BUY",
                        price: currentBuyPrice,
                        qty: buyQty,
                        reason: result.error || "ORDER_FAILED",
                    });
                    const errLower = (result.error || "").toLowerCase();
                    if (errLower.includes("post") || errLower.includes("maker") || errLower.includes("crossing")) {
                        currentBuyPrice = floorToTick(currentBuyPrice - priceTickUsed, priceTickUsed);
                        retries++;
                        log("debug", exchange, `Post-only reject, retrying buy at ${currentBuyPrice} (attempt ${retries})`);
                        continue;
                    }
                    log("error", exchange, `BUY order failed: ${result.error}`);
                    log("info", exchange, `orderResult phase=${phase} side=BUY result=failed errCode=${result.error || "UNKNOWN"}`);
                    break;
                }
            }

            if (!placedBuy && retries >= 3) {
                log("info", exchange, "PAUSED: post-only reject after 3 retries");
                upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.POST_ONLY_REJECT, last_decision: `PAUSED: ${DevmmPauseReason.POST_ONLY_REJECT} (BUY)` });
                return;
            }
        }

        if (!skipSell) {
            if (newOrdersPlacedThisTick >= maxNewOrdersPerTick) {
                skipSell = true;
                skipReasons.add(DevmmSkipReason.MAX_NEW_ORDERS_PER_TICK);
                log(
                    "info",
                    exchange,
                    `SKIP_TICK:${DevmmSkipReason.MAX_NEW_ORDERS_PER_TICK} side=SELL placedThisTick=${newOrdersPlacedThisTick} maxNewOrdersPerTick=${maxNewOrdersPerTick}`
                );
            }
        }

        if (!skipSell) {
            let retries = 0;
            let currentSellPrice = sellPrice;

            while (retries < 3) {
                const clientOrderId = buildDevmmClientOrderId(configId);
                const sellQuoteAttempt = currentSellPrice * sellQty;
                orderAttempts.push(`SELL:${currentSellPrice}:${sellQty}:${sellQuoteAttempt.toFixed(8)}`);
                log(
                    "info",
                    exchange,
                    `orderAttempt phase=${phase} side=SELL price=${currentSellPrice} qty=${sellQty} quote=${sellQuoteAttempt.toFixed(8)}`
                );
                const result = await placeOrder(
                    exchange,
                    accessKey,
                    secretKey,
                    rateLimitKey,
                    "SELL",
                    currentSellPrice,
                    sellQty,
                    clientOrderId
                );
                if (result.ok && result.orderId) {
                    orderResults.push(`SELL:PLACED:${result.orderId}`);
                    markLocallyPlacedOrder(exchange, result.orderId);
                    lastPlacedSideByExchange.set(exchange, "SELL");
                    addPendingOrder(exchange, { orderId: result.orderId, clientOrderId, side: "SELL" }, now);
                    pendingOrders = pruneAndGetPendingOrders(exchange, now);
                    upsertDevmmState(exchange, config.symbol, { open_sell_order_id: result.orderId });
                    placedSell = true;
                    newOrdersPlacedThisTick += 1;
                    insertTradeAudit({
                        strategyId: config.id,
                        strategyType: "DEVMM",
                        exchange,
                        pair: config.symbol,
                        action: "place",
                        side: "SELL",
                        price: currentSellPrice,
                        qty: sellQty,
                        orderId: result.orderId,
                        reason: `phase=${phase}`,
                    });

                    // Verify order visibility with retries
                    let found = false;
                    for (let v = 0; v < 3; v++) {
                        if (v > 0) await new Promise(resolve => setTimeout(resolve, 1000));
                        const verifyRaw = await listOpenOrders(exchange, accessKey, secretKey, rateLimitKey);
                        if (verifyRaw.some(o => o.id === result.orderId)) {
                            found = true;
                            break;
                        }
                        log("debug", exchange, `Order ${result.orderId} not visible yet (sell side), retry ${v + 1}/3...`);
                    }

                    if (found) {
                        removePendingOrders(exchange, result.orderId);
                        pendingOrders = pruneAndGetPendingOrders(exchange, now);
                        log("info", exchange, `Placed SELL order ${result.orderId} clientOrderId=${clientOrderId} @ ${currentSellPrice} qty=${sellQty}`);
                        log("info", exchange, `orderResult phase=${phase} side=SELL result=placed orderId=${result.orderId}`);
                    } else {
                        const responseSnippet = formatResponseSnippet(result.response);
                        log(
                            "info",
                            exchange,
                            `ORDER_NOT_VISIBLE side=SELL order_id=${result.orderId} client_order_id=${clientOrderId} symbol=PEPEW/USDT price=${currentSellPrice} qty=${sellQty} pendingCount=${pendingOrders.length} visibilityGraceMs=${getVisibilityGraceMs(exchange)} response=${responseSnippet}`
                        );
                        log("info", exchange, `orderResult phase=${phase} side=SELL result=pending_not_visible orderId=${result.orderId}`);
                    }
                    break;
                } else {
                    orderResults.push(`SELL:FAILED:${result.error || "UNKNOWN"}`);
                    insertTradeAudit({
                        strategyId: config.id,
                        strategyType: "DEVMM",
                        exchange,
                        pair: config.symbol,
                        action: "error",
                        side: "SELL",
                        price: currentSellPrice,
                        qty: sellQty,
                        reason: result.error || "ORDER_FAILED",
                    });
                    const errLower = (result.error || "").toLowerCase();
                    if (errLower.includes("post") || errLower.includes("maker") || errLower.includes("crossing")) {
                        currentSellPrice = ceilToTick(currentSellPrice + priceTickUsed, priceTickUsed);
                        retries++;
                        log("debug", exchange, `Post-only reject, retrying sell at ${currentSellPrice} (attempt ${retries})`);
                        continue;
                    }
                    log("error", exchange, `SELL order failed: ${result.error}`);
                    log("info", exchange, `orderResult phase=${phase} side=SELL result=failed errCode=${result.error || "UNKNOWN"}`);
                    break;
                }
            }

            if (!skipSell && !placedSell && retries >= 3) {
                log("info", exchange, "PAUSED: post-only reject after 3 retries");
                upsertDevmmState(exchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.POST_ONLY_REJECT, last_decision: `PAUSED: ${DevmmPauseReason.POST_ONLY_REJECT} (SELL)` });
                return;
            }
        }

        // Update action and decision
        const actions: string[] = [];
        if (placedBuy) actions.push("BUY");
        if (placedSell) actions.push("SELL");
        if (phase === "BOOTSTRAP" && actions.length === 1) {
            skipReasons.add(DevmmSkipReason.BOOTSTRAP_ONE_SIDE);
            const issueCode = mapSkipReasonToIssueCode(DevmmSkipReason.BOOTSTRAP_ONE_SIDE, { phase });
            if (issueCode) issueCodes.add(issueCode);
        }
        if (!bootstrapLifecycle.done && actions.length > 0) {
            bootstrapLifecycle.done = true;
            bootstrapLifecycle.doneAt = now;
        }
        if (!bootstrapLifecycle.done && now - bootstrapLifecycle.startedAt > DEVMM_BOOTSTRAP_WINDOW_MS) {
            bootstrapLifecycle.done = true;
            bootstrapLifecycle.doneAt = now;
        }
        const finalPendingCount = pruneAndGetPendingOrders(exchange, now).length;
        bootstrapLifecycle.lastPhase = phase;
        bootstrapLifecycle.lastBypassedDailyCap = dailyCapBypassed;

        let decision = "";
        if (actions.length > 0) {
            decision = `${phase}:PLACE_${actions.join("+")}`;
            updateDevmmAction(exchange, config.symbol, `placed ${actions.join("+")} phase=${phase}`);
        } else {
            const skips: string[] = [];
            if (skipBuy) skips.push("BUY");
            if (skipSell) skips.push("SELL");
            if (skipReasons.has(DevmmSkipReason.DAILY_CAP_REACHED)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.DAILY_CAP_REACHED}`;
            } else if (skipReasons.has(DevmmSkipReason.HOURLY_CAP_REACHED)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.HOURLY_CAP_REACHED}`;
            } else if (skipReasons.has(DevmmSkipReason.PENDING_NOT_VISIBLE)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.PENDING_NOT_VISIBLE}`;
            } else if (skipReasons.has(DevmmSkipReason.MAX_NEW_ORDERS_PER_TICK)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.MAX_NEW_ORDERS_PER_TICK}`;
            } else if (skipReasons.has(DevmmSkipReason.MAX_OPEN_ORDERS_SOFT)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.MAX_OPEN_ORDERS_SOFT}`;
            } else if (skipReasons.has(DevmmSkipReason.NO_CROSSING)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.NO_CROSSING}`;
            } else if (skipReasons.has(DevmmSkipReason.MIN_NOTIONAL)) {
                decision = `${phase}:SKIP_TICK:${DevmmSkipReason.MIN_NOTIONAL}`;
            } else {
                decision = skips.length > 0 ? `${phase}:SKIPPED:${skips.join("+")}` : `${phase}:IDLE`;
            }
            updateDevmmAction(exchange, config.symbol, `skipped ${skips.join("+")} phase=${phase}`.trim() || `idle phase=${phase}`);
        }
        if (actions.length === 0 && decision.includes("SKIP_TICK") && shouldRecordDevmmSkipAudit(exchange, decision, now)) {
            insertTradeAudit({
                ts: now,
                strategyId: config.id,
                strategyType: "DEVMM",
                exchange,
                pair: config.symbol,
                action: "skip",
                reason: decision,
            });
        }
        for (const reason of skipReasons) {
            const issueCode = mapSkipReasonToIssueCode(reason, { phase, zeroSpread: forceSpreadMode });
            if (issueCode) issueCodes.add(issueCode);
        }

        // Final state update for the tick
        const finalStatus = degradedReasons.length > 0 ? "DEGRADED" : "ACTIVE";
        const finalReason = degradedReasons.length > 0 ? degradedReasons.join("+") : null;
        const pauseIssueCode = mapPauseReasonToIssueCode(finalReason || null);
        if (pauseIssueCode) issueCodes.add(pauseIssueCode);
        const issueCodeSummary = Array.from(issueCodes).join("|") || "NONE";
        rawOpenSummary = summarizeOpenOrdersBySide(rawOpenOrders);
        managedOpenSummary = summarizeOpenOrdersBySide(openOrders);
        const decisionForState = issueCodeSummary === "NONE" ? decision : `${decision}|${issueCodeSummary}`;
        transitionDevmmState(exchange, config.symbol, finalStatus as any, finalReason, {
            lastOkAgeSec: balances.lastOkAgeSec,
            failCount: balances.failCount,
            bookSource: ob.bookSource,
            lastDecision: decisionForState,
        });

        // Summary log line for observability
        const invStr = `${balances.usdt.toFixed(2)} USDT / ${balances.pepew.toFixed(0)} PEPEW (${(usdtShare * 100).toFixed(1)}%)`;
        log(
            "info",
            exchange,
            `tick strategyId=${config.id} phase=${phase} bootstrapDone=${bootstrapLifecycle.done} managedOpenOrders=${openOrders.length} rawOpenOrders=${rawOpenOrders.length} rawBuy=${rawOpenSummary.buy} rawSell=${rawOpenSummary.sell} rawUnknown=${rawOpenSummary.unknown} managedBuy=${managedOpenSummary.buy} managedSell=${managedOpenSummary.sell} pendingCount=${finalPendingCount} dailyCapBypassed=${dailyCapBypassed} status=${finalStatus} decision=${decision} skipReason=${Array.from(skipReasons).join("|") || "NONE"} issueCode=${issueCodeSummary} orderAttempt=${orderAttempts.join("|") || "NONE"} orderResult=${orderResults.join("|") || "NONE"} capBlockedDaily=${capBlockedDaily} capBlockedHourly=${capBlockedHourly} bid=${ob.bid} ask=${ob.ask} inv=${invStr} maxNewOrdersPerTick=${maxNewOrdersPerTick} forceSpreadTicks=${forceSpreadTicks} priceTickUsed=${priceTickUsed}`
        );

    } catch (err: any) {
        log("error", exchange, `Tick error: ${err.message}`);
        insertTradeAudit({
            strategyId: config.id,
            strategyType: "DEVMM",
            exchange,
            pair: config.symbol,
            action: "error",
            reason: err.message || "TICK_ERROR",
        });
        updateDevmmError(exchange, config.symbol, err.message);
    } finally {
        runningExchanges.delete(exchange);
    }
}

// DevMM uses its own tick interval logic based on config.refresh_seconds
// The main scheduler calls this, but we apply jitter internally
const lastTickAt = new Map<DevmmExchange, number>();

export const devmmRunner: StrategyRunner = {
    type: "DEVMM",

    async tick(configId: number, now: number): Promise<void> {
        const config = getDevmmConfigById(configId);
        if (!config) {
            tradeLog({
                scope: "devmmRunner",
                level: "warn",
                strategyId: configId,
                message: `config not found id=${configId}`,
                throttleKey: `devmm:missing-config:${configId}`,
                throttleSec: 30,
            });
            return;
        }

        const exchangeRaw = String(config.exchange || "");
        if (!isSupportedExchange(exchangeRaw)) {
            const available = SUPPORTED_EXCHANGES.join(",");
            tradeLog({
                scope: "devmmRunner",
                level: "error",
                strategyId: configId,
                exchange: exchangeRaw,
                message: `INVALID_EXCHANGE available=${available}`,
            });
            upsertDevmmState(exchangeRaw as DevmmExchange, config.symbol, { status: "PAUSED", pause_reason: DevmmPauseReason.INVALID_EXCHANGE });
            updateDevmmError(exchangeRaw as DevmmExchange, config.symbol, DevmmPauseReason.INVALID_EXCHANGE);
            return;
        }

        const exchange = exchangeRaw as DevmmExchange;
        const lastTick = lastTickAt.get(exchange) || 0;
        const jitter = Math.random() * config.refresh_jitter_seconds * 1000;
        const interval = config.refresh_seconds * 1000 + jitter;

        if (now - lastTick < interval) {
            return; // Not time yet
        }

        lastTickAt.set(exchange, now);
        await tickDevmm(config, now);
    },
};
