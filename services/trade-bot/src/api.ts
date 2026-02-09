import fetch from "node-fetch";

const API_BASE = process.env.TRADE_API_BASE || "http://127.0.0.1:9195";

export class ApiError extends Error {
    path: string;
    status: number | null;

    constructor(path: string, status: number | null, message: string) {
        super(message);
        this.path = path;
        this.status = status;
        this.name = "ApiError";
    }
}

interface PriceEntry {
    exchange: "NonKYC" | "Dex-Trade" | "NestEX";
    pair: string;
    price: number | null;
    volume24h: number | null;
    quote: "USD" | "BNB";
    volumeNote?: "not_provided";
}

interface PriceResponse {
    ok: boolean;
    ts: number;
    prices: PriceEntry[];
}

interface DcaConfig {
    id: number;
    tgUserId: string;
    exchange: string;
    pair: string;
    symbol: string;
    quoteCcy: string;
    budget: number;
    intervalSec: number;
    enabled: boolean;
    tradeMode: "REAL";
    strategy: string;
    lastRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    maxTotalSpend?: number | null;
    endsAt?: number | null;
}

interface DcaOrder {
    id: number;
    exchange: string;
    pair: string;
    symbol: string;
    side: string;
    quoteAmount: number;
    price: number | null;
    status: string;
    tradeMode: string;
    strategy: string;
    createdAt: number;
}

interface DcaStatusResponse {
    ok: boolean;
    configs: DcaConfig[];
    recentOrders: DcaOrder[];
    donateAddress: string;
}

interface DcaConfigResponse {
    ok: boolean;
    config: DcaConfig;
    donateAddress: string;
    error?: string;
}

interface SimpleResponse {
    ok: boolean;
    message?: string;
    error?: string;
}

export interface StrategyConfig {
    id: number;
    tgUserId: string;
    exchange: string;
    pair: string;
    tradeMode: "REAL";
    strategy: "DCA" | "GRID" | "MM";
    enabled: boolean;
    lastRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    params?: Record<string, any> | null;
    notes?: string | null;
    disabledReason?: string | null;
    consecutiveFailures?: number;
    lastAction?: string | null;
    lastActionAt?: number | null;
    lastFailure?: {
        category: string;
        message: string;
        lastSeenAt: number;
        count: number;
        httpStatus?: number | null;
        exchangeCode?: string | null;
        details?: any;
    } | null;
    backoff?: {
        until: number;
        remainingSec: number;
    } | null;
    inventoryWarning?: string | null;
    currentInventory?: {
        PEPEW: number;
        USDT: number;
        fetchedAt: number;
    } | null;
}

export interface StrategyOrder {
    id: number;
    configId: number;
    exchange: string;
    pair: string;
    strategy: string;
    tradeMode: string;
    side: string;
    price: number | null;
    qty: number | null;
    quoteQty: number | null;
    status: string;
    createdAt: number;
}

export interface StrategyFill {
    id: number;
    configId: number;
    orderId: number;
    exchange: string;
    pair: string;
    strategy: string;
    tradeMode: string;
    side: string;
    price: number;
    qty: number;
    quoteQty: number;
    ts: number;
}

export interface NormalizedBalance {
    ok: boolean;
    exchange: string;
    assets: {
        USDT: number;
        BNB: number;
        PEPEW: number;
    };
    error?: string;
    reason?: string;
    errCode?: string;
    lastOkTs?: number;
    snapshot?: {
        ts: number;
        stalenessMs: number;
        source: "live" | "cached";
        rawHash: string;
        assets: Record<string, { free: number; locked: number; total: number }>;
    };
}

interface StrategyStatusResponse {
    ok: boolean;
    configs: StrategyConfig[];
    recentOrders: StrategyOrder[];
    recentFills: StrategyFill[];
    balances?: NormalizedBalance[];
    debug?: {
        balance_source: string;
        fetchedAt: number;
        cacheAgeMs: number;
        isCached: boolean;
        symbolsFound: string[];
        freeQuote: number;
        freePEPEW: number;
    } | null;
}

