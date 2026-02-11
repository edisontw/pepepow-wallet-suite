import { getNonkycBalances } from "../exchanges/nonkyc.js";
import { getDexTradeBalances } from "../exchanges/dextrade.js";
import { getNestExBalances } from "../exchanges/nestex.js";
import { normalizeBalance } from "../balances/normalizeBalance.js";
import { ExchangeName } from "./markets.js";
import { BalanceSnapshot, ExchangeId } from "../registry/types.js";
import { tradeLog } from "./tradeLogger.js";

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
    cachedAt?: number;
    snapshot?: BalanceSnapshot;
    errCode?: string;
    lastOkTs?: number;
    degraded?: boolean;
    failCount?: number;
    stalenessMs?: number;
}

type CacheValue = {
    snapshot?: BalanceSnapshot;
    lastOkTs?: number;
    lastTryTs: number;
    failCount: number;
    lastErr?: { code: string; msg: string; ts: number };
};

const balanceCache = new Map<string, CacheValue>();
const BALANCE_TTL_MS = Number(process.env.BALANCE_TTL_MS || 15000);
const STALE_OK_MS = Number(process.env.BALANCE_STALE_OK_MS || 300000);

function normalizeReason(value: string | undefined | null): string {
    if (!value) return "FETCH_FAILED";
    return value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function getCacheKey(exchange: string, apiKey: string, tgUserId?: string): string {
    const userPart = tgUserId || apiKey.slice(-8);
    return `${exchange}:${userPart}`;
}

function fromSnapshot(snapshot: BalanceSnapshot): NormalizedBalance {
    return {
        ok: true,
        exchange: snapshot.exchangeId,
        assets: {
            USDT: snapshot.assets.USDT.free,
            BNB: snapshot.assets.BNB.free,
            PEPEW: snapshot.assets.PEPEW.free,
        },
        snapshot,
        cachedAt: snapshot.ts,
        stalenessMs: snapshot.stalenessMs,
    };
}

function markFailure(cacheKey: string, exchange: string, code: string, msg: string): NormalizedBalance {
    const now = Date.now();
    const cached = balanceCache.get(cacheKey);
    const failCount = (cached?.failCount || 0) + 1;
    balanceCache.set(cacheKey, {
        snapshot: cached?.snapshot,
        lastOkTs: cached?.lastOkTs,
        lastTryTs: now,
        failCount,
        lastErr: { code, msg, ts: now },
    });
    const lastOkTs = cached?.lastOkTs || undefined;
    return {
        ok: false,
        exchange,
        assets: { USDT: 0, BNB: 0, PEPEW: 0 },
        error: msg,
        reason: code,
        errCode: code,
        lastOkTs,
        failCount,
    };
}

export async function getNormalizedBalances(
    exchange: ExchangeName,
    apiKey: string,
    apiSecret: string,
    tgUserIdForRateLimit?: string,
    useCache = true
): Promise<NormalizedBalance> {
    const cacheKey = getCacheKey(exchange, apiKey, tgUserIdForRateLimit);
    const now = Date.now();

    if (useCache) {
        const cached = balanceCache.get(cacheKey);
        if (cached?.snapshot && now - cached.lastTryTs < BALANCE_TTL_MS) {
            const stalenessMs = now - cached.snapshot.ts;
            const snapshot: BalanceSnapshot = {
                ...cached.snapshot,
                source: "cached",
                stalenessMs,
            };
            tradeLog({
                scope: "balance",
                level: "debug",
                exchange,
                message: `BALANCE_CACHED_HIT stalenessMs=${stalenessMs}`,
                throttleKey: `balance:cached:${exchange}`,
                throttleSec: 30,
            });
            return fromSnapshot(snapshot);
        }
    }

    try {
        const before = balanceCache.get(cacheKey);
        const failCount = before?.failCount || 0;
        let fetchResult: { ok: boolean; data?: any; error?: string; reason?: string; code?: string | number; status?: number };

        if (exchange === "nonkyc") {
            fetchResult = await getNonkycBalances(apiKey, apiSecret);
        } else if (exchange === "dextrade") {
            fetchResult = await getDexTradeBalances(apiKey, apiSecret);
        } else if (exchange === "nestex") {
            fetchResult = await getNestExBalances(apiKey, apiSecret, tgUserIdForRateLimit || "default");
        } else {
            return markFailure(cacheKey, exchange, "UNSUPPORTED", `Unsupported exchange: ${exchange}`);
        }

        if (!fetchResult.ok) {
            const code = normalizeReason(
                (typeof fetchResult.code === "string" ? fetchResult.code : undefined) ||
                fetchResult.reason ||
                (fetchResult.status === 401 || fetchResult.status === 403 ? "AUTH_FAILED" : undefined) ||
                "BALANCE_FETCH_FAILED"
            );
            const msg = fetchResult.error || `BALANCE_FETCH_FAILED: exchange=${exchange}`;
            const lastOkTs = before?.lastOkTs;
            const lastOkAgeSec = lastOkTs ? Math.max(0, Math.round((now - lastOkTs) / 1000)) : null;
            const nextFailCount = failCount + 1;
            const canUseCached = !!before?.snapshot && !!lastOkTs && (now - lastOkTs) < STALE_OK_MS;
            const action = canUseCached ? "USE_CACHED" : "HARD_FAIL";
            tradeLog({
                scope: "balance",
                level: "warn",
                exchange,
                message: `BALANCE_LIVE_FAIL errCode=${code} httpStatus=${fetchResult.status ?? "n/a"} failCount=${nextFailCount} lastOkAgeSec=${lastOkAgeSec ?? "n/a"} action=${action}`,
                throttleKey: `balance:live-fail:${exchange}:${code}:${action}`,
                throttleSec: 30,
            });

            if (canUseCached && before?.snapshot) {
                balanceCache.set(cacheKey, {
                    snapshot: before.snapshot,
                    lastOkTs: before.lastOkTs,
                    lastTryTs: now,
                    failCount: nextFailCount,
                    lastErr: { code, msg, ts: now },
                });
                const snapshot: BalanceSnapshot = {
                    ...before.snapshot,
                    source: "cached",
                    stalenessMs: now - before.snapshot.ts,
                };
                const response = fromSnapshot(snapshot);
                response.degraded = true;
                response.errCode = code;
                response.error = msg;
                response.lastOkTs = lastOkTs;
                response.failCount = nextFailCount;
                return response;
            }
            return markFailure(cacheKey, exchange, code, msg);
        }

        try {
            const snapshot = normalizeBalance(exchange as ExchangeId, fetchResult.data, {
                source: "live",
                stalenessMs: 0,
                ts: now,
            });
            tradeLog({
                scope: "balance",
                level: "info",
                exchange,
                message: "BALANCE_LIVE_OK",
                throttleKey: `balance:live-ok:${exchange}`,
                throttleSec: 30,
            });
            balanceCache.set(cacheKey, {
                snapshot,
                lastOkTs: now,
                lastTryTs: now,
                failCount: 0,
            });
            const response = fromSnapshot(snapshot);
            response.lastOkTs = now;
            response.failCount = 0;
            return response;
        } catch (err: any) {
            const msg = err?.message || "BALANCE_PARSE_FAILED";
            const code = "BALANCE_PARSE_FAILED";
            const lastOkTs = before?.lastOkTs;
            const lastOkAgeSec = lastOkTs ? Math.max(0, Math.round((now - lastOkTs) / 1000)) : null;
            const nextFailCount = failCount + 1;
            const canUseCached = !!before?.snapshot && !!lastOkTs && (now - lastOkTs) < STALE_OK_MS;
            const action = canUseCached ? "USE_CACHED" : "HARD_FAIL";
            tradeLog({
                scope: "balance",
                level: "warn",
                exchange,
                message: `BALANCE_LIVE_FAIL errCode=${code} httpStatus=n/a failCount=${nextFailCount} lastOkAgeSec=${lastOkAgeSec ?? "n/a"} action=${action}`,
                throttleKey: `balance:live-fail:${exchange}:${code}:${action}`,
                throttleSec: 30,
            });
            if (canUseCached && before?.snapshot) {
                balanceCache.set(cacheKey, {
                    snapshot: before.snapshot,
                    lastOkTs: before.lastOkTs,
                    lastTryTs: now,
                    failCount: nextFailCount,
                    lastErr: { code, msg, ts: now },
                });
                const snapshot: BalanceSnapshot = {
                    ...before.snapshot,
                    source: "cached",
                    stalenessMs: now - before.snapshot.ts,
                };
                const response = fromSnapshot(snapshot);
                response.degraded = true;
                response.errCode = code;
                response.error = msg;
                response.lastOkTs = lastOkTs;
                response.failCount = nextFailCount;
                return response;
            }
            return markFailure(cacheKey, exchange, code, msg);
        }
    } catch (err: any) {
        return markFailure(cacheKey, exchange, "INTERNAL_ERROR", err?.message || "Unknown balance error");
    }
}

export function getLastBalanceMeta(exchange: string, apiKey: string, tgUserIdForRateLimit?: string): {
    lastOkTs?: number;
    lastErrCode?: string;
    lastErrMsg?: string;
    lastErrTs?: number;
    failCount?: number;
    lastTryTs?: number;
} {
    const key = getCacheKey(exchange, apiKey, tgUserIdForRateLimit);
    const cached = balanceCache.get(key);
    const lastErr = cached?.lastErr;
    return {
        lastOkTs: cached?.lastOkTs || undefined,
        lastErrCode: lastErr?.code,
        lastErrMsg: lastErr?.msg,
        lastErrTs: lastErr?.ts,
        failCount: cached?.failCount || 0,
        lastTryTs: cached?.lastTryTs || undefined,
    };
}
