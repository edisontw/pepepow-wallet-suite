/**
 * NonKYC Exchange API Connector
 * 
 * API docs: https://api.nonkyc.io/api/v2
 * Auth method: HMAC-SHA256
 * 
 * Signature formula (per official NonKYCExchange/nonkycapinodehmac):
 *   HMAC-SHA256(apiKey + fullUrl + JSON.stringify(body) + nonce, apiSecret)
 */

import crypto from "crypto";
import fetch from "node-fetch";

const NONKYC_API_BASE = process.env.NONKYC_API_BASE || "https://api.nonkyc.io/api/v2";
const NONKYC_DEBUG = process.env.NONKYC_DEBUG === "1" || process.env.NONKYC_DEBUG === "true";

export type NonKycOrderSide = "buy" | "sell";
export type NonKycOrderType = "limit" | "market";

export interface NonKycMarketRules {
    symbol: string;
    minNotional: number;
    minQty: number;
    qtyStep: number;
    priceTick: number;
    source: "fallback";
}

const NONKYC_RULES_FALLBACK: Record<string, NonKycMarketRules> = {
    PEPEW_USDT: {
        symbol: "PEPEW_USDT",
        minNotional: 1,
        minQty: 1,
        qtyStep: 1,
        priceTick: 1e-12,
        source: "fallback",
    },
    PEPEW_BNB: {
        symbol: "PEPEW_BNB",
        minNotional: 0.0016,
        minQty: 1,
        qtyStep: 1,
        priceTick: 1e-12,
        source: "fallback",
    },
};

const loggedMarketFallbacks = new Set<string>();

function inferQuoteFromSymbol(symbol: string): "USDT" | "BNB" | null {
    const upper = symbol.toUpperCase();
    if (upper.endsWith("_USDT") || upper.endsWith("USDT")) return "USDT";
    if (upper.endsWith("_BNB") || upper.endsWith("BNB")) return "BNB";
    return null;
}

export async function getNonkycMarketRules(symbol: string): Promise<NonKycMarketRules> {
    const normalized = symbol.toUpperCase();
    const fallback = NONKYC_RULES_FALLBACK[normalized];
    if (fallback) return fallback;

    const quote = inferQuoteFromSymbol(normalized);
    const minNotional = quote === "BNB" ? 0.001 : 1;
    const rules: NonKycMarketRules = {
        symbol: normalized,
        minNotional,
        minQty: 1,
        qtyStep: 1,
        priceTick: 1e-12,
        source: "fallback",
    };

    if (!loggedMarketFallbacks.has(normalized)) {
        console.warn(`[nonkyc] market rules fallback used for ${normalized} (minNotional=${minNotional})`);
        loggedMarketFallbacks.add(normalized);
    }

    return rules;
}

export interface NonKycOrderRequest {
    accessKey: string;
    secretKey: string;
    symbol: string;      // e.g. "PEPEW_BNB"
    side: NonKycOrderSide;
    quantity: number;
    price?: number;      // Required for limit orders
    orderType: NonKycOrderType;
    userProvidedId?: string;
}

export interface NonKycOrderResult {
    ok: boolean;
    status: number;
    orderId?: string;
    data?: any;
    error?: string;
    code?: string | number;
    reason?: string;
    debug?: NonKycErrorDetails;
}

export interface NonKycBalanceResult {
    ok: boolean;
    status: number;
    data?: any;
    error?: string;
    reason?: string;
    debug?: NonKycErrorDetails;
}