export interface BalanceSummaryResponse {
    ok: boolean;
    exchanges: Array<{
        exchangeId: "nonkyc" | "dextrade" | "nestex";
        ok: boolean;
        errCode: string | null;
        errMsgShort: string | null;
        lastOkTs: number | null;
        snapshot: {
            ts: number;
            stalenessMs: number;
            source: "live" | "cached";
            rawHash: string;
            assets: Record<string, { free: number; locked: number; total: number }>;
        } | null;
        assets: { USDT: number; BNB: number; PEPEW: number };
    }>;
}

export interface ExchangeRegistryResponse {
    ok: boolean;
    exchanges: Array<{
        exchangeId: "nonkyc" | "dextrade" | "nestex";
        displayName: string;
        adapterKey: "nonkyc" | "dextrade" | "nestex";
        pairs: string[];
        symbolMapping: Record<string, string>;
        limits: { byPair: Record<string, { minNotional: number; minQuotePerOrder: number }> };
        precision: { priceTick: number; qtyStep: number; priceRounding: string; qtyRounding: string };
    }>;
}

async function fetchApi<T>(path: string, options?: { method?: string; body?: any }): Promise<T> {
    const url = `${API_BASE}${path}`;
    const fetchOptions: any = {
        method: options?.method || "GET",
        headers: { "Content-Type": "application/json" },
    };
    if (options?.body) {
        fetchOptions.body = JSON.stringify(options.body);
    }

    let res: any;
    try {
        res = await fetch(url, fetchOptions);
    } catch (err: any) {
        throw new ApiError(path, null, err?.message || "Network error");
    }

    let data: any;
    try {
        data = await res.json();
    } catch (err: any) {
        throw new ApiError(path, res.status || null, "Invalid JSON response");
    }

    if (!res.ok) {
        const errorCode = typeof data?.error === "string" ? data.error.trim() : "";
        const errorMessage = typeof data?.message === "string" ? data.message.trim() : "";
        let message = errorMessage || errorCode || res.statusText || "Request failed";
        if (errorCode && errorMessage && !errorMessage.includes(errorCode)) {
            message = `${errorCode}: ${errorMessage}`;
        }
        throw new ApiError(path, res.status || null, message);
    }

    return data as T;
}

export function getApiBase(): string {
    return API_BASE;
}

export async function getPrice(): Promise<PriceResponse> {
    return fetchApi<PriceResponse>("/v1/price");
}

export async function setDcaConfig(
    config: {
        tgUserId: string;
        mode?: "BNB" | "USDT";
        exchange?: "nonkyc" | "dextrade" | "nestex";
        symbol?: string;
        quoteAsset?: "BNB" | "USDT";
        quoteCcy?: "BNB" | "USDT";
        intervalSec: number;
        budget?: number;
        budgetQuotePerOrder?: number;
        tradeMode?: "REAL";
        enabled?: boolean;
        maxTotalSpend?: number;
        runForMinutes?: number;
    }
): Promise<DcaConfigResponse> {
    return fetchApi<DcaConfigResponse>("/v1/dca/config", {
        method: "POST",
        body: config,
    });
}

export async function startDca(payload: {
    tgUserId: string;
    configId?: number;
    exchange?: "nonkyc" | "dextrade" | "nestex";
    pair?: string;
    tradeMode?: "REAL";
}): Promise<SimpleResponse & { config?: DcaConfig }> {
    return fetchApi<SimpleResponse & { config?: DcaConfig }>("/v1/dca/start", {
        method: "POST",
        body: payload,
    });
}

export async function stopDca(payload: {
    tgUserId: string;
    configId?: number;
    exchange?: "nonkyc" | "dextrade" | "nestex";
    pair?: string;
    tradeMode?: "REAL";
    stopAll?: boolean;
}): Promise<SimpleResponse & { config?: DcaConfig }> {
    return fetchApi<SimpleResponse & { config?: DcaConfig }>("/v1/dca/stop", {
        method: "POST",
        body: payload,
    });
}

export async function getDcaStatus(tgUserId: string): Promise<DcaStatusResponse> {
    return fetchApi<DcaStatusResponse>(`/v1/dca/status?tgUserId=${encodeURIComponent(tgUserId)}`);
}

