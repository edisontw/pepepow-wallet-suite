export type TradeLogLevel = "debug" | "info" | "warn" | "error";
export type TradeLogType = "AUDIT" | "INFO" | "DEBUG";

type LogThrottleState = {
    startedAt: number;
    suppressed: number;
};

type LogParams = {
    scope: string;
    message: string;
    level?: TradeLogLevel;
    type?: TradeLogType;
    strategyId?: string | number | null;
    exchange?: string | null;
    throttleKey?: string;
    throttleSec?: number;
    force?: boolean;
};

const LEVEL_ORDER: Record<TradeLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const DEFAULT_LEVEL = normalizeLevel(process.env.LOG_LEVEL || "info");
const DEFAULT_THROTTLE_SEC = Math.max(1, Number(process.env.LOG_THROTTLE_SEC || 30));
const ERROR_DEDUPE_SEC = Math.max(DEFAULT_THROTTLE_SEC, Number(process.env.LOG_ERROR_DEDUPE_SEC || 60));
const DEBUG_STRATEGY_IDS = parseCsvSet(process.env.DEBUG_STRATEGY_ID);
const DEBUG_EXCHANGES = parseCsvSet(process.env.DEBUG_EXCHANGE);

const throttleStates = new Map<string, LogThrottleState>();

function parseCsvSet(value: string | undefined): Set<string> {
    if (!value) return new Set<string>();
    return new Set(
        value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v) => v.toLowerCase())
    );
}

function normalizeLevel(value: string): TradeLogLevel {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
        return normalized;
    }
    return "info";
}

function normalizeType(level: TradeLogLevel, explicit?: TradeLogType): TradeLogType {
    if (explicit) return explicit;
    if (level === "debug") return "DEBUG";
    return "INFO";
}

function shouldEmit(level: TradeLogLevel, type: TradeLogType, strategyId?: string | number | null, exchange?: string | null): boolean {
    if (type === "AUDIT") return true;

    if (level === "debug") {
        if (DEFAULT_LEVEL === "debug") return true;
        const strategyMatch =
            strategyId !== null &&
            strategyId !== undefined &&
            DEBUG_STRATEGY_IDS.size > 0 &&
            DEBUG_STRATEGY_IDS.has(String(strategyId).toLowerCase());
        const exchangeMatch =
            exchange !== null &&
            exchange !== undefined &&
            DEBUG_EXCHANGES.size > 0 &&
            DEBUG_EXCHANGES.has(String(exchange).toLowerCase());
        return strategyMatch || exchangeMatch;
    }

    return LEVEL_ORDER[level] >= LEVEL_ORDER[DEFAULT_LEVEL];
}

function autoDedupeCode(message: string): string | null {
    const upper = String(message || "").toUpperCase();
    const codes = ["NO_BOOK", "STALE_BOOK", "DAILY_CAP", "MIN_NOTIONAL", "NO_CROSSING", "CROSSING"];
    for (const code of codes) {
        if (upper.includes(code)) return code;
    }
    return null;
}

function resolveThrottle(params: {
    now: number;
    throttleKey?: string;
    throttleSec?: number;
    autoCode?: string | null;
    scope: string;
    exchange?: string | null;
}): { shouldEmit: boolean; suppressed: number } {
    const explicitKey = params.throttleKey ? String(params.throttleKey).trim() : "";
    const autoKey = params.autoCode ? `${params.scope}:${params.exchange || "*"}:${params.autoCode}` : "";
    const key = explicitKey || autoKey;
    if (!key) return { shouldEmit: true, suppressed: 0 };

    const throttleSec = params.throttleSec || (params.autoCode ? ERROR_DEDUPE_SEC : DEFAULT_THROTTLE_SEC);
    const throttleMs = Math.max(1, throttleSec) * 1000;
    const prev = throttleStates.get(key);

    if (!prev) {
        throttleStates.set(key, { startedAt: params.now, suppressed: 0 });
        return { shouldEmit: true, suppressed: 0 };
    }

    if (params.now - prev.startedAt < throttleMs) {
        prev.suppressed += 1;
        throttleStates.set(key, prev);
        return { shouldEmit: false, suppressed: 0 };
    }

    const suppressed = prev.suppressed;
    throttleStates.set(key, { startedAt: params.now, suppressed: 0 });
    return { shouldEmit: true, suppressed };
}

function stringifyPart(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function emit(level: TradeLogLevel, line: string): void {
    if (level === "error") {
        console.error(line);
        return;
    }
    if (level === "warn") {
        console.warn(line);
        return;
    }
    console.log(line);
}

export function tradeLog(params: LogParams): void {
    const level = params.level || "info";
    const type = normalizeType(level, params.type);

    if (!params.force && !shouldEmit(level, type, params.strategyId, params.exchange)) {
        return;
    }

    const now = Date.now();
    const autoCode = autoDedupeCode(params.message);
    const throttle = resolveThrottle({
        now,
        throttleKey: params.throttleKey,
        throttleSec: params.throttleSec,
        autoCode,
        scope: params.scope,
        exchange: params.exchange,
    });

    if (!params.force && !throttle.shouldEmit) return;

    const ts = new Date(now).toISOString();
    const parts: string[] = [`[${params.scope}]`, `[${type}]`, ts];

    const strategyId = stringifyPart(params.strategyId);
    const exchange = stringifyPart(params.exchange);
    if (strategyId) parts.push(`strategyId=${strategyId}`);
    if (exchange) parts.push(`exchange=${exchange}`);

    let message = params.message;
    if (throttle.suppressed > 0) {
        message = `${message} suppressed=${throttle.suppressed}`;
    }

    parts.push(message);
    emit(level, parts.join(" "));
}

export function tradeAuditLog(params: Omit<LogParams, "type" | "level"> & { level?: TradeLogLevel }): void {
    tradeLog({ ...params, type: "AUDIT", level: params.level || "info", force: true });
}
