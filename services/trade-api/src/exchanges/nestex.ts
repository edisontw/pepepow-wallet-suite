/**
 * NestEx Exchange API Connector
 * 
 * API docs: https://trade.nestex.one/api/v2
 * Auth method: API key and secret in POST body (NOT headers)
 * Rate limit: Minimum 5 seconds between requests per user
 */

import fetch from "node-fetch";

const NESTEX_API_BASE = process.env.NESTEX_API_BASE || "https://trade.nestex.one/api/v2";
const NESTEX_MIN_INTERVAL_MS = Number(process.env.NESTEX_MIN_INTERVAL_MS || 250);
const NESTEX_RATE_LIMIT_BACKOFF_MS = Number(process.env.NESTEX_RATE_LIMIT_BACKOFF_MS || 5000);
const NESTEX_DEBUG =
    process.env.DEBUG_NESTEX === "1" ||
    process.env.DEBUG_NESTEX === "true" ||
    process.env.NESTEX_DEBUG === "1" ||
    process.env.NESTEX_DEBUG === "true";
const NESTEX_ORDER_DEBUG =
    process.env.DEBUG_NESTEX_ORDER === "1" ||
    process.env.DEBUG_NESTEX_ORDER === "true";
const NESTEX_OPEN_ORDERS_DEFAULT_ENDPOINTS = ["/orders", "/openorders"];
const nestExDisabledOpenOrdersEndpoints = new Set<string>();
let nestExPreferredOpenOrdersEndpoint: string | null = null;

export type NestExOrderSide = "BUY" | "SELL";

export interface NestExOrderRequest {
    apiKey: string;
    apiSecret: string;
    cur: string;
    side: NestExOrderSide;
    qty: number;
    price: number;
    rateLimitKey: string;
    pair?: string;
    baseQty?: number;
    quoteQty?: number;
}

