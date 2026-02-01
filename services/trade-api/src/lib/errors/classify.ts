/**
 * Error Classification System for Strategy Execution
 * 
 * Classifies exchange/network errors into categories with appropriate actions:
 * - FATAL: Immediately disable the strategy
 * - RETRIABLE: Apply exponential backoff
 * - SOFT: Ignore (no real error)
 */

export type ErrorCategory =
    | "AUTH_FAILED"
    | "SIGNATURE_MISMATCH"
    | "IP_BLOCKED"
    | "KEY_EXPIRED"
    | "PERMISSION_DENIED"
    | "MIN_NOTIONAL"
    | "INVALID_MARKET"
    | "ACCOUNT_RESTRICTED"
    | "INSUFFICIENT_BALANCE"
    | "RATE_LIMIT"
    | "EXCHANGE_5XX"
    | "NETWORK_ERROR"
    | "TEMP_UNAVAILABLE"
    | "ENDPOINT_INVALID"
    | "NO_ACTION"
    | "UNKNOWN";

export type ErrorSeverity = "FATAL" | "RETRIABLE" | "SOFT";
export type ErrorAction = "DISABLE" | "BACKOFF" | "IGNORE";

export interface ClassifiedError {
    category: ErrorCategory;
    severity: ErrorSeverity;
    action: ErrorAction;
    /** Number of consecutive failures before action is taken. 1 = immediate. */
    consecutiveThreshold: number;
    /** User-facing hint on how to fix this error */
    userHint?: string;
}

export interface ClassifyErrorParams {
    exchange: string;
    strategy: string;
    tradeMode: string;
    httpStatus?: number;
    errorMessage?: string;
    errorCode?: string | number;
}

// Patterns for error message matching (case-insensitive)
const AUTH_PATTERNS = [
    "invalid api key",
    "authentication failed",
    "unauthorized",
    "api key",
    "secret key",
];

const SIGNATURE_PATTERNS = [
    "invalid signature",
    "signature error",
    "signature mismatch",
    "bad signature",
    "hmac",
];

const IP_PATTERNS = [
    "ip not allowed",
    "ip whitelist",
    "ip blocked",
    "ip restriction",
];

const KEY_EXPIRED_PATTERNS = [
    "key expired",
    "api key expired",
    "token expired",
    "key revoked",
];

const PERMISSION_PATTERNS = [
    "no trade permission",
    "permission denied",
    "not allowed",
    "no permission",
];

const MARKET_PATTERNS = [
    "symbol not found",
    "pair not exist",
    "invalid symbol",
    "market not found",
    "unknown symbol",
    "not tradeable",
];

const ACCOUNT_PATTERNS = [
    "account restricted",
    "account suspended",
    "account disabled",
    "account locked",
];

const BALANCE_PATTERNS = [
    "insufficient",
    "not enough balance",
    "balance too low",
    "insufficient funds",
    "minimum order value",
    "minimum order",
    "min order",
    "min notional",
];

const RATE_LIMIT_PATTERNS = [
    "rate limit",
    "too many requests",
    "throttled",
    "request limit",
];

const NETWORK_PATTERNS = [
    "timeout",
    "econnreset",
    "econnrefused",
    "etimedout",
    "dns",
    "network error",
    "socket hang up",
    "fetch failed",
];

const TEMP_UNAVAILABLE_PATTERNS = [
    "maintenance",
    "temporarily unavailable",
    "service unavailable",
    "try again later",
];

function matchesAny(text: string, patterns: string[]): boolean {
    const lower = text.toLowerCase();
    return patterns.some((p) => lower.includes(p));
}

/**
 * Classify an error based on HTTP status, error message, and error code.
 */
