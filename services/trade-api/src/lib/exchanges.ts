/**
 * Unified Exchange Capabilities
 * Single source of truth for all exchange-related configuration
 */

export type ExchangeId = "nonkyc" | "dextrade" | "nestex";
export type QuoteAsset = "BNB" | "USDT";

export interface ExchangeCapability {
    supportsReal: boolean;
    displayName: string;
    minNotional: Partial<Record<QuoteAsset, number>>;
    qtyPrecision: number;
    pricePrecision: number;
}

export const EXCHANGE_CAPS: Record<ExchangeId, ExchangeCapability> = {
    nonkyc: {
        supportsReal: true,
        displayName: "NonKYC",
        minNotional: { BNB: 0.001, USDT: 0.5 },
        qtyPrecision: 0,  // No decimals for PEPEW qty
        pricePrecision: 12,
    },
    dextrade: {
        supportsReal: true,
        displayName: "Dex-Trade",
        minNotional: { USDT: 1 },
        qtyPrecision: 0,
        pricePrecision: 12,
    },
    nestex: {
        supportsReal: true,
        displayName: "NestEX",
        minNotional: { USDT: 1 },
        qtyPrecision: 0,
        pricePrecision: 8,
    },
};

/**
 * Check if an exchange supports REAL trading mode
 */
export function supportsReal(exchange: string): boolean {
    const caps = EXCHANGE_CAPS[exchange as ExchangeId];
    return caps?.supportsReal ?? false;
}

/**
 * Check if an exchange supports PAPER trading mode
 */
export function supportsPaper(exchange: string): boolean {
    return false;
}

/**
 * Get the minimum notional (quote amount) for an exchange/quote pair
 */
export function getMinNotional(exchange: string, quote: string): number {
    const caps = EXCHANGE_CAPS[exchange as ExchangeId];
    if (!caps) return 0;
    return caps.minNotional[quote as QuoteAsset] ?? 0;
}

/**
 * Get display name for an exchange
 */
export function getExchangeDisplayName(exchange: string): string {
    const caps = EXCHANGE_CAPS[exchange as ExchangeId];
    return caps?.displayName ?? exchange;
}

/**
 * Validate if exchange ID is canonical
 */
export function isValidExchange(exchange: string): exchange is ExchangeId {
    return exchange in EXCHANGE_CAPS;
}

/**
 * Get quantity precision for an exchange
 */
export function getQtyPrecision(exchange: string): number {
    const caps = EXCHANGE_CAPS[exchange as ExchangeId];
    return caps?.qtyPrecision ?? 0;
}

/**
 * Get price precision for an exchange
 */
export function getPricePrecision(exchange: string): number {
    const caps = EXCHANGE_CAPS[exchange as ExchangeId];
    return caps?.pricePrecision ?? 8;
}

/**
 * Round quantity to exchange precision
 */
export function roundQty(exchange: string, qty: number): number {
    const precision = getQtyPrecision(exchange);
    const factor = Math.pow(10, precision);
    return Math.floor(qty * factor) / factor;
}

/**
 * Round price to exchange precision
 */
export function roundPrice(exchange: string, price: number): number {
    const precision = getPricePrecision(exchange);
    const factor = Math.pow(10, precision);
    return Math.round(price * factor) / factor;
}