export async function upsertStrategyConfig(payload: {
    tgUserId: string;
    exchange: "nonkyc" | "dextrade" | "nestex";
    pair: string;
    tradeMode?: "REAL";
    strategy: "DCA" | "GRID" | "MM";
    enabled?: boolean;
    params?: Record<string, any>;
    paramsJson?: string;
    notes?: string;
}): Promise<{ ok: boolean; config?: StrategyConfig; error?: string }> {
    return fetchApi<{ ok: boolean; config?: StrategyConfig; error?: string }>("/v1/strategy/config/upsert", {
        method: "POST",
        body: payload,
    });
}

export async function enableStrategyConfig(configId: number, tgUserId: string): Promise<SimpleResponse & { config?: StrategyConfig }> {
    return fetchApi<SimpleResponse & { config?: StrategyConfig }>(`/v1/strategy/config/${configId}/enable`, {
        method: "POST",
        body: { tgUserId },
    });
}

export async function disableStrategyConfig(
    configId: number,
    tgUserId: string,
    reason?: string
): Promise<SimpleResponse & { config?: StrategyConfig }> {
    return fetchApi<SimpleResponse & { config?: StrategyConfig }>(`/v1/strategy/config/${configId}/disable`, {
        method: "POST",
        body: reason ? { tgUserId, reason } : { tgUserId },
    });
}

export async function getStrategyStatus(tgUserId: string): Promise<StrategyStatusResponse> {
    return fetchApi<StrategyStatusResponse>(`/v1/strategy/status?tg_user_id=${encodeURIComponent(tgUserId)}`);
}

export async function getBalancesSummary(tgUserId: string): Promise<BalanceSummaryResponse> {
    return fetchApi<BalanceSummaryResponse>(`/v1/balances/summary?tg_user_id=${encodeURIComponent(tgUserId)}`);
}

export async function getExchangeRegistry(): Promise<ExchangeRegistryResponse> {
    return fetchApi<ExchangeRegistryResponse>("/v1/registry/exchanges");
}

export async function getHealth(): Promise<SimpleResponse> {
    return fetchApi<SimpleResponse>("/healthz");
}

export type ReportPeriod = "daily" | "weekly" | "monthly";
export type ReportExchange = "nonkyc" | "dextrade" | "nestex";

export interface StrategyReportMetrics {
    strategy: "dca" | "grid" | "mm" | "devmm" | "total";
    fillCount: number;
    orderCount: number;
    quoteVolume: number;
    baseVolume: number;
    fee: number;
    netQuote: number;
}

export interface StrategyReportResponse {
    ok: boolean;
    period: ReportPeriod;
    exchange: ReportExchange;
    bucket: string;
    report: {
        dca: StrategyReportMetrics;
        grid: StrategyReportMetrics;
        mm: StrategyReportMetrics;
        devmm: StrategyReportMetrics;
        total: StrategyReportMetrics;
    };
    error?: string;
}

export async function getStrategyReport(
    tgUserId: string,
    period: ReportPeriod,
    exchange: ReportExchange
): Promise<StrategyReportResponse> {
    const qs = `?tg_user_id=${encodeURIComponent(tgUserId)}&period=${encodeURIComponent(period)}&exchange=${encodeURIComponent(exchange)}`;
    return fetchApi<StrategyReportResponse>(`/v1/strategy/report${qs}`);
}

interface KeysStatusEntry {
    exchange: string;
    updatedAt: number | null;
    createdAt: number | null;
    validation?: {
        ok: boolean;
        reason?: string;
        message?: string;
    };
}

interface KeysStatusResponse {
    ok: boolean;
    keys: KeysStatusEntry[];
    error?: string;
}

export async function setExchangeKeys(
    tgUserId: string,
    exchange: "nonkyc" | "dextrade" | "nestex",
    apiKey: string,
    apiSecret: string,
    validate?: boolean
): Promise<SimpleResponse & { validation?: { ok: boolean; error?: string; details?: any } }> {
    return fetchApi<SimpleResponse & { validation?: { ok: boolean; error?: string; details?: any } }>("/v1/keys/set", {
        method: "POST",
        body: { tgUserId, exchange, apiKey, apiSecret, validate },
    });
}