export function classifyError(params: ClassifyErrorParams): ClassifiedError {
    const { httpStatus, errorMessage, errorCode } = params;
    const msg = errorMessage || "";
    const codeRaw = String(errorCode || "");
    const code = codeRaw.toLowerCase();

    // Check for NO_ACTION (no error)
    if (!httpStatus && !errorMessage && !errorCode) {
        return {
            category: "NO_ACTION",
            severity: "SOFT",
            action: "IGNORE",
            consecutiveThreshold: 1,
        };
    }

    // HTTP status based classification
    // Note: For 401/403 we check message patterns first for more specific categorization
    // Explicit category codes from upstream
    const upperCode = codeRaw.toUpperCase();
    if (upperCode === "SIGNATURE_MISMATCH") {
        return {
            category: "SIGNATURE_MISMATCH",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Signature calculation error. Try regenerating your API keys on the exchange.",
        };
    }
    if (upperCode === "AUTH_FAILED") {
        return {
            category: "AUTH_FAILED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Authentication failed. Verify your API key and secret are correct, and that the key has trade permissions.",
        };
    }
    if (upperCode === "MIN_NOTIONAL") {
        return {
            category: "MIN_NOTIONAL",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Order size below the exchange minimum. Increase budget to meet the minimum notional.",
        };
    }
    if (upperCode === "IP_BLOCKED") {
        return {
            category: "IP_BLOCKED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Your IP is not in the API key whitelist. Add your server IP in the exchange settings.",
        };
    }
    if (upperCode === "PERMISSION_DENIED") {
        return {
            category: "PERMISSION_DENIED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Your API key doesn't have trade permissions. Enable trading in your exchange API settings.",
        };
    }
    if (upperCode === "ENDPOINT_INVALID") {
        return {
            category: "ENDPOINT_INVALID",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "API endpoint not found. The exchange may have updated their API. Please report this issue.",
        };
    }

    if (httpStatus === 404) {
        return {
            category: "ENDPOINT_INVALID",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "API endpoint not found. The exchange may have updated their API. Please report this issue.",
        };
    }

    if (httpStatus === 429) {
        return {
            category: "RATE_LIMIT",
            severity: "RETRIABLE",
            action: "BACKOFF",
            consecutiveThreshold: 1,
            userHint: "Too many requests. The strategy will automatically retry with backoff.",
        };
    }

    if (httpStatus && httpStatus >= 500 && httpStatus < 600) {
        return {
            category: "EXCHANGE_5XX",
            severity: "RETRIABLE",
            action: "BACKOFF",
            consecutiveThreshold: 1,
            userHint: "Exchange server error. This is usually temporary.",
        };
    }

    // Status 0 typically means network error
    if (httpStatus === 0) {
        return {
            category: "NETWORK_ERROR",
            severity: "RETRIABLE",
            action: "BACKOFF",
            consecutiveThreshold: 1,
            userHint: "Network connection error. Check your internet connection.",
        };
    }

    // Message-based classification - more specific patterns first

    // Signature errors (distinct from general auth)
    if (matchesAny(msg, SIGNATURE_PATTERNS) || matchesAny(code, SIGNATURE_PATTERNS)) {
        return {
            category: "SIGNATURE_MISMATCH",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Signature calculation error. Try regenerating your API keys on the exchange.",
        };
    }

    // IP whitelist errors
    if (matchesAny(msg, IP_PATTERNS) || matchesAny(code, IP_PATTERNS)) {
        return {
            category: "IP_BLOCKED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Your IP is not in the API key whitelist. Add your server IP in the exchange settings.",
        };
    }

    // Key expired errors
    if (matchesAny(msg, KEY_EXPIRED_PATTERNS) || matchesAny(code, KEY_EXPIRED_PATTERNS)) {
        return {
            category: "KEY_EXPIRED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Your API key has expired or been revoked. Generate new keys on the exchange.",
        };
    }

    // Generic auth failures (401/403 or message patterns)
    if (httpStatus === 401 || httpStatus === 403 || matchesAny(msg, AUTH_PATTERNS) || matchesAny(code, AUTH_PATTERNS)) {
        return {
            category: "AUTH_FAILED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Authentication failed. Verify your API key and secret are correct, and that the key has trade permissions.",
        };
    }

    if (matchesAny(msg, PERMISSION_PATTERNS) || matchesAny(code, PERMISSION_PATTERNS)) {
        return {
            category: "PERMISSION_DENIED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
            userHint: "Your API key doesn't have trade permissions. Enable trading in your exchange API settings.",
        };
    }

    if (matchesAny(msg, MARKET_PATTERNS) || matchesAny(code, MARKET_PATTERNS)) {
        return {
            category: "INVALID_MARKET",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
        };
    }

    if (matchesAny(msg, ACCOUNT_PATTERNS) || matchesAny(code, ACCOUNT_PATTERNS)) {
        return {
            category: "ACCOUNT_RESTRICTED",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 1,
        };
    }

    if (matchesAny(msg, BALANCE_PATTERNS) || matchesAny(code, BALANCE_PATTERNS)) {
        if (matchesAny(msg, ["minimum order", "min notional"]) || matchesAny(code, ["minimum order", "min notional"])) {
            return {
                category: "MIN_NOTIONAL",
                severity: "FATAL",
                action: "DISABLE",
                consecutiveThreshold: 1,
                userHint: "Order size below the exchange minimum. Increase budget to meet the minimum notional.",
            };
        }
        return {
            category: "INSUFFICIENT_BALANCE",
            severity: "FATAL",
            action: "DISABLE",
            consecutiveThreshold: 3, // Allow 3 failures before disabling
        };
    }

    if (matchesAny(msg, RATE_LIMIT_PATTERNS) || matchesAny(code, RATE_LIMIT_PATTERNS)) {
        return {
            category: "RATE_LIMIT",
            severity: "RETRIABLE",
            action: "BACKOFF",
            consecutiveThreshold: 1,
        };
    }

    if (matchesAny(msg, NETWORK_PATTERNS) || matchesAny(code, NETWORK_PATTERNS)) {
        return {
            category: "NETWORK_ERROR",
            severity: "RETRIABLE",
            action: "BACKOFF",
            consecutiveThreshold: 1,
        };
    }

    if (matchesAny(msg, TEMP_UNAVAILABLE_PATTERNS) || matchesAny(code, TEMP_UNAVAILABLE_PATTERNS)) {
        return {
            category: "TEMP_UNAVAILABLE",
            severity: "RETRIABLE",
            action: "BACKOFF",
            consecutiveThreshold: 1,
        };
    }

    // Default: treat as retriable unknown error
    return {
        category: "UNKNOWN",
        severity: "RETRIABLE",
        action: "BACKOFF",
        consecutiveThreshold: 1,
    };
}

/**
 * Sanitize error message for storage - remove sensitive data and truncate
 */
export function sanitizeErrorMessage(message: string, maxLength = 200): string {
    if (!message) return "";

    // Remove potential API keys/secrets (alphanumeric strings > 20 chars)
    let sanitized = message.replace(/[a-zA-Z0-9]{20,}/g, "[REDACTED]");

    // Remove URLs with potential secrets
    sanitized = sanitized.replace(/https?:\/\/[^\s]+/g, "[URL]");

    // Truncate to max length
    if (sanitized.length > maxLength) {
        sanitized = sanitized.slice(0, maxLength - 3) + "...";
    }

    return sanitized;
}

/**
 * Calculate backoff delay based on consecutive failure count.
 * Progression: 30s -> 60s -> 120s -> 240s -> 600s (max 10 min)
 */
export function calculateBackoffMs(consecutiveFailures: number): number {
    const baseMs = 30_000; // 30 seconds
    const maxMs = 600_000; // 10 minutes

    if (consecutiveFailures <= 0) return 0;

    // Exponential backoff: 30s * 2^(n-1)
    const delay = baseMs * Math.pow(2, Math.min(consecutiveFailures - 1, 4));
    return Math.min(delay, maxMs);
}