export interface NonKycErrorDetails {
    status: number;
    statusText?: string;
    method: string;
    baseURL: string;
    url: string;
    endpoint: string;
    query?: Record<string, string>;
    requestHeaders?: Record<string, string>;
    requestBody?: any;
    responseHeaders?: Record<string, string>;
    responseData?: any;
    elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve market identifier for NonKYC API.
 * Ensures consistent mapping (e.g., PEPEW/USDT -> PEPEW_USDT) across all endpoints.
 */
export function resolveNonKycMarket(symbol: string): string {
    return normalizeNonKycSymbol(symbol);
}

/**
 * Normalize symbol to NonKYC API format: BASE_QUOTE (uppercase, underscore separator)
 * Examples:
 *   "PEPEW/USDT" -> "PEPEW_USDT"
 *   "pepew_usdt" -> "PEPEW_USDT"
 *   "PEPEWUSDT"  -> "PEPEW_USDT" (if known pair)
 */
export function normalizeNonKycSymbol(symbol: string): string {
    if (!symbol) return symbol;

    // Already in correct format
    let normalized = symbol.toUpperCase().trim();

    // Replace / with _
    normalized = normalized.replace(/\//g, "_");

    // Handle concatenated symbols (e.g., PEPEWUSDT -> PEPEW_USDT)
    if (!normalized.includes("_")) {
        if (normalized.endsWith("USDT")) {
            normalized = normalized.slice(0, -4) + "_USDT";
        } else if (normalized.endsWith("BNB")) {
            normalized = normalized.slice(0, -3) + "_BNB";
        }
    }

    return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug Helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskSecret(secret: string): string {
    if (!secret || secret.length < 8) return "***";
    return secret.slice(0, 4) + "..." + secret.slice(-4);
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase().includes("key") || k.toLowerCase().includes("sign")) {
            masked[k] = maskSecret(v);
        } else {
            masked[k] = v;
        }
    }
    return masked;
}

function debugLog(label: string, data: any): void {
    if (!NONKYC_DEBUG) return;
    console.log(`[nonkyc:debug] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data);
}

function safeJsonParse(text: string): any | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function maskValue(value: any): any {
    if (typeof value !== "string") return value;
    if (value.length < 8) return "***";
    return value.slice(0, 4) + "..." + value.slice(-4);
}

function maskObject(value: any): any {
    if (Array.isArray(value)) {
        return value.map((item) => maskObject(item));
    }
    if (value && typeof value === "object") {
        const masked: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
            const keyLower = k.toLowerCase();
            if (
                keyLower.includes("key") ||
                keyLower.includes("secret") ||
                keyLower.includes("sign") ||
                keyLower.includes("token") ||
                keyLower.includes("signature")
            ) {
                masked[k] = maskValue(v);
            } else {
                masked[k] = maskObject(v);
            }
        }
        return masked;
    }
    return value;
}

function stringifyData(data: any): string {
    if (data === null || data === undefined) return "";
    if (typeof data === "string") return data;
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

function buildErrorDetails(params: {
    request: NonKycRequest;
    status: number;
    statusText?: string;
    responseHeaders?: Record<string, string>;
    responseData?: any;
    elapsedMs: number;
}): NonKycErrorDetails {
    const urlObj = new URL(params.request.url);
    const query: Record<string, string> = {};
    urlObj.searchParams.forEach((value, key) => {
        query[key] = value;
    });
    const requestBody = params.request.body ? safeJsonParse(params.request.body) ?? params.request.body : undefined;

    return {
        status: params.status,
        statusText: params.statusText,
        method: params.request.method,
        baseURL: NONKYC_API_BASE,
        url: params.request.url,
        endpoint: urlObj.pathname.replace(new URL(NONKYC_API_BASE).pathname, "") || urlObj.pathname,
        query: Object.keys(query).length ? query : undefined,
        requestHeaders: maskHeaders(params.request.headers),
        requestBody: requestBody !== undefined ? maskObject(requestBody) : undefined,
        responseHeaders: params.responseHeaders,
        responseData: params.responseData,
        elapsedMs: params.elapsedMs,
    };
}

function detectNonKycReason(status: number, responseData: any): string | undefined {
    const text = stringifyData(responseData).toLowerCase();
    const has = (value: string) => text.includes(value);

    if (status === 403 && (has("ip") && (has("whitelist") || has("not allowed") || has("blocked")))) {
        return "IP_BLOCKED";
    }
    if (has("signature") || has("hmac") || has("timestamp") || has("nonce")) {
        return "SIGNATURE_MISMATCH";
    }
    if (has("permission") || has("access")) {
        return "PERMISSION_DENIED";
    }
    if (has("minimum order") || has("min order") || has("min notional")) {
        return "MIN_NOTIONAL";
    }
    if (has("minimum quantity") || has("min quantity") || has("lot") || has("step")) {
        return "MIN_QTY";
    }
    if (has("precision") || has("tick")) {
        return "PRECISION";
    }
    if (status === 404 || has("endpoint not found") || has("not found") || has("invalid route")) {
        return "ENDPOINT_INVALID";
    }
    if (status === 401 || status === 403) {
        return "AUTH_FAILED";
    }
    return undefined;
}

function summarizeNonKycError(params: { status: number; statusText?: string; error?: any; responseData?: any; reason?: string }): string {
    const parts = [`status=${params.status}`];
    if (params.statusText) parts.push(`statusText=${params.statusText}`);
    if (params.reason) parts.push(`reason=${params.reason}`);
    const errorText = stringifyData(params.error);
    if (errorText) parts.push(`error=${errorText}`);
    const dataText = stringifyData(params.responseData);
    if (dataText) parts.push(`data=${dataText}`);
    return parts.join(" | ");
}

function extractErrorMessage(responseData: any, statusText?: string): string {
    if (!responseData) return statusText || "Request failed";
    if (typeof responseData === "string") return responseData;
    if (typeof responseData === "object") {
        const err = (responseData as any).error;
        if (typeof err === "string") return err;
        if (err && typeof err === "object") {
            const code = err.code ?? err.errorCode ?? err.statusCode;
            const message = err.message || err.msg || err.description;
            if (code && message) return `code=${code} message=${message}`;
            if (message) return String(message);
            if (code) return `code=${code}`;
        }
        if (typeof (responseData as any).message === "string") return (responseData as any).message;
        if (typeof (responseData as any).msg === "string") return (responseData as any).msg;
    }
    return statusText || "Request failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 Signature Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate HMAC-SHA256 signature per NonKYC official spec:
 *   signature = HMAC-SHA256(apiKey + fullUrl + bodyString + nonce, apiSecret)
 */
function generateSignature(
    apiKey: string,
    fullUrl: string,
    bodyString: string,
    nonce: string,
    apiSecret: string
): string {
    const canonical = apiKey + fullUrl + bodyString + nonce;

    debugLog("canonical (masked)",
        maskSecret(apiKey) + " + " + fullUrl + " + " + bodyString + " + " + nonce);

    const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(canonical)
        .digest("hex");

    debugLog("signature", maskSecret(signature));

    return signature;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Request Builder
// ─────────────────────────────────────────────────────────────────────────────

interface NonKycRequestParams {
    method: "GET" | "POST" | "DELETE";
    endpoint: string;
    body?: Record<string, any>;
    apiKey: string;
    apiSecret: string;
}

interface NonKycRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    debug: {
        canonical: string;
        signatureMasked: string;
        headersMasked: Record<string, string>;
    };
}

export function buildNonkycRequest(params: NonKycRequestParams): NonKycRequest {
    const { method, endpoint, body, apiKey, apiSecret } = params;
    const nonce = String(Date.now());
    const url = `${NONKYC_API_BASE}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;
    const bodyString = body ? JSON.stringify(body) : "";

    const signature = generateSignature(apiKey, url, bodyString, nonce, apiSecret);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
        "X-API-NONCE": nonce,
        "X-API-SIGN": signature,
    };

    const maskedHeaders = maskHeaders(headers);
    const canonicalMasked = maskSecret(apiKey) + " + " + url + " + " + bodyString + " + " + nonce;

    debugLog("request", {
        method,
        url,
        headers: maskedHeaders,
        body: body || "(none)",
    });

    return {
        url,
        method,
        headers,
        body: bodyString || undefined,
        debug: {
            canonical: canonicalMasked,
            signatureMasked: maskSecret(signature),
            headersMasked: maskedHeaders,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private API Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch account balances (private endpoint - good for auth verification)
 */
export async function getNonkycBalances(
    accessKey: string,
    secretKey: string
): Promise<NonKycBalanceResult> {
    const req = buildNonkycRequest({
        method: "GET",
        endpoint: "/balances",
        apiKey: accessKey,
        apiSecret: secretKey,
    });

    try {
        const start = Date.now();
        const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
        });

        const status = res.status;
        const rawText = await res.text();
        const data = safeJsonParse(rawText) ?? rawText;
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const elapsedMs = Date.now() - start;

        if (!res.ok) {
            const errMsg = extractErrorMessage(data, res.statusText);
            const reason = detectNonKycReason(status, data);
            const debug = buildErrorDetails({
                request: req,
                status,
                statusText: res.statusText,
                responseHeaders,
                responseData: data,
                elapsedMs,
            });
            console.error(`[nonkyc] balances failed: ${summarizeNonKycError({ status, statusText: res.statusText, error: errMsg, responseData: data, reason })}`);
            console.error(`[nonkyc] balances error details: ${JSON.stringify(debug)}`);
            return { ok: false, status, error: errMsg, reason, data, debug };
        }

        debugLog("balances response", { status, count: Array.isArray(data) ? data.length : "N/A" });
        return { ok: true, status, data };

    } catch (err: any) {
        console.error(`[nonkyc] balances error: ${err?.message || err}`);
        const debug = buildErrorDetails({
            request: req,
            status: 0,
            statusText: "NETWORK_ERROR",
            responseHeaders: undefined,
            responseData: { error: err?.message || "Network error" },
            elapsedMs: 0,
        });
        console.error(`[nonkyc] balances error details: ${JSON.stringify(debug)}`);
        return { ok: false, status: 0, error: err?.message || "Network error", reason: "NETWORK_ERROR", debug };
    }
}

/**
 * Create an order on NonKYC exchange
 */
export async function createNonKycOrder(req: NonKycOrderRequest): Promise<NonKycOrderResult> {
    const marketKey = resolveNonKycMarket(req.symbol);
    const keyFingerprint = maskSecret(req.accessKey);

    console.log(`[nonkyc] op=createOrder marketKey=${marketKey} symbolInput=${req.symbol} key_fingerprint=${keyFingerprint}`);

    // Build order payload
    const orderBody: Record<string, any> = {
        symbol: marketKey,
        side: req.side,
        type: req.orderType,
        quantity: req.quantity,
    };

    if (req.orderType === "limit") {
        if (typeof req.price !== "number" || !Number.isFinite(req.price) || req.price <= 0) {
            return { ok: false, status: 400, error: "Price is required for limit orders" };
        }
        orderBody.price = req.price;
    }

    if (req.userProvidedId) {
        orderBody.userProvidedId = req.userProvidedId;
    }

    const request = buildNonkycRequest({
        method: "POST",
        endpoint: "/createorder",
        body: orderBody,
        apiKey: req.accessKey,
        apiSecret: req.secretKey,
    });

    try {
        const start = Date.now();
        const res = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
        });

        const status = res.status;
        const rawText = await res.text();
        const data = safeJsonParse(rawText) ?? rawText;
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const elapsedMs = Date.now() - start;

        if (!res.ok) {
            const errMsg = extractErrorMessage(data, res.statusText);
            const reason = detectNonKycReason(status, data);
            const debug = buildErrorDetails({
                request,
                status,
                statusText: res.statusText,
                responseHeaders,
                responseData: data,
                elapsedMs,
            });
            const summary = summarizeNonKycError({ status, statusText: res.statusText, error: errMsg, responseData: data, reason });
            console.warn(`[nonkyc] order failed: ${summary}`);

            // Log additional debug info for auth failures
            if (status === 401 || status === 403) {
                console.warn(`[nonkyc] AUTH FAILURE - Check: 1) API key permissions, 2) IP whitelist, 3) Key expiration`);
                debugLog("auth failure details", {
                    status,
                    response: data,
                    requestDebug: request.debug,
                });
            }
            console.error(`[nonkyc] order error details: ${JSON.stringify(debug)}`);

            return {
                ok: false,
                status,
                error: summary,
                code: data?.code,
                reason,
                data,
                debug,
            };
        }

        const orderId = data?.order_id || data?.orderId || data?.id || null;
        console.log(`[nonkyc] order success: orderId=${orderId} symbol=${req.symbol} side=${req.side} qty=${req.quantity}`);

        return {
            ok: true,
            status,
            orderId,
            data,
        };

    } catch (err: any) {
        console.error(`[nonkyc] order error: ${err?.message || err}`);
        const debug = buildErrorDetails({
            request,
            status: 0,
            statusText: "NETWORK_ERROR",
            responseHeaders: undefined,
            responseData: { error: err?.message || "Network error" },
            elapsedMs: 0,
        });
        console.error(`[nonkyc] order error details: ${JSON.stringify(debug)}`);
        return {
            ok: false,
            status: 0,
            error: err?.message || "Network error",
            reason: "NETWORK_ERROR",
            debug,
        };
    }
}

