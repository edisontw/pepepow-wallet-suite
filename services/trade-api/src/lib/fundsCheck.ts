/**
 * Funds Check Module
 * 
 * Calculates funds requirements for each strategy type and verifies
 * account balance is sufficient before starting REAL mode strategies.
 */

import { getNonkycBalances } from "../exchanges/nonkyc.js";
import { fetchExchangePrice } from "../strategies/price.js";
import { ExchangeName } from "./markets.js";
import { getNormalizedBalances } from "./balanceHelper.js";

// No shared global cache here anymore to avoid cross-user state leakage.
// Individual requests can use local caching within a single execution if needed.

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
    needQuote: number;
    quoteAsset: "USDT" | "BNB";
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
    quoteAsset: "USDT" | "BNB" = "USDT",
    midPrice?: number
): FundsRequirement {
    const notes: string[] = [];
    const BUFFER = 1.05; // 5% safety buffer

    if (strategy === "DCA") {
        // DCA: needs budget * buffer for each buy
        const budget = params.budget || params.quote_per_order || 1;
        return {
            needQuote: budget * BUFFER,
            quoteAsset,
            needPEPEW: 0,
            notes: [`DCA buy-only: ${budget} ${quoteAsset}/order + 5% buffer`],
        };
    }

    // GRID: needs total budget for buy orders
    // Use either total_quote_budget or compute from quote_per_order * levels
    let totalBudget = params.total_quote_budget || 0;
    const levels = params.grid_levels || 1;
    const perOrder = params.quote_per_order || params.per_order_quote || 0;

    if (totalBudget === 0 && perOrder > 0) {
        totalBudget = perOrder * levels;
    }

    const allowSell = params.allow_sell ?? false;

    if (allowSell && midPrice && midPrice > 0) {
        // If grid can sell, need some base inventory too
        const baseNeeded = totalBudget / midPrice;
        notes.push(`GRID two-sided: commitment ${totalBudget} ${quoteAsset} + ~${baseNeeded.toExponential(2)} PEPEW`);
        return {
            needQuote: totalBudget * BUFFER,
            quoteAsset,
            needPEPEW: baseNeeded * BUFFER,
            notes,
        };
    }

    if (strategy === "GRID") {
        notes.push(`GRID buy-only: commitment ${totalBudget} ${quoteAsset}`);
        return {
            needQuote: totalBudget * BUFFER,
            quoteAsset,
            needPEPEW: 0,
            notes,
        };
    }

    if (strategy === "MM") {
        const orderQuote = params.quote_per_order || params.order_quote || 2;
        const ordersPerSide = params.orders_per_side || 1;
        const totalPerSide = orderQuote * ordersPerSide;
        const mode = params.mode || "TWO_SIDED";

        if (mode === "ONE_SIDED_BUY") {
            notes.push(`MM ONE_SIDED_BUY: ${ordersPerSide} orders @ ${orderQuote} ${quoteAsset} + 5% buffer`);
            return {
                needQuote: totalPerSide * BUFFER,
                quoteAsset,
                needPEPEW: 0,
                notes,
            };
        }

        if (mode === "ONE_SIDED_SELL") {
            if (!midPrice || midPrice <= 0) {
                notes.push(`MM ONE_SIDED_SELL: price unavailable, estimating conservatively`);
                return {
                    needQuote: 0,
                    quoteAsset,
                    needPEPEW: 1e9 * BUFFER, // 1B PEPEW as conservative estimate
                    notes,
                };
            }
            const baseNeeded = totalPerSide / midPrice;
            notes.push(`MM ONE_SIDED_SELL: ${baseNeeded.toExponential(2)} PEPEW + 5% buffer`);
            return {
                needQuote: 0,
                quoteAsset,
                needPEPEW: baseNeeded * BUFFER,
                notes,
            };
        }

        // TWO_SIDED (default)
        if (!midPrice || midPrice <= 0) {
            notes.push(`MM TWO_SIDED: price unavailable, can't compute PEPEW requirement`);
            return {
                needQuote: totalPerSide * BUFFER,
                quoteAsset,
                needPEPEW: 0, // Can't calculate without price
                notes,
            };
        }

        const baseNeeded = totalPerSide / midPrice;
        notes.push(`MM TWO_SIDED: ${totalPerSide} ${quoteAsset} buy + ${baseNeeded.toExponential(2)} PEPEW sell + 5% buffer`);
        return {
            needQuote: totalPerSide * BUFFER,
            quoteAsset,
            needPEPEW: baseNeeded * BUFFER,
            notes,
        };
    }

    // Unknown strategy
    return { needQuote: 0, quoteAsset, needPEPEW: 0, notes: ["Unknown strategy type"] };
}

/**
 * Fetch and normalize account balance for any supported exchange
 */
