/**
 * Dex-Trade Exchange API Connector
 * 
 * API docs: https://api.dex-trade.com/v1
 * Auth method: SHA256 signature of sorted key values + secret
 * 
 * Signature: Sort body keys alphabetically, concatenate all values + secret, SHA256 hash
 */

import crypto from "crypto";
import fetch from "node-fetch";

const DEXTRADE_API_BASE = process.env.DEXTRADE_API_BASE || "https://api.dex-trade.com/v1";
const DEXTRADE_DEBUG = process.env.DEXTRADE_DEBUG === "1" || process.env.DEXTRADE_DEBUG === "true";

export type DexTradeOrderSide = "BUY" | "SELL";
export type DexTradeTradeType = "MARKET" | "LIMIT";

export interface DexTradeOrderRequest {
    loginToken: string;
    secret: string;
    pair: string;
    side: DexTradeOrderSide;
    tradeType: DexTradeTradeType;
    volume: number;
    rate?: number;
}

export interface DexTradeOrderResult {
    ok: boolean;
    status: number;
    data?: any;
    error?: string;
    code?: string | number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug Helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskSecret(secret: string): string {
    if (!secret || secret.length < 8) return "***";
    return secret.slice(0, 4) + "..." + secret.slice(-4);
}

function debugLog(label: string, data: any): void {
    if (!DEXTRADE_DEBUG) return;
    console.log(`[dextrade:debug] ${label}:`, typeof data === "object" ? JSON.stringify(data, null, 2) : data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build signature per Dex-Trade spec:
 *   1. Sort body keys alphabetically
 *   2. Concatenate all values (handling nested objects)
 *   3. Append secret
 *   4. SHA256 hash
 */
function buildSignature(params: Record<string, any>, secret: string): string {
    const sortedKeys = Object.keys(params).sort();
    const values: string[] = [];

    for (const key of sortedKeys) {
        const value = params[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
            // Handle nested objects: sort their keys and include their values
            const nestedKeys = Object.keys(value).sort();
            for (const nestedKey of nestedKeys) {
                values.push(String(value[nestedKey]));
            }
        } else {
            values.push(String(value));
        }
    }

    const signPayload = values.join("") + secret;

    debugLog("signature values", values);
    debugLog("sign payload (masked)", values.join("") + " + " + maskSecret(secret));

    const signature = crypto.createHash("sha256").update(signPayload).digest("hex");

    debugLog("signature", maskSecret(signature));

    return signature;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function mapTradeType(tradeType: DexTradeTradeType): number {
    return tradeType === "MARKET" ? 1 : 0;
}

function mapSide(side: DexTradeOrderSide): number {
    return side === "BUY" ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function createDexTradeOrder(req: DexTradeOrderRequest): Promise<DexTradeOrderResult> {
    const endpoint = "/private/create-order";
    const url = `${DEXTRADE_API_BASE}${endpoint}`;

    const params: Record<string, any> = {
        pair: req.pair,
        type_trade: mapTradeType(req.tradeType),
        type: mapSide(req.side),
        volume: String(req.volume),
    };

    if (req.tradeType === "LIMIT") {
        if (typeof req.rate !== "number" || !Number.isFinite(req.rate)) {
            return { ok: false, status: 400, error: "Rate is required for LIMIT orders" };
        }
        params.rate = String(req.rate);
    }

    // request_id must be incrementing - use microsecond timestamp
    params.request_id = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));

    const signature = buildSignature(params, req.secret);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "login-token": req.loginToken,
        "x-auth-sign": signature,
    };

    debugLog("request", {
        url,
        headers: {
            ...headers,
            "login-token": maskSecret(headers["login-token"]),
            "x-auth-sign": maskSecret(headers["x-auth-sign"]),
        },
        body: params,
    });

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(params),
        });

        const status = res.status;
        let data: any = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }

        if (!res.ok) {
            const errMsg = data?.error || data?.message || res.statusText || "Request failed";
            console.warn(`[dextrade] order failed: status=${status} error=${errMsg}`);

            if (status === 401 || status === 403) {
                console.warn(`[dextrade] AUTH FAILURE - Check: 1) login-token valid, 2) secret correct, 3) request_id incrementing`);
            }

            return {
                ok: false,
                status,
                error: errMsg,
                code: data?.code,
                data,
            };
        }

        debugLog("response", { status, data });
        console.log(`[dextrade] order success: pair=${req.pair} side=${req.side} volume=${req.volume}`);

        return { ok: true, status, data };

    } catch (err: any) {
        console.error(`[dextrade] order error: ${err?.message || err}`);
        return {
            ok: false,
            status: 0,
            error: err?.message || "Network error",
        };
    }
}

/**
 * Fetch account balances (for selftest verification)
 */
export async function getDexTradeBalances(
    loginToken: string,
    secret: string
): Promise<DexTradeOrderResult> {
    const endpoint = "/private/balance";
    const url = `${DEXTRADE_API_BASE}${endpoint}`;

    const params: Record<string, any> = {
        request_id: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
    };

    const signature = buildSignature(params, secret);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "login-token": loginToken,
        "x-auth-sign": signature,
    };

    debugLog("balance request", {
        url,
        headers: {
            ...headers,
            "login-token": maskSecret(headers["login-token"]),
            "x-auth-sign": maskSecret(headers["x-auth-sign"]),
        },
    });

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(params),
        });

        const status = res.status;
        let data: any = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }

        if (!res.ok) {
            return {
                ok: false,
                status,
                error: data?.error || data?.message || res.statusText || "Request failed",
                code: data?.code,
                data,
            };
        }

        return { ok: true, status, data };

    } catch (err: any) {
        return {
            ok: false,
            status: 0,
            error: err?.message || "Network error",
        };
    }
}

/**
 * Cancel an order
 */
export async function cancelDexTradeOrder(
    loginToken: string,
    secret: string,
    orderId: string | number
): Promise<DexTradeOrderResult> {
    const endpoint = "/private/delete-order";
    const url = `${DEXTRADE_API_BASE}${endpoint}`;

    const params: Record<string, any> = {
        request_id: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
        order_id: Number(orderId),
    };

    const signature = buildSignature(params, secret);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "login-token": loginToken,
        "x-auth-sign": signature,
    };

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(params),
        });

        const status = res.status;
        let data: any = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }

        if (!res.ok) {
            return {
                ok: false,
                status,
                error: data?.error || data?.message || res.statusText || "Request failed",
                code: data?.code,
                data,
            };
        }

        return { ok: true, status, data };

    } catch (err: any) {
        return {
            ok: false,
            status: 0,
            error: err?.message || "Network error",
        };
    }
}

/**
 * List open orders
 */
export async function listDexTradeOpenOrders(
    loginToken: string,
    secret: string,
    pair?: string
): Promise<DexTradeOrderResult> {
    const endpoint = "/private/orders";
    const url = `${DEXTRADE_API_BASE}${endpoint}`;

    const params: Record<string, any> = {
        request_id: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
    };
    if (pair) params.pair = pair;

    const signature = buildSignature(params, secret);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "login-token": loginToken,
        "x-auth-sign": signature,
    };

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(params),
        });

        const status = res.status;
        let data: any = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }

        if (!res.ok) {
            return {
                ok: false,
                status,
                error: data?.error || data?.message || res.statusText || "Request failed",
                code: data?.code,
                data,
            };
        }

        return { ok: true, status, data };

    } catch (err: any) {
        return {
            ok: false,
            status: 0,
            error: err?.message || "Network error",
        };
    }
}
