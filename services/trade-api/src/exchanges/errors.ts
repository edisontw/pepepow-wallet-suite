export type ExchangeErrorCategory =
    | "AUTH_FAILED"
    | "MIN_NOTIONAL"
    | "MIN_QTY"
    | "PRECISION"
    | "RATE_LIMITED"
    | "TEMPORARY"
    | "INSUFFICIENT_BALANCE"
    | "INVALID_MARKET"
    | "OPEN_ORDERS"
    | "UNKNOWN";

export interface ExchangeErrorClassification {
    code: ExchangeErrorCategory;
    category: ExchangeErrorCategory;
    retryable: boolean;
    shouldAutoDisable: boolean;
    message: string;
}

type AnyError = {
    message?: string;
    httpStatus?: number;
    code?: string | number;
    exchangeCode?: string | number;
    details?: any;
};

const MIN_NOTIONAL_PATTERNS = ["minimum order value", "min notional", "minimum order"];
const MIN_QTY_PATTERNS = ["minimum quantity", "min quantity", "lot", "step"];
const PRECISION_PATTERNS = ["precision", "tick"];
const NETWORK_PATTERNS = ["timeout", "timed out", "econnreset", "econnrefused", "etimedout", "network error", "socket hang up"];

function normalizeText(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return "";
    return String(value).toLowerCase();
}

function extractErrorText(err: AnyError): string {
    const msg = normalizeText(err.message);
    const details = err.details;
    if (details?.responseData) {
        const response = details.responseData;
        if (typeof response === "string") return `${msg} ${normalizeText(response)}`.trim();
        if (typeof response === "object") {
            const description = normalizeText(response.description || response.message || response.msg || response.error);
            return `${msg} ${description}`.trim();
        }
    }
    return msg;
}

function includesAny(text: string, patterns: string[]): boolean {
    if (!text) return false;
    return patterns.some((pattern) => text.includes(pattern));
}

export function classifyExchangeError(exchange: string, err: AnyError): ExchangeErrorClassification {
    const httpStatus = err.httpStatus;
    const codeRaw = err.code ?? err.exchangeCode;
    const code = normalizeText(codeRaw);
    const text = extractErrorText(err);

    // Explicit code mapping (do this first for deterministic behavior)
    if (code === "auth_failed") {
        return { code: "AUTH_FAILED", category: "AUTH_FAILED", retryable: false, shouldAutoDisable: true, message: err.message || "Authentication failed" };
    }
    if (code === "min_notional") {
        return { code: "MIN_NOTIONAL", category: "MIN_NOTIONAL", retryable: false, shouldAutoDisable: false, message: err.message || "Order below minimum notional" };
    }
    if (code === "min_qty") {
        return { code: "MIN_QTY", category: "MIN_QTY", retryable: false, shouldAutoDisable: false, message: err.message || "Order below minimum quantity" };
    }
    if (code === "precision") {
        return { code: "PRECISION", category: "PRECISION", retryable: false, shouldAutoDisable: false, message: err.message || "Order precision invalid" };
    }
    if (code === "insufficient_balance") {
        return { code: "INSUFFICIENT_BALANCE", category: "INSUFFICIENT_BALANCE", retryable: false, shouldAutoDisable: false, message: err.message || "Insufficient balance" };
    }
    if (code === "invalid_market") {
        return { code: "INVALID_MARKET", category: "INVALID_MARKET", retryable: false, shouldAutoDisable: false, message: err.message || "Invalid market" };
    }
    if (code === "open_orders") {
        return { code: "OPEN_ORDERS", category: "OPEN_ORDERS", retryable: false, shouldAutoDisable: false, message: err.message || "Open orders exist" };
    }

    // HTTP status based mapping (NonKYC-first rules)
    if (httpStatus === 401 || httpStatus === 403) {
        return { code: "AUTH_FAILED", category: "AUTH_FAILED", retryable: false, shouldAutoDisable: true, message: err.message || "Authentication failed" };
    }

    if (httpStatus === 400) {
        if (includesAny(text, MIN_NOTIONAL_PATTERNS)) {
            return { code: "MIN_NOTIONAL", category: "MIN_NOTIONAL", retryable: false, shouldAutoDisable: false, message: err.message || "Order below minimum notional" };
        }
        if (includesAny(text, MIN_QTY_PATTERNS)) {
            return { code: "MIN_QTY", category: "MIN_QTY", retryable: false, shouldAutoDisable: false, message: err.message || "Order below minimum quantity" };
        }
        if (includesAny(text, PRECISION_PATTERNS)) {
            return { code: "PRECISION", category: "PRECISION", retryable: false, shouldAutoDisable: false, message: err.message || "Order precision invalid" };
        }
    }

    if (httpStatus === 429) {
        return { code: "RATE_LIMITED", category: "RATE_LIMITED", retryable: true, shouldAutoDisable: false, message: err.message || "Rate limited" };
    }

    if (httpStatus && httpStatus >= 500 && httpStatus < 600) {
        return { code: "TEMPORARY", category: "TEMPORARY", retryable: true, shouldAutoDisable: false, message: err.message || "Exchange temporary error" };
    }

    if (includesAny(text, NETWORK_PATTERNS) || httpStatus === 0) {
        return { code: "TEMPORARY", category: "TEMPORARY", retryable: true, shouldAutoDisable: false, message: err.message || "Network error" };
    }

    return { code: "UNKNOWN", category: "UNKNOWN", retryable: false, shouldAutoDisable: false, message: err.message || "Unknown error" };
}