/**
 * Cancel an order on NonKYC exchange
 */
export async function cancelNonKycOrder(
    accessKey: string,
    secretKey: string,
    orderId: string
): Promise<NonKycOrderResult> {
    const keyFingerprint = maskSecret(accessKey);
    console.log(`[nonkyc] op=cancelOrder orderId=${orderId} key_fingerprint=${keyFingerprint}`);

    const request = buildNonkycRequest({
        method: "POST",
        endpoint: "/cancelorder",
        body: { id: orderId },
        apiKey: accessKey,
        apiSecret: secretKey,
    });

    try {
        const start = Date.now();
        const res = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
        });

        const status = res.status;
        const rawText = await res.text();
        const data = safeJsonParse(rawText) ?? rawText;
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const elapsedMs = Date.now() - start;

        if (!res.ok) {
            const reason = detectNonKycReason(status, data);
            const debug = buildErrorDetails({
                request,
                status,
                statusText: res.statusText,
                responseHeaders,
                responseData: data,
                elapsedMs,
            });
            return {
                ok: false,
                status,
                error: summarizeNonKycError({
                    status,
                    statusText: res.statusText,
                    error: extractErrorMessage(data, res.statusText),
                    responseData: data,
                    reason,
                }),
                code: data?.code,
                data,
                reason,
                debug,
            };
        }

        return { ok: true, status, orderId, data };

    } catch (err: any) {
        console.error(`[nonkyc] cancel error: ${err?.message || err}`);
        const debug = buildErrorDetails({
            request,
            status: 0,
            statusText: "NETWORK_ERROR",
            responseHeaders: undefined,
            responseData: { error: err?.message || "Network error" },
            elapsedMs: 0,
        });
        console.error(`[nonkyc] cancel error details: ${JSON.stringify(debug)}`);
        return {
            ok: false,
            status: 0,
            error: err?.message || "Network error",
            reason: "NETWORK_ERROR",
            debug,
        };
    }
}