export interface NestExResult {
    ok: boolean;
    status: number;
    data?: any;
    error?: string;
    orderId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug Helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskSecret(secret: string): string {
    if (!secret) return "***";
    return "***";
}

function maskApiKey(apiKey: string): string {
    if (!apiKey) return "***";
    const tail = apiKey.length >= 4 ? apiKey.slice(-4) : apiKey;
    return `***${tail}`;
}

function sanitizeForLog(input: any): any {
    if (input === null || input === undefined) return input;
    if (Array.isArray(input)) return input.map((item) => sanitizeForLog(item));
    if (typeof input === "object") {
        const masked: Record<string, any> = {};
        for (const [key, value] of Object.entries(input)) {
            const lower = key.toLowerCase();
            if (lower === "apikey" || lower === "api_key") {
                masked[key] = maskApiKey(String(value));
            } else if (lower === "apisecret" || lower === "api_secret" || lower === "secret") {
                masked[key] = maskSecret(String(value));
            } else {
                masked[key] = sanitizeForLog(value);
            }
        }
        return masked;
    }
    return input;
}

function debugLog(label: string, data: any): void {
    if (!NESTEX_DEBUG) return;
    const sanitized = typeof data === "object" ? sanitizeForLog(data) : data;
    console.log(`[nestex:debug] ${label}:`, typeof sanitized === "object" ? JSON.stringify(sanitized, null, 2) : sanitized);
}

function formatDecimal(value: number, precision: number): string {
    if (!Number.isFinite(value)) return "0";
    const fixed = value.toFixed(precision);
    return fixed;
}

function encodeNestExPrice(price: number, precision = 8): string {
    return formatDecimal(price, precision);
}

function encodeNestExQty(qty: number, precision = 0): string {
    return formatDecimal(qty, precision);
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve external pair (e.g. PEPEW/USDT) to NestEx symbol (e.g. PEPEW_USDT)
 */
export function resolveNestExSymbol(pair: string): string {
    const p = pair.toUpperCase().replace(/\//g, "_");
    if (p === "PEPEW_USDT" || p === "PEPEWUSDT") return "PEPEW_USDT";
    return p;
}

/**
 * Resolve external pair to base currency (e.g. PEPEW) if needed by some endpoints
 */
export function resolveNestExBaseCur(pair: string): string {
    if (pair.includes("/")) return pair.split("/")[0].toUpperCase();
    if (pair.startsWith("PEPEW")) return "PEPEW";
    return pair.toUpperCase();
}

function decodeNestExPrice(raw: string): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

const lastCallAt = new Map<string, number>();
const rateLimitChains = new Map<string, Promise<void>>();
const rateLimitUntil = new Map<string, number>();

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(message: string | null | undefined): boolean {
    if (!message) return false;
    return /rate\s*limit|too\s*many\s*requests|429/i.test(message);
}

function noteRateLimit(rateLimitKey: string, retryAfterMs?: number): void {
    const now = Date.now();
    const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? retryAfterMs! : NESTEX_RATE_LIMIT_BACKOFF_MS;
    const until = now + backoffMs;
    const current = rateLimitUntil.get(rateLimitKey) || 0;
    if (until > current) {
        rateLimitUntil.set(rateLimitKey, until);
    }
    debugLog("rate limit", `Backoff ${backoffMs}ms (until ${new Date(until).toISOString()})`);
}

async function enforceRateLimit(rateLimitKey: string): Promise<void> {
    const previous = rateLimitChains.get(rateLimitKey) || Promise.resolve();
    let release: (() => void) | null = null;
    const next = new Promise<void>((resolve) => {
        release = resolve;
    });
    rateLimitChains.set(rateLimitKey, previous.then(() => next));

    await previous;
    try {
        const now = Date.now();
        const backoffUntil = rateLimitUntil.get(rateLimitKey) || 0;
        if (backoffUntil > now) {
            const waitMs = backoffUntil - now;
            debugLog("rate limit", `Waiting ${waitMs}ms (rate limit backoff)`);
            await sleep(waitMs);
        }
        const last = lastCallAt.get(rateLimitKey) || 0;
        const elapsed = now - last;
        if (elapsed < NESTEX_MIN_INTERVAL_MS) {
            const waitMs = NESTEX_MIN_INTERVAL_MS - elapsed;
            debugLog("rate limit", `Waiting ${waitMs}ms before next request`);
            await sleep(waitMs);
        }
        lastCallAt.set(rateLimitKey, Date.now());
    } finally {
        if (release) {
            release();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Request Function
// ─────────────────────────────────────────────────────────────────────────────

async function postNestEx(
    endpoint: string,
    payload: Record<string, any>,
    rateLimitKey: string,
    opts?: {
        validator?: (data: any) => { ok: boolean; error?: string; orderId?: string | null };
    }
): Promise<NestExResult> {
    await enforceRateLimit(rateLimitKey);
    const url = `${NESTEX_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    if (NESTEX_DEBUG) {
        console.log(`[nestex:debug] request: { "url": "${url}", "endpoint": "${endpoint}" }`);
    }

    debugLog("request", {
        url,
        method: "POST",
        body: sanitizeForLog(payload),
    });

    let res: any;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (err: any) {
        console.error(`[nestex] request error: ${err?.message || err}`);
        return { ok: false, status: 0, error: err?.message || "Network error" };
    }

    const status = res.status;
    let data: any = null;
    try {
        data = await res.json();
    } catch (_) {
        data = null;
    }

    debugLog("response", { status, data });

    if (!res.ok) {
        const errMsg = data?.error || data?.message || res.statusText || "Request failed";
        console.warn(`[nestex] request failed: status=${status} error=${errMsg}`);
        if (status === 429 || isRateLimitError(errMsg)) {
            const retryAfterHeader = res.headers?.get ? res.headers.get("retry-after") : null;
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
            noteRateLimit(rateLimitKey, retryAfterMs);
        }

        if (status === 401 || status === 403) {
            console.warn(`[nestex] AUTH FAILURE - Check: 1) apikey/apisecret in body, 2) key permissions, 3) key not expired`);
        }

        return {
            ok: false,
            status,
            error: errMsg,
            data,
        };
    }

    if (opts?.validator) {
        const verdict = opts.validator(data);
        if (!verdict.ok) {
            const errMsg = verdict.error || "Request failed";
            console.warn(`[nestex] request failed: status=${status} error=${errMsg}`);
            if (isRateLimitError(errMsg)) {
                noteRateLimit(rateLimitKey);
            }
            return { ok: false, status, error: errMsg, data };
        }
        return { ok: true, status, data, orderId: verdict.orderId ?? null };
    }

    const orderId =
        data?.order_id ||
        data?.id ||
        data?.orderId ||
        data?.data?.order_id ||
        data?.data?.id ||
        data?.data?.orderId ||
        data?.result?.order_id ||
        data?.result?.id ||
        data?.result?.orderId ||
        null;
    return { ok: true, status, data, orderId };
}

function extractNestExError(data: any): string | null {
    const err = data?.error || data?.message || data?.result?.error || data?.data?.error;
    if (!err) return null;
    const msg = String(err);
    return msg.trim() ? msg : null;
}

function extractNestExOrders(data: any): any[] {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.orders)) return data.orders;
    if (data?.orders && typeof data.orders === "object") return Object.values(data.orders);
    if (Array.isArray(data?.data?.orders)) return data.data.orders;
    if (data?.data?.orders && typeof data.data.orders === "object") return Object.values(data.data.orders);
    if (Array.isArray(data?.result?.orders)) return data.result.orders;
    if (data?.result?.orders && typeof data.result.orders === "object") return Object.values(data.result.orders);
    if (Array.isArray(data?.data?.list)) return data.data.list;
    if (data?.data?.list && typeof data.data.list === "object") return Object.values(data.data.list);
    if (Array.isArray(data?.result?.list)) return data.result.list;
    if (data?.result?.list && typeof data.result.list === "object") return Object.values(data.result.list);
    return [];
}

function hasNestExBalances(data: any): boolean {
    if (!data) return false;
    if (Array.isArray(data?.data)) return true;
    if (Array.isArray(data?.balances)) return true;
    if (Array.isArray(data?.data?.balances)) return true;
    if (data?.balances && typeof data.balances === "object") return true;
    if (data?.data?.balances && typeof data.data.balances === "object") return true;
    return false;
}

function hasNestExTokenSuccess(data: any): boolean {
    return (
        data?.success === true ||
        data?.status === true ||
        data?.valid === true ||
        data?.data?.valid === true ||
        data?.data?.success === true ||
        data?.result?.success === true
    );
}

function truncateForLog(input: any, maxLen = 800): string {
    const safe = sanitizeForLog(input);
    const raw = typeof safe === "string" ? safe : JSON.stringify(safe);
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen) + "...[truncated]";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if API token is valid
 * This is useful for verifying credentials before placing orders
 */
export async function checkNestExToken(
    apiKey: string,
    apiSecret: string,
    rateLimitKey: string
): Promise<NestExResult> {
    debugLog("checktoken", "Verifying API credentials");
    return postNestEx(
        "/checktoken",
        { apikey: apiKey, apisecret: apiSecret },
        rateLimitKey,
        {
            validator: (data) => {
                const error = extractNestExError(data);
                if (error && !hasNestExTokenSuccess(data)) {
                    return { ok: false, error };
                }
                return { ok: true };
            },
        }
    );
}

/**
 * Get account balances
 */
export async function getNestExBalances(
    apiKey: string,
    apiSecret: string,
    rateLimitKey: string
): Promise<NestExResult> {
    return postNestEx(
        "/balances",
        { apikey: apiKey, apisecret: apiSecret },
        rateLimitKey,
        {
            validator: (data) => {
                const error = extractNestExError(data);
                if (error && !hasNestExBalances(data)) {
                    return { ok: false, error };
                }
                return { ok: true };
            },
        }
    );
}

/**
 * Place a limit order
 * 
 * IMPORTANT: apikey and apisecret MUST be in the POST body, NOT headers
 */
export async function placeNestExLimitOrder(req: NestExOrderRequest): Promise<NestExResult> {
    const priceStr = encodeNestExPrice(req.price, 8);
    const qtyStr = encodeNestExQty(req.qty, 0);
    const curCandidates: string[] = [];
    const seenCur = new Set<string>();
    const pushCur = (value?: string) => {
        const normalized = String(value || "").trim().toUpperCase();
        if (!normalized || seenCur.has(normalized)) return;
        seenCur.add(normalized);
        curCandidates.push(normalized);
    };
    pushCur(req.cur);
    if (req.pair) {
        pushCur(resolveNestExBaseCur(req.pair));
        pushCur(resolveNestExSymbol(req.pair));
        pushCur(req.pair.replace(/\//g, "_"));
    }
    if (req.cur.includes("_")) {
        pushCur(req.cur.split("_")[0]);
    }
    if (req.cur.includes("/")) {
        pushCur(req.cur.split("/")[0]);
    }
    if (curCandidates.length === 0) {
        pushCur("PEPEW");
    }

    const shouldRetryWithNextCur = (error?: string): boolean => {
        const e = String(error || "").toLowerCase();
        if (!e) return false;
        return (
            e.includes("invalid coin") ||
            e.includes("invalid parameters") ||
            e.includes("invalid symbol") ||
            e.includes("unknown coin")
        );
    };

    if (NESTEX_ORDER_DEBUG) {
        const decoded = decodeNestExPrice(priceStr);
        const roundTripDiff = Number.isFinite(decoded) ? Math.abs(decoded - req.price) : NaN;
        console.log(`[nestex:order] input: ${JSON.stringify({
            side: req.side,
            pair: req.pair,
            cur: req.cur,
            curCandidates,
            price: req.price,
            baseQty: req.baseQty ?? req.qty,
            quoteQty: req.quoteQty,
        })}`);
        if (Number.isFinite(roundTripDiff) && roundTripDiff > 1e-12) {
            console.warn(`[nestex:order] price round-trip diff=${roundTripDiff}`);
        }
    }

    let result: NestExResult = { ok: false, status: 0, error: "ORDER_FAILED" };
    let usedCur = req.cur;
    for (const cur of curCandidates) {
        usedCur = cur;
        const payload = {
            apikey: req.apiKey,
            apisecret: req.apiSecret,
            cur,
            side: req.side,
            qty: qtyStr,
            price: priceStr,
        };
        debugLog("placing order", {
            cur,
            side: req.side,
            qty: qtyStr,
            price: priceStr,
            pair: req.pair || null,
        });
        if (NESTEX_ORDER_DEBUG) {
            console.log(`[nestex:order] payload: ${JSON.stringify({
                cur,
                side: req.side,
                price: priceStr,
                qty: qtyStr,
            })}`);
        }
        result = await postNestEx("/placelimitorder", payload, req.rateLimitKey, {
            validator: (data) => {
                const error = extractNestExError(data);
                const orderId =
                    data?.order_id ||
                    data?.id ||
                    data?.orderId ||
                    data?.data?.order_id ||
                    data?.data?.id ||
                    data?.data?.orderId ||
                    data?.result?.order_id ||
                    data?.result?.id ||
                    data?.result?.orderId ||
                    null;
                if (error && !orderId) {
                    return { ok: false, error };
                }
                return { ok: true, orderId };
            },
        });
        if (result.ok) {
            if (NESTEX_ORDER_DEBUG && cur !== req.cur) {
                console.log(`[nestex:order] cur fallback success using cur=${cur} originalCur=${req.cur}`);
            }
            break;
        }
        if (!shouldRetryWithNextCur(result.error)) {
            break;
        }
    }

    if (NESTEX_ORDER_DEBUG) {
        console.log(`[nestex:order] response: ${JSON.stringify({
            ok: result.ok,
            status: result.status,
            orderId: result.orderId ?? null,
            error: result.error ?? null,
            data: result.data,
        })}`);
    }

    if (result.ok) {
        console.log(`[nestex] order success: cur=${usedCur} side=${req.side} qty=${req.qty} orderId=${result.orderId ?? "n/a"}`);
    }

    return result;
}

/**
 * Cancel an order
 */
export async function cancelNestExOrder(
    apiKey: string,
    apiSecret: string,
    orderId: string | number,
    rateLimitKey: string
): Promise<NestExResult> {
    const normalizedOrderId = String(orderId).trim().replace(/\.0+$/, "");
    if (!/^\d+$/.test(normalizedOrderId)) {
        return { ok: false, status: 0, error: "INVALID_ORDER_ID" };
    }
    const response = await postNestEx(
        "/cancelorder",
        {
            apikey: apiKey,
            apisecret: apiSecret,
            order_id: normalizedOrderId,
        },
        rateLimitKey,
        {
            validator: (data) => {
                const error = extractNestExError(data);
                const returnedOrderId =
                    data?.order_id ||
                    data?.id ||
                    data?.orderId ||
                    data?.data?.order_id ||
                    data?.data?.id ||
                    data?.data?.orderId ||
                    data?.result?.order_id ||
                    data?.result?.id ||
                    data?.result?.orderId ||
                    null;

                // If we have an error but no orderId, it's a real failure
                // UNLESS the error is "order not found" or similar which means it's already gone
                if (error) {
                    const errStr = String(error).toLowerCase();
                    if (errStr.includes("not found") || errStr.includes("not exist") || errStr.includes("check the order_id")) {
                        // This is "success" in the sense that the order is no longer open
                        return { ok: true, orderId: normalizedOrderId };
                    }
                    return { ok: false, error };
                }
                return { ok: true, orderId: returnedOrderId || normalizedOrderId };
            },
        }
    );

    const parsedSuccess = response.ok;
    console.log(
        `[nestex:cancel] order_id=${normalizedOrderId} status=${response.status} parsedSuccess=${parsedSuccess} body=${truncateForLog(response.data)}`
    );
    if (!parsedSuccess && response.error) {
        console.warn(`[nestex:cancel] failed order_id=${normalizedOrderId} error=${response.error}`);
    }

    return response;
}

/**
 * List open orders
 */
export async function listNestExOpenOrders(
    apiKey: string,
    apiSecret: string,
    pair: string | undefined,
    rateLimitKey: string,
    options?: { exhaustive?: boolean; includeNoCur?: boolean }
): Promise<{ ok: boolean; status: number; orders?: any[]; error?: string; data?: any }> {
    const exhaustive = options?.exhaustive === true;
    const includeNoCur = options?.includeNoCur === true;
    const buildPayload = (cur?: string): Record<string, any> => {
        const payload: Record<string, any> = {
            apikey: apiKey,
            apisecret: apiSecret,
        };
        if (cur) payload.cur = cur;
        return payload;
    };

    const pairCurCandidates: string[] = [];
    const seenPairCur = new Set<string>();
    const pushPairCur = (cur?: string) => {
        const normalized = (cur || "").trim().toUpperCase();
        if (!normalized || seenPairCur.has(normalized)) return;
        seenPairCur.add(normalized);
        pairCurCandidates.push(normalized);
    };

    if (pair) {
        pushPairCur(resolveNestExBaseCur(pair));
        if (exhaustive) {
            pushPairCur(resolveNestExSymbol(pair));
        }
    }
    if (pairCurCandidates.length === 0) {
        pushPairCur(resolveNestExBaseCur(pair || "PEPEW/USDT"));
    }

    const configuredEndpointRaw = String(process.env.NESTEX_OPEN_ORDERS_ENDPOINT || "").trim();
    const configuredEndpoint = configuredEndpointRaw
        ? (configuredEndpointRaw.startsWith("/") ? configuredEndpointRaw : `/${configuredEndpointRaw}`)
        : null;

    const endpointCandidates = [
        nestExPreferredOpenOrdersEndpoint,
        ...NESTEX_OPEN_ORDERS_DEFAULT_ENDPOINTS,
        configuredEndpoint,
    ].filter((endpoint): endpoint is string => !!endpoint);

    const seen = new Set<string>();
    let lastFailure: { status: number; error?: string; data?: any } | null = null;

    for (const endpoint of endpointCandidates) {
        if (seen.has(endpoint)) continue;
        seen.add(endpoint);
        if (nestExDisabledOpenOrdersEndpoints.has(endpoint)) continue;

        const mergedOrders = new Map<string, any>();
        let endpointHadSuccess = false;
        const endpointPrefersNoCur = endpoint === "/orders";
        const endpointCurCandidates: Array<string | undefined> = [];
        const seenEndpointCur = new Set<string>();
        const pushEndpointCur = (cur?: string) => {
            const normalized = (cur || "").trim().toUpperCase();
            const key = normalized || "__NO_CUR__";
            if (seenEndpointCur.has(key)) return;
            seenEndpointCur.add(key);
            endpointCurCandidates.push(normalized || undefined);
        };
        if (endpointPrefersNoCur || includeNoCur || exhaustive) {
            pushEndpointCur(undefined);
        }
        for (const cur of pairCurCandidates) {
            pushEndpointCur(cur);
        }
        if (endpointCurCandidates.length === 0) {
            pushEndpointCur(undefined);
        }

        for (const cur of endpointCurCandidates) {
            const result = await postNestEx(endpoint, buildPayload(cur), rateLimitKey, {
                validator: (data) => {
                    const orders = extractNestExOrders(data);
                    const error = extractNestExError(data);
                    if (orders.length === 0 && error) {
                        return { ok: false, error };
                    }
                    return { ok: true };
                },
            });

            if (!result.ok && result.status === 404) {
                nestExDisabledOpenOrdersEndpoints.add(endpoint);
                if (nestExPreferredOpenOrdersEndpoint === endpoint) {
                    nestExPreferredOpenOrdersEndpoint = null;
                }
                endpointHadSuccess = false;
                break;
            }

            if (!result.ok) {
                lastFailure = { status: result.status, error: result.error, data: result.data };
                continue;
            }

            endpointHadSuccess = true;
            const rawOrders = extractNestExOrders(result.data);
            for (const o of rawOrders) {
                const orderId = String(o?.order_id ?? o?.id ?? o?.orderId ?? "").trim().replace(/\.0+$/, "");
                if (!orderId) continue;
                mergedOrders.set(orderId, {
                    order_id: orderId,
                    client_order_id: String(o?.client_order_id ?? o?.clientOrderId ?? o?.userProvidedId ?? ""),
                    side: String(o?.side ?? o?.type ?? o?.order_side ?? o?.order_type ?? "").toUpperCase(),
                    price: toNumber(o?.price ?? o?.rate ?? o?.order_price),
                    quantity: toNumber(o?.qty ?? o?.quantity ?? o?.amount),
                    raw: o,
                });
            }

            if (endpointPrefersNoCur && !cur) {
                // `/orders` often rejects `cur`; a successful no-cur call is enough.
                break;
            }
            if (!exhaustive && mergedOrders.size > 0) {
                break;
            }
        }

        if (!endpointHadSuccess) {
            continue;
        }

        nestExPreferredOpenOrdersEndpoint = endpoint;
        const orders = Array.from(mergedOrders.values());
        if (NESTEX_DEBUG && orders.length > 0) {
            console.log(`[nestex:debug] listOpenOrders success: count=${orders.length} pair=${pair} sample_id=${orders[0].order_id}`);
        }

        return { ok: true, status: 200, orders, data: { endpoint, exhaustive, curCandidates: endpointCurCandidates } };
    }

    if (lastFailure) {
        return { ok: false, status: lastFailure.status, error: lastFailure.error, data: lastFailure.data };
    }
    return { ok: true, status: 200, orders: [], data: { warning: "OPEN_ORDERS_ENDPOINT_UNAVAILABLE" } };
}

function toNumber(val: any): number | null {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}
