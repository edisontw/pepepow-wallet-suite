/**
 * NestEx Exchange API Connector
 * 
 * API docs: https://trade.nestex.one/api/v2
 * Auth method: API key and secret in POST body (NOT headers)
 * Rate limit: Minimum 5 seconds between requests per user
 */

import fetch from "node-fetch";

const NESTEX_API_BASE = process.env.NESTEX_API_BASE || "https://trade.nestex.one/api/v2";
const NESTEX_MIN_INTERVAL_MS = 5100; // 5.1 seconds to be safe
const NESTEX_DEBUG = process.env.NESTEX_DEBUG === "1" || process.env.NESTEX_DEBUG === "true";

export type NestExOrderSide = "BUY" | "SELL";

export interface NestExOrderRequest {
    apiKey: string;
    apiSecret: string;
    cur: string;
    side: NestExOrderSide;
    qty: number;
    price: number;
    rateLimitKey: string;
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
    if (!secret || secret.length < 8) return "***";
    return secret.slice(0, 4) + "..." + secret.slice(-4);
}

function maskBody(body: Record<string, any>): Record<string, any> {
    const masked: Record<string, any> = { ...body };
    if (masked.apikey) masked.apikey = maskSecret(masked.apikey);
    if (masked.apisecret) masked.apisecret = maskSecret(masked.apisecret);
    return masked;
}

function debugLog(label: string, data: any): void {
    if (!NESTEX_DEBUG) return;
    console.log(`[nestex:debug] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

const lastCallAt = new Map<string, number>();
const rateLimitChains = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    rateLimitKey: string
): Promise<NestExResult> {
    await enforceRateLimit(rateLimitKey);
    const url = `${NESTEX_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

    debugLog("request", {
        url,
        method: "POST",
        body: maskBody(payload),
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

    const orderId = data?.order_id || data?.data?.order_id || data?.result?.order_id || null;
    return { ok: true, status, data, orderId };
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
        rateLimitKey
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
        rateLimitKey
    );
}

/**
 * Place a limit order
 * 
 * IMPORTANT: apikey and apisecret MUST be in the POST body, NOT headers
 */
export async function placeNestExLimitOrder(req: NestExOrderRequest): Promise<NestExResult> {
    const payload = {
        apikey: req.apiKey,
        apisecret: req.apiSecret,
        cur: req.cur,
        side: req.side,
        qty: String(req.qty),
        price: String(req.price),
    };

    debugLog("placing order", {
        cur: req.cur,
        side: req.side,
        qty: req.qty,
        price: req.price,
    });

    const result = await postNestEx("/placelimitorder", payload, req.rateLimitKey);

    if (result.ok) {
        console.log(`[nestex] order success: cur=${req.cur} side=${req.side} qty=${req.qty} orderId=${result.orderId ?? "n/a"}`);
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
    return postNestEx(
        "/cancelorder",
        {
            apikey: apiKey,
            apisecret: apiSecret,
            order_id: String(orderId),
        },
        rateLimitKey
    );
}
