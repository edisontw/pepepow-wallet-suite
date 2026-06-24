import { toCanonicalPair } from "./pairs.js";
import { CanonicalPair, ExchangeId, ExchangeSpec, RegistryError } from "./types.js";

const REGISTRY: Record<ExchangeId, ExchangeSpec> = {
    nonkyc: {
        exchangeId: "nonkyc",
        displayName: "NonKYC",
        adapterKey: "nonkyc",
        pairs: ["PEPEW/USDT", "PEPEW/BNB"],
        symbolMapping: {
            "PEPEW/USDT": "PEPEW_USDT",
            "PEPEW/BNB": "PEPEW_BNB",
        },
        precision: {
            priceTick: 1e-12,
            qtyStep: 1,
            priceRounding: "round",
            qtyRounding: "floor",
        },
        limits: {
            byPair: {
                "PEPEW/USDT": { minNotional: 1, minQuotePerOrder: 1 },
                "PEPEW/BNB": { minNotional: 0.0016, minQuotePerOrder: 0.0016 },
            },
        },
        balancePolicy: {
            listPaths: [["data"], []],
            fieldMapping: {
                assetKeys: ["currency", "asset", "symbol", "coin"],
                freeKeys: ["available", "free", "avail", "balance_available"],
                lockedKeys: ["locked", "freeze", "frozen", "hold"],
                totalKeys: ["total", "balance"],
            },
            assetAliases: {
                PEPEPOW: "PEPEW",
            },
        },
    },
    dextrade: {
        exchangeId: "dextrade",
        displayName: "Dex-Trade",
        adapterKey: "dextrade",
        disabled: true,
        pairs: ["PEPEW/USDT"],
        symbolMapping: {
            "PEPEW/USDT": "PEPEWUSDT",
        },
        precision: {
            priceTick: 1e-8,
            qtyStep: 1,
            priceRounding: "round",
            qtyRounding: "floor",
        },
        limits: {
            byPair: {
                "PEPEW/USDT": { minNotional: 5, minQuotePerOrder: 5 },
            },
        },
        balancePolicy: {
            listPaths: [["list"], ["data", "list"], ["data"], []],
            fieldMapping: {
                assetKeys: ["currency.iso3", "iso3", "asset", "currency", "symbol"],
                freeKeys: ["balances.available", "available", "free", "balance_available"],
                lockedKeys: ["balances.locked", "blocked", "locked", "balance_blocked"],
                totalKeys: ["balances.total", "total", "balance"],
            },
            assetAliases: {
                PEPEPOW: "PEPEW",
            },
        },
    },
    nestex: {
        exchangeId: "nestex",
        displayName: "NestEx",
        adapterKey: "nestex",
        pairs: ["PEPEW/USDT"],
        symbolMapping: {
            "PEPEW/USDT": "PEPEW_USDT",
        },
        precision: {
            priceTick: 1e-8,
            qtyStep: 1,
            priceRounding: "round",
            qtyRounding: "floor",
        },
        limits: {
            byPair: {
                "PEPEW/USDT": { minNotional: 0.0015, minQuotePerOrder: 0.0015 },
            },
        },
        balancePolicy: {
            listPaths: [["data"], ["balances"], ["data", "balances"], []],
            fieldMapping: {
                assetKeys: ["currency", "asset", "symbol", "coin", "code"],
                freeKeys: ["available", "free", "avail", "available_balance", "availableBalance"],
                lockedKeys: ["locked", "freeze", "frozen", "hold", "locked_balance", "lockedBalance"],
                totalKeys: ["balance", "total", "total_balance", "totalBalance"],
            },
            assetAliases: {
                PEPEPOW: "PEPEW",
            },
        },
    },
};

const EXCHANGE_ALIASES: Record<string, ExchangeId> = {
    nonkyc: "nonkyc",
    dextrade: "dextrade",
    "dex-trade": "dextrade",
    nestex: "nestex",
};

export function normalizeExchangeId(input: string): ExchangeId {
    const normalized = String(input || "").trim().toLowerCase();
    const found = EXCHANGE_ALIASES[normalized];
    if (!found) {
        throw new RegistryError("UNKNOWN_EXCHANGE", `UNKNOWN_EXCHANGE: ${input}`);
    }
    return found;
}

export function getExchangeSpec(exchangeId: string): ExchangeSpec {
    const normalized = normalizeExchangeId(exchangeId);
    const spec = REGISTRY[normalized];
    if (!spec) {
        throw new RegistryError("UNKNOWN_EXCHANGE", `UNKNOWN_EXCHANGE: ${exchangeId}`);
    }
    return spec;
}

export function getExchangeSymbol(exchangeId: string, canonicalPairInput: string): string {
    const spec = getExchangeSpec(exchangeId);
    const canonicalPair = toCanonicalPair(canonicalPairInput);
    const symbol = spec.symbolMapping[canonicalPair as CanonicalPair];
    if (!symbol) {
        throw new RegistryError(
            "UNSUPPORTED_PAIR",
            `UNSUPPORTED_PAIR: exchangeId=${spec.exchangeId} canonicalPair=${canonicalPair}`
        );
    }
    return symbol;
}

export function getPairLimits(exchangeId: string, canonicalPairInput: string) {
    const spec = getExchangeSpec(exchangeId);
    const canonicalPair = toCanonicalPair(canonicalPairInput);
    const limits = spec.limits.byPair[canonicalPair];
    if (!limits) {
        throw new RegistryError(
            "UNSUPPORTED_PAIR",
            `UNSUPPORTED_PAIR: exchangeId=${spec.exchangeId} canonicalPair=${canonicalPair}`
        );
    }
    return limits;
}

export function listExchangeSpecs(): ExchangeSpec[] {
    return Object.values(REGISTRY);
}