export async function clearExchangeKeys(
    tgUserId: string,
    exchange: "nonkyc" | "dextrade" | "nestex"
): Promise<SimpleResponse & { cleared?: boolean }> {
    return fetchApi<SimpleResponse & { cleared?: boolean }>("/v1/keys/clear", {
        method: "POST",
        body: { tgUserId, exchange },
    });
}

export async function getKeysStatus(
    tgUserId: string,
    exchange?: "nonkyc" | "dextrade" | "nestex",
    validate?: boolean
): Promise<KeysStatusResponse> {
    const qs = exchange ? `&exchange=${encodeURIComponent(exchange)}` : "";
    const validateQs = validate ? "&validate=1" : "";
    return fetchApi<KeysStatusResponse>(`/v1/keys/status?tgUserId=${encodeURIComponent(tgUserId)}${qs}${validateQs}`);
}

export async function validateExchangeKeys(
    tgUserId: string,
    exchange: "nonkyc" | "dextrade" | "nestex",
    apiKey: string,
    apiSecret: string
): Promise<SimpleResponse & { validation?: { ok: boolean; error?: string; details?: any } }> {
    return fetchApi<SimpleResponse & { validation?: { ok: boolean; error?: string; details?: any } }>("/v1/keys/validate", {
        method: "POST",
        body: { tgUserId, exchange, apiKey, apiSecret },
    });
}

// Funds check types
export interface FundsCheckResponse {
    ok: boolean;
    status?: "PASS" | "WARN" | "FAIL";
    messages?: string[];
    need?: {
        needUSDT: number;
        needPEPEW: number;
        notes: string[];
    };
    available?: {
        freeUSDT: number;
        freePEPEW: number;
    } | null;
    error?: string;
    message?: string;
}

export interface BalanceResponse {
    ok: boolean;
    exchange?: string;
    assets?: {
        USDT: number;
        BNB: number;
        PEPEW: number;
    };
    freeQuote?: number; // Legacy support
    freePEPEW?: number; // Legacy support
    fetchedAt?: number;
    error?: string;
    message?: string;
    reason?: string;
}

export async function checkStrategyFunds(
    tgUserId: string,
    exchange: "nonkyc" | "dextrade" | "nestex",
    pair: string,
    strategy: "DCA" | "GRID" | "MM",
    params: Record<string, any>
): Promise<FundsCheckResponse> {
    return fetchApi<FundsCheckResponse>("/v1/strategy/funds-check", {
        method: "POST",
        body: { tgUserId, exchange, pair, strategy, params },
    });
}

export async function getNonKycBalance(tgUserId: string): Promise<BalanceResponse> {
    return fetchApi<BalanceResponse>(`/v1/balance/nonkyc?tgUserId=${encodeURIComponent(tgUserId)}`);
}

export async function getBalance(tgUserId: string, exchange: string): Promise<BalanceResponse> {
    return fetchApi<BalanceResponse>(`/v1/balance?tgUserId=${encodeURIComponent(tgUserId)}&exchange=${encodeURIComponent(exchange)}`);
}

export interface CancelOrdersResponse {
    ok: boolean;
    queued?: boolean;
    message?: string;
    cancelledCount?: number;
    failedCount?: number;
    error?: string;
}

export async function cancelStrategyOrders(configId: number, tgUserId: string): Promise<CancelOrdersResponse> {
    return fetchApi<CancelOrdersResponse>(`/v1/strategy/config/${configId}/cancel-orders`, {
        method: "POST",
        body: { tgUserId },
    });
}

// DevMM API Types and Functions