/**
 * Generate a curl command for manual testing (secrets masked)
 */
export function generateNonkycCurl(params: NonKycRequestParams): string {
    const req = buildNonkycRequest(params);

    let curl = `curl -X ${req.method} '${req.url}'`;

    for (const [k, v] of Object.entries(req.debug.headersMasked)) {
        curl += ` \\\n  -H '${k}: ${v}'`;
    }

    if (req.body) {
        curl += ` \\\n  -d '${req.body}'`;
    }

    return curl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Open Orders API
// ─────────────────────────────────────────────────────────────────────────────

export interface NonKycOpenOrder {
    order_id: string;
    symbol: string;
    side: string;
    type: string;
    price: number;
    quantity: number;
    filled_quantity?: number;
    userProvidedId?: string;
    status: string;
    created_at?: number;
}

export interface NonKycOpenOrdersResult {
    ok: boolean;
    status: number;
    orders?: NonKycOpenOrder[];
    data?: any;
    error?: string;
    reason?: string;
    debug?: NonKycErrorDetails;
}

/**
 * List open orders on NonKYC exchange
 * @param accessKey API access key
 * @param secretKey API secret key
 * @param symbol Optional symbol filter (will be normalized)
 */
export async function listNonKycOpenOrders(
    accessKey: string,
    secretKey: string,
    symbol?: string
): Promise<NonKycOpenOrdersResult> {
    const marketKey = symbol ? resolveNonKycMarket(symbol) : undefined;
    const keyFingerprint = maskSecret(accessKey);
    console.log(`[nonkyc] op=listOpenOrders marketKey=${marketKey || "ALL"} symbolInput=${symbol || "N/A"} key_fingerprint=${keyFingerprint}`);

    const endpoint = marketKey
        ? `/getorders?symbol=${encodeURIComponent(marketKey)}`
        : "/getorders";

    const req = buildNonkycRequest({
        method: "GET",
        endpoint,
        apiKey: accessKey,
        apiSecret: secretKey,
    });

    try {
        const start = Date.now();
        const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
        });

        const status = res.status;
        const rawText = await res.text();
        const data = safeJsonParse(rawText) ?? rawText;
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const elapsedMs = Date.now() - start;

        if (!res.ok) {
            const errMsg = extractErrorMessage(data, res.statusText);
            const reason = detectNonKycReason(status, data);
            const debug = buildErrorDetails({
                request: req,
                status,
                statusText: res.statusText,
                responseHeaders,
                responseData: data,
                elapsedMs,
            });
            console.error(`[nonkyc] openorders failed: ${summarizeNonKycError({ status, statusText: res.statusText, error: errMsg, responseData: data, reason })}`);
            return { ok: false, status, error: errMsg, reason, data, debug };
        }

        // Parse orders from response
        const orders: NonKycOpenOrder[] = [];
        const rawOrders = Array.isArray(data) ? data : (data?.orders ?? data?.data ?? []);
        for (const o of rawOrders) {
            orders.push({
                order_id: String(o.order_id ?? o.orderId ?? o.id ?? ""),
                userProvidedId: o.userProvidedId || o.clientOrderId || o.client_order_id || undefined,
                symbol: String(o.symbol ?? o.pair ?? ""),
                side: String(o.side ?? "").toLowerCase(),
                type: String(o.type ?? o.orderType ?? ""),
                price: Number(o.price) || 0,
                quantity: Number(o.quantity ?? o.amount ?? o.qty) || 0,
                filled_quantity: Number(o.filled_quantity ?? o.filledQty ?? o.executedQty) || 0,
                status: String(o.status ?? ""),
                created_at: Number(o.created_at || o.createdAt || o.timestamp || o.ts || 0),
            });
        }

        // Filter for open status (NonKYC typically uses 'Open', 'PartiallyFilled', 'Pending', etc.)
        const openOrders = orders.filter(o => {
            const s = o.status.toLowerCase();
            return s === "open" || s === "partiallyfilled" || s === "pending" || s === "new" || s === "active";
        });

        if (orders.length > 0 && NONKYC_DEBUG) {
            console.log(`[nonkyc:debug] listOpenOrders first 3 keys:`, orders.slice(0, 3).map(o => Object.keys(o)));
            console.log(`[nonkyc:debug] listOpenOrders sample[0]:`, JSON.stringify(orders[0]));
        }

        debugLog("openorders response", { status, exchangeOrderCount: rawOrders.length, openOrderCount: openOrders.length, marketKey });
        return { ok: true, status, orders: openOrders, data };

    } catch (err: any) {
        console.error(`[nonkyc] openorders error: ${err?.message || err}`);
        const debug = buildErrorDetails({
            request: req,
            status: 0,
            statusText: "NETWORK_ERROR",
            responseHeaders: undefined,
            responseData: { error: err?.message || "Network error" },
            elapsedMs: 0,
        });
        return { ok: false, status: 0, error: err?.message || "Network error", reason: "NETWORK_ERROR", debug };
    }
}

