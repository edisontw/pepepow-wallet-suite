/**
 * Funds Check Module
 * 
 * Calculates funds requirements for each strategy type and verifies
 * account balance is sufficient before starting REAL mode strategies.
 */

import { getNonkycBalances } from "../exchanges/nonkyc.js";
import { fetchExchangePrice } from "../strategies/price.js";
import { ExchangeName } from "./markets.js";

// Cache for balance lookups (to avoid hitting API on every strategy status check)
let balanceCache: {
    data: { freeUSDT: number; freePEPEW: number } | null;
    fetchedAt: number;
} | null = null;

const BALANCE_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Normalize asset symbol to internal canonical form.
 * Handles known aliases from different exchanges.
 */
function normalizeAssetSymbol(symbol: string): string {
    const normalized = symbol.toUpperCase().trim();
    // Map known aliases (NonKYC uses PEPEPOW, we use PEPEW internally)
    if (normalized === "PEPEPOW") return "PEPEW";
    return normalized;
}

/**
 * Get key fingerprint for logging (first 4 + last 4 chars)
 */
function keyFingerprint(key: string): string {
    if (!key || key.length < 8) return "***";
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export interface FundsRequirement {
    needUSDT: number;
    needPEPEW: number;
    notes: string[];
}

export interface FundsCheckResult {
    status: "PASS" | "WARN" | "FAIL";
    messages: string[];
    need: FundsRequirement;
    available: { freeUSDT: number; freePEPEW: number };
}

/**
 * Compute funds requirement for a strategy based on its type and params
 */
export function computeFundsRequirement(
    strategy: "DCA" | "GRID" | "MM",
    params: Record<string, any>,
    midPrice?: number
): FundsRequirement {
    const notes: string[] = [];
    const BUFFER = 1.05; // 5% safety buffer

    if (strategy === "DCA") {
        // DCA: needs quote_per_order * buffer for each buy
        const quotePerOrder = params.budget || params.quote_per_order || 1;
        return {
            needUSDT: quotePerOrder * BUFFER,
            needPEPEW: 0,
            notes: [`DCA buy-only: ${quotePerOrder} USDT/order + 5% buffer`],
        };
    }

    if (strategy === "GRID") {
        // GRID: needs total budget for buy orders
        // Conservative: assume buy-only grid (most common)
        const totalBudget = params.total_quote_budget || 10;
        const allowSell = params.allow_sell ?? false;

        if (allowSell && midPrice && midPrice > 0) {
            // If grid can sell, need some base inventory too
            const halfBudget = totalBudget / 2;
            const estimatedBase = halfBudget / midPrice;
            notes.push(`GRID two-sided: assumes 50% buy / 50% sell`);
            return {
                needUSDT: halfBudget * BUFFER,
                needPEPEW: estimatedBase * BUFFER,
                notes,
            };
        }

        notes.push(`GRID buy-only: ${totalBudget} USDT total budget + 5% buffer`);
        return {
            needUSDT: totalBudget * BUFFER,
            needPEPEW: 0,
            notes,
        };
    }

    if (strategy === "MM") {
        const orderQuote = params.order_quote || 2;
        const mode = params.mode || "TWO_SIDED";

        if (mode === "ONE_SIDED_BUY") {
            notes.push(`MM ONE_SIDED_BUY: ${orderQuote} USDT/order + 5% buffer`);
            return {
                needUSDT: orderQuote * BUFFER,
                needPEPEW: 0,
                notes,
            };
        }

        if (mode === "ONE_SIDED_SELL") {
            if (!midPrice || midPrice <= 0) {
                notes.push(`MM ONE_SIDED_SELL: price unavailable, estimating conservatively`);
                return {
                    needUSDT: 0,
                    needPEPEW: 1e9 * BUFFER, // 1B PEPEW as conservative estimate
                    notes,
                };
            }
            const baseNeeded = orderQuote / midPrice;
            notes.push(`MM ONE_SIDED_SELL: ${baseNeeded.toExponential(2)} PEPEW + 5% buffer`);
            return {
                needUSDT: 0,
                needPEPEW: baseNeeded * BUFFER,
                notes,
            };
        }

        // TWO_SIDED (default)
        if (!midPrice || midPrice <= 0) {
            notes.push(`MM TWO_SIDED: price unavailable, can't compute PEPEW requirement`);
            return {
                needUSDT: orderQuote * BUFFER,
                needPEPEW: 0, // Can't calculate without price
                notes,
            };
        }

        const baseNeeded = orderQuote / midPrice;
        notes.push(`MM TWO_SIDED: ${orderQuote} USDT buy + ${baseNeeded.toExponential(2)} PEPEW sell + 5% buffer`);
        return {
            needUSDT: orderQuote * BUFFER,
            needPEPEW: baseNeeded * BUFFER,
            notes,
        };
    }

    // Unknown strategy
    return { needUSDT: 0, needPEPEW: 0, notes: ["Unknown strategy type"] };
}

/**
 * Fetch and normalize NonKYC account balance (single source of truth)
 */
export async function getNonKycNormalizedBalance(
    accessKey: string,
    secretKey: string,
    useCache = true
): Promise<{
    data: { freeUSDT: number; freePEPEW: number };
    metadata: {
        fetchedAt: number;
        cacheAgeMs: number;
        isCached: boolean;
        symbolsFound: string[];
    }
} | null> {
    const now = Date.now();

    // Return cached data if fresh
    if (useCache && balanceCache && now - balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS && balanceCache.data) {
        if (process.env.TRADE_DEBUG_STATUS === "1") {
            console.log(`[fundsCheck] balance CACHE hit: age=${now - balanceCache.fetchedAt}ms`);
        }
        return {
            data: balanceCache.data,
            metadata: {
                fetchedAt: balanceCache.fetchedAt,
                cacheAgeMs: now - balanceCache.fetchedAt,
                isCached: true,
                symbolsFound: ["USDT", "PEPEW"], // Simplified for cache
            }
        };
    }

    try {
        // Log key fingerprint for debugging (to verify same key used for orders vs balance)
        if (process.env.TRADE_DEBUG_STATUS === "1" || !useCache) {
            console.log(`[fundsCheck] balance FETCH request key_fingerprint=${keyFingerprint(accessKey)} cache_requested=${useCache}`);
        }

        const result = await getNonkycBalances(accessKey, secretKey);
        if (!result.ok || !result.data) {
            console.warn(`[fundsCheck] balance fetch failed: ${result.error || "unknown"}`);
            return null;
        }

        // Parse balance data - NonKYC returns array of { currency, available, reserved }
        const balances = Array.isArray(result.data) ? result.data : [];

        let freeUSDT = 0;
        let freePEPEW = 0;

        const symbolsFound: string[] = [];
        for (const bal of balances) {
            // Use normalizeAssetSymbol to handle aliases (e.g., PEPEPOW -> PEPEW)
            const rawCurrency = String(bal.currency || bal.asset || "");
            const currency = normalizeAssetSymbol(rawCurrency);
            const available = Number(bal.available || bal.free || 0);

            symbolsFound.push(rawCurrency);

            if (currency === "USDT") {
                freeUSDT = available;
            } else if (currency === "PEPEW") {
                freePEPEW = available;
            }
        }

        if (process.env.TRADE_DEBUG_STATUS === "1") {
            console.log(`[fundsCheck] balance normalized: USDT=${freeUSDT.toFixed(4)}, PEPEW=${freePEPEW.toExponential(2)} (symbols found: ${symbolsFound.length})`);
        }

        const data = { freeUSDT, freePEPEW };
        balanceCache = { data, fetchedAt: now };

        const metadata = {
            fetchedAt: now,
            cacheAgeMs: 0,
            isCached: false,
            symbolsFound,
        };

        return { data, metadata };

    } catch (err: any) {
        console.error(`[fundsCheck] balance fetch error: ${err?.message || err}`);
        return null;
    }
}

/**
 * Clear the balance cache (call when needed to force refresh)
 */
export function clearBalanceCache(): void {
    balanceCache = null;
}

/**
 * Check if available funds meet requirements
 */
export function checkFundsStatus(
    need: FundsRequirement,
    available: { freeUSDT: number; freePEPEW: number }
): { status: "PASS" | "WARN" | "FAIL"; messages: string[] } {
    const messages: string[] = [];
    const WARN_BUFFER = 1.2; // 20% buffer for "marginal" warning

    const usdtOk = available.freeUSDT >= need.needUSDT;
    const usdtMarginal = available.freeUSDT >= need.needUSDT && available.freeUSDT < need.needUSDT * WARN_BUFFER;
    const pepewOk = need.needPEPEW === 0 || available.freePEPEW >= need.needPEPEW;
    const pepewMarginal = need.needPEPEW > 0 && available.freePEPEW >= need.needPEPEW && available.freePEPEW < need.needPEPEW * WARN_BUFFER;

    if (!usdtOk) {
        messages.push(`USDT: need ${need.needUSDT.toFixed(2)}, have ${available.freeUSDT.toFixed(2)} ❌`);
    } else if (usdtMarginal) {
        messages.push(`USDT: need ${need.needUSDT.toFixed(2)}, have ${available.freeUSDT.toFixed(2)} ⚠️ (marginal)`);
    } else if (need.needUSDT > 0) {
        messages.push(`USDT: need ${need.needUSDT.toFixed(2)}, have ${available.freeUSDT.toFixed(2)} ✓`);
    }

    if (!pepewOk) {
        messages.push(`PEPEW: need ${need.needPEPEW.toExponential(2)}, have ${available.freePEPEW.toExponential(2)} ❌`);
    } else if (pepewMarginal) {
        messages.push(`PEPEW: need ${need.needPEPEW.toExponential(2)}, have ${available.freePEPEW.toExponential(2)} ⚠️ (marginal)`);
    } else if (need.needPEPEW > 0) {
        messages.push(`PEPEW: need ${need.needPEPEW.toExponential(2)}, have ${available.freePEPEW.toExponential(2)} ✓`);
    }

    if (!usdtOk || !pepewOk) {
        return { status: "FAIL", messages };
    }
    if (usdtMarginal || pepewMarginal) {
        return { status: "WARN", messages };
    }
    return { status: "PASS", messages };
}

/**
 * Full funds check: compute requirements, fetch balance, compare
 */
export async function performFundsCheck(
    strategy: "DCA" | "GRID" | "MM",
    params: Record<string, any>,
    exchange: ExchangeName,
    pair: string,
    accessKey: string,
    secretKey: string
): Promise<FundsCheckResult | null> {
    // Get current price for PEPEW calculations
    let midPrice: number | undefined;
    try {
        const priceResult = await fetchExchangePrice(exchange, pair);
        midPrice = priceResult?.price;
    } catch (err) {
        console.warn(`[fundsCheck] price fetch failed, proceeding without midPrice`);
    }

    // Compute requirements
    const need = computeFundsRequirement(strategy, params, midPrice);

    // Fetch balance
    const balanceResult = await getNonKycNormalizedBalance(accessKey, secretKey);
    if (!balanceResult) {
        return null; // Could not fetch balance
    }
    const available = balanceResult.data;

    // Compare
    const check = checkFundsStatus(need, available);

    return {
        ...check,
        need,
        available,
    };
}