export async function getExchangeNormalizedBalance(
    exchange: ExchangeName,
    accessKey: string,
    secretKey: string,
    quoteAsset: "USDT" | "BNB" = "USDT",
    useCache = true
): Promise<{
    data: { freeQuote: number; freePEPEW: number; freeUSDT?: number; freeBNB?: number };
    metadata: {
        fetchedAt: number;
        cacheAgeMs: number;
        isCached: boolean;
        symbolsFound: string[];
        quoteAsset: string;
        exchange: string;
    }
} | null> {
    try {
        if (process.env.TRADE_DEBUG_STATUS === "1" || !useCache) {
            console.log(`[fundsCheck] balance FETCH request exchange=${exchange} key_fingerprint=${keyFingerprint(accessKey)} quote=${quoteAsset} cache_requested=${useCache}`);
        }

        const bal = await getNormalizedBalances(exchange, accessKey, secretKey, undefined, useCache);

        if (!bal.ok) {
            console.error(`[fundsCheck] failed to fetch balances for ${exchange}: ${bal.error || bal.reason}`);
            return null;
        }

        const freeQuote = quoteAsset === "BNB" ? bal.assets.BNB : bal.assets.USDT;
        const freePEPEW = bal.assets.PEPEW;
        const now = Date.now();

        return {
            data: {
                freeQuote,
                freePEPEW,
                ...bal.assets
            },
            metadata: {
                quoteAsset,
                exchange,
                fetchedAt: bal.cachedAt || now,
                cacheAgeMs: bal.cachedAt ? (now - bal.cachedAt) : 0,
                isCached: !!bal.cachedAt,
                symbolsFound: Object.keys(bal.assets)
            }
        };
    } catch (err: any) {
        console.error(`[fundsCheck] error for ${exchange}: ${err.message}`);
        return null;
    }
}

/**
 * Clear the balance cache (No-op since cache is removed)
 */
export function clearBalanceCache(): void {
    // balanceCache = null;
}

/**
 * Check if available funds meet requirements
 */
export function checkFundsStatus(
    need: FundsRequirement,
    available: { freeQuote: number; freePEPEW: number }
): { status: "PASS" | "WARN" | "FAIL"; messages: string[] } {
    const messages: string[] = [];
    const WARN_BUFFER = 1.2; // 20% buffer for "marginal" warning

    const quoteOk = available.freeQuote >= need.needQuote;
    const quoteMarginal = available.freeQuote >= need.needQuote && available.freeQuote < (need.needQuote * WARN_BUFFER);
    const pepewOk = need.needPEPEW === 0 || available.freePEPEW >= need.needPEPEW;
    const pepewMarginal = need.needPEPEW > 0 && available.freePEPEW >= need.needPEPEW && available.freePEPEW < (need.needPEPEW * WARN_BUFFER);

    const qAsset = need.quoteAsset;

    if (!quoteOk) {
        messages.push(`${qAsset}: need ${need.needQuote.toFixed(qAsset === "BNB" ? 4 : 2)}, have ${available.freeQuote.toFixed(qAsset === "BNB" ? 4 : 2)} ❌`);
    } else if (quoteMarginal) {
        messages.push(`${qAsset}: need ${need.needQuote.toFixed(qAsset === "BNB" ? 4 : 2)}, have ${available.freeQuote.toFixed(qAsset === "BNB" ? 4 : 2)} ⚠️ (marginal)`);
    } else if (need.needQuote > 0) {
        messages.push(`${qAsset}: need ${need.needQuote.toFixed(qAsset === "BNB" ? 4 : 2)}, have ${available.freeQuote.toFixed(qAsset === "BNB" ? 4 : 2)} ✓`);
    }

    if (!pepewOk) {
        messages.push(`PEPEW: need ${need.needPEPEW.toExponential(2)}, have ${available.freePEPEW.toExponential(2)} ❌`);
    } else if (pepewMarginal) {
        messages.push(`PEPEW: need ${need.needPEPEW.toExponential(2)}, have ${available.freePEPEW.toExponential(2)} ⚠️ (marginal)`);
    } else if (need.needPEPEW > 0) {
        messages.push(`PEPEW: need ${need.needPEPEW.toExponential(2)}, have ${available.freePEPEW.toExponential(2)} ✓`);
    }

    if (!quoteOk || !pepewOk) {
        return { status: "FAIL", messages };
    }
    if (quoteMarginal || pepewMarginal) {
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

    const quoteAsset = (pair.toUpperCase().endsWith("BNB") || pair.toUpperCase().endsWith("_BNB")) ? "BNB" : "USDT";

    // Compute requirements
    const need = computeFundsRequirement(strategy, params, quoteAsset, midPrice);

    // Fetch balance
    const balanceResult = await getExchangeNormalizedBalance(exchange, accessKey, secretKey, quoteAsset);
    if (!balanceResult) {
        return null; // Could not fetch balance
    }

    // Normalize balance object for checkFundsStatus
    const available = {
        freeQuote: balanceResult.data.freeQuote,
        freePEPEW: balanceResult.data.freePEPEW
    };

    // Compare
    const check = checkFundsStatus(need, available);

    return {
        ...check,
        need,
        available: { freeUSDT: (balanceResult.data as any).freeUSDT || 0, freePEPEW: balanceResult.data.freePEPEW }, // Carry over USDT for backward compatibility if needed, or update interface
    } as any;
}