/**
 * Get order by ID on NonKYC exchange
 */
export async function getNonKycOrderById(
    accessKey: string,
    secretKey: string,
    orderId: string
): Promise<NonKycOrderResult> {
    const keyFingerprint = maskSecret(accessKey);
    console.log(`[nonkyc] op=getOrder orderId=${orderId} key_fingerprint=${keyFingerprint}`);

    const req = buildNonkycRequest({
        method: "GET",
        endpoint: `/order?id=${encodeURIComponent(orderId)}`,
        apiKey: accessKey,
        apiSecret: secretKey,
    });

    try {
        const start = Date.now();
        const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
        });

        const status = res.status;
        const rawText = await res.text();
        const data = safeJsonParse(rawText) ?? rawText;
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const elapsedMs = Date.now() - start;

        if (!res.ok) {
            const errMsg = extractErrorMessage(data, res.statusText);
            const reason = detectNonKycReason(status, data);
            const debug = buildErrorDetails({
                request: req,
                status,
                statusText: res.statusText,
                responseHeaders,
                responseData: data,
                elapsedMs,
            });
            return { ok: false, status, error: errMsg, reason, data, debug };
        }

        const foundOrderId = data?.order_id || data?.orderId || data?.id || orderId;
        debugLog("order response", { status, orderId: foundOrderId });
        return { ok: true, status, orderId: foundOrderId, data };

    } catch (err: any) {
        console.error(`[nonkyc] getOrder error: ${err?.message || err}`);
        const debug = buildErrorDetails({
            request: req,
            status: 0,
            statusText: "NETWORK_ERROR",
            responseHeaders: undefined,
            responseData: { error: err?.message || "Network error" },
            elapsedMs: 0,
        });
        return { ok: false, status: 0, error: err?.message || "Network error", reason: "NETWORK_ERROR", debug };
    }
}