export interface DevmmStatusEntry {
    exchange: string;
    requestedExchange?: string;
    normalizedExchange?: string;
    resolvedExchange?: string;
    adapterKey?: string;
    status: "ACTIVE" | "DEGRADED" | "PAUSED" | "STOPPED" | "NOT_CONFIGURED";
    pauseReason?: string | null;
    isEnabled?: boolean;
    openOrdersBySide?: {
        buy: number;
        sell: number;
    };
    openOrdersSource?: string;
    config?: {
        symbol: string;
        orderQuoteUsdt: number;
        minNotionalUsdt: number;
        buyOffsetPct: number;
        sellOffsetPct: number;
        refreshSeconds: number;
        capRatio: number;
    } | null;
    turnover?: {
        todayUsdt: number;
        capDayUsdt: number;
        hourUsdt: number;
        capHourUsdt: number;
        vol24hUsdt: number;
        vol24hEstimate?: boolean;
    } | null;
    inventory?: ({
        status: "unavailable";
        reason?: string | null;
    } | {
        usdtBalance: number | null;
        pepewBalance: number | null;
        usdtShare: number | null;
    }) | null;
    market?: {
        bid: number | null;
        ask: number | null;
        mid: number | null;
        ref: number | null;
        spread: number | null;
    } | null;
    orders?: {
        buyOrderId: string | null;
        sellOrderId: string | null;
    } | null;
    lastAction?: string | null;
    lastActionAt?: number | null;
    lastDecision?: string | null;
    lastError?: string | null;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
    lastErrorAt?: number | null;
    balanceLastOkTs?: number | null;
    balanceLastOkAgeSec?: number | null;
    balanceLastErrCode?: string | null;
    cooldownUntil?: number | null;
    updatedAt?: number | null;
}

export interface DevmmReportEntry {
    exchange: string;
    period: string;
    bucket: string | null;
    buyTurnoverUsdt?: number;
    sellTurnoverUsdt?: number;
    totalTurnoverUsdt?: number;
    buyQtyPepew?: number;
    sellQtyPepew?: number;
    buyVwap?: number | null;
    sellVwap?: number | null;
    overallVwap?: number | null;
    totalFeeUsdt?: number | null;
    netUsdtChange?: number;
    netPepewChange?: number;
    fillCount?: number;
    message?: string;
}

export async function devmmStart(params: {
    exchange: "nonkyc" | "dextrade" | "nestex";
    tgUserId: string;
    orderQuoteUsdt?: number;
    refreshSeconds?: number;
}): Promise<{ ok: boolean; message?: string; config?: any; error?: string }> {
    return fetchApi<{ ok: boolean; message?: string; config?: any; error?: string }>("/v1/devmm/start", {
        method: "POST",
        body: params,
    });
}

export async function devmmStop(exchange: "nonkyc" | "dextrade" | "nestex"): Promise<{
    ok: boolean;
    message?: string;
    ordersAttempted?: number;
    ordersVisibleBefore?: number;
    ordersCancelled?: number;
    ordersAlreadyClosed?: number;
    ordersFailed?: number;
    error?: string;
}> {
    return fetchApi<{
        ok: boolean;
        message?: string;
        ordersAttempted?: number;
        ordersVisibleBefore?: number;
        ordersCancelled?: number;
        ordersAlreadyClosed?: number;
        ordersFailed?: number;
        error?: string;
    }>("/v1/devmm/stop", {
        method: "POST",
        body: { exchange },
    });
}

export async function devmmStatus(exchange?: "nonkyc" | "dextrade" | "nestex"): Promise<{
    ok: boolean;
    exchanges?: DevmmStatusEntry[];
    error?: string;
}> {
    const qs = exchange ? `?exchange=${encodeURIComponent(exchange)}` : "";
    return fetchApi<{ ok: boolean; exchanges?: DevmmStatusEntry[]; error?: string }>(`/v1/devmm/status${qs}`);
}

export async function devmmReport(params?: {
    exchange?: "nonkyc" | "dextrade" | "nestex";
    period?: "daily" | "weekly" | "monthly";
}): Promise<{
    ok: boolean;
    reports?: DevmmReportEntry[];
    error?: string;
}> {
    const qsParts: string[] = [];
    if (params?.exchange) qsParts.push(`exchange=${encodeURIComponent(params.exchange)}`);
    if (params?.period) qsParts.push(`period=${encodeURIComponent(params.period)}`);
    const qs = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";
    return fetchApi<{ ok: boolean; reports?: DevmmReportEntry[]; error?: string }>(`/v1/devmm/report${qs}`);
}
