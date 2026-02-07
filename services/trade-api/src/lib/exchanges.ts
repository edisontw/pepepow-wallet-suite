import { getExchangeSpec, normalizeExchangeId, getPairLimits } from "../registry/exchanges.js";
import { ExchangeId } from "../registry/types.js";

export type { ExchangeId };
export type QuoteAsset = "BNB" | "USDT";

export interface ExchangeCapability {
    supportsReal: boolean;
    displayName: string;
    minNotional: Partial<Record<QuoteAsset, number>>;
    qtyPrecision: number;
    pricePrecision: number;
}

function tickToPrecision(tick: number): number {
    if (!Number.isFinite(tick) || tick <= 0) return 8;
    const asText = tick.toString();
    if (asText.includes("e-")) {
        return Number(asText.split("e-")[1]);
    }
    const idx = asText.indexOf(".");
    return idx >= 0 ? asText.length - idx - 1 : 0;
}

export const EXCHANGE_CAPS: Record<ExchangeId, ExchangeCapability> = {
    nonkyc: {
        supportsReal: true,
        displayName: getExchangeSpec("nonkyc").displayName,
        minNotional: {
            BNB: getPairLimits("nonkyc", "PEPEW/BNB").minNotional,
            USDT: getPairLimits("nonkyc", "PEPEW/USDT").minNotional,
        },
        qtyPrecision: tickToPrecision(getExchangeSpec("nonkyc").precision.qtyStep),
        pricePrecision: tickToPrecision(getExchangeSpec("nonkyc").precision.priceTick),
    },
    dextrade: {
        supportsReal: true,
        displayName: getExchangeSpec("dextrade").displayName,
        minNotional: {
            USDT: getPairLimits("dextrade", "PEPEW/USDT").minNotional,
        },
        qtyPrecision: tickToPrecision(getExchangeSpec("dextrade").precision.qtyStep),
        pricePrecision: tickToPrecision(getExchangeSpec("dextrade").precision.priceTick),
    },
    nestex: {
        supportsReal: true,
        displayName: getExchangeSpec("nestex").displayName,
        minNotional: {
            USDT: getPairLimits("nestex", "PEPEW/USDT").minNotional,
        },
        qtyPrecision: tickToPrecision(getExchangeSpec("nestex").precision.qtyStep),
        pricePrecision: tickToPrecision(getExchangeSpec("nestex").precision.priceTick),
    },
};

export function supportsReal(exchange: string): boolean {
    const id = normalizeExchangeId(exchange);
    return EXCHANGE_CAPS[id].supportsReal;
}

export function supportsPaper(_exchange: string): boolean {
    return false;
}

export function getMinNotional(exchange: string, quote: string): number {
    const id = normalizeExchangeId(exchange);
    if (quote === "BNB") {
        return EXCHANGE_CAPS[id].minNotional.BNB ?? 0;
    }
    return EXCHANGE_CAPS[id].minNotional.USDT ?? 0;
}

export function getExchangeDisplayName(exchange: string): string {
    return getExchangeSpec(exchange).displayName;
}

export function isValidExchange(exchange: string): exchange is ExchangeId {
    try {
        normalizeExchangeId(exchange);
        return true;
    } catch {
        return false;
    }
}

export function getQtyPrecision(exchange: string): number {
    return EXCHANGE_CAPS[normalizeExchangeId(exchange)].qtyPrecision;
}

export function getPricePrecision(exchange: string): number {
    return EXCHANGE_CAPS[normalizeExchangeId(exchange)].pricePrecision;
}

export function roundQty(exchange: string, qty: number): number {
    const precision = getQtyPrecision(exchange);
    const factor = Math.pow(10, precision);
    return Math.floor(qty * factor) / factor;
}

export function roundPrice(exchange: string, price: number): number {
    const precision = getPricePrecision(exchange);
    const factor = Math.pow(10, precision);
    return Math.round(price * factor) / factor;
}
