export type ExchangeId = "nonkyc" | "dextrade" | "nestex";

export type CanonicalPair = "PEPEW/USDT" | "PEPEW/BNB";

export type AssetCode = "USDT" | "BNB" | "PEPEW";

export type BalanceFieldMapping = {
    assetKeys: string[];
    freeKeys: string[];
    lockedKeys: string[];
    totalKeys: string[];
};

export type BalancePolicy = {
    listPaths: string[][];
    fieldMapping: BalanceFieldMapping;
    assetAliases?: Record<string, AssetCode>;
};

export type PrecisionPolicy = {
    priceTick: number;
    qtyStep: number;
    priceRounding: "round" | "floor";
    qtyRounding: "floor";
};

export type PairLimits = {
    minNotional: number;
    minQuotePerOrder: number;
};

export type LimitsPolicy = {
    byPair: Partial<Record<CanonicalPair, PairLimits>>;
};

export type ExchangeSpec = {
    exchangeId: ExchangeId;
    displayName: string;
    adapterKey: ExchangeId;
    pairs: CanonicalPair[];
    symbolMapping: Partial<Record<CanonicalPair, string>>;
    precision: PrecisionPolicy;
    limits: LimitsPolicy;
    balancePolicy: BalancePolicy;
    disabled?: boolean;
};

export type ParsedPair = {
    baseAsset: AssetCode;
    quoteAsset: Extract<AssetCode, "USDT" | "BNB">;
    canonicalPair: CanonicalPair;
};

export type BalanceAsset = {
    free: number;
    locked: number;
    total: number;
};

export type BalanceSnapshot = {
    exchangeId: ExchangeId;
    ts: number;
    stalenessMs: number;
    source: "live" | "cached";
    rawHash: string;
    assets: Record<AssetCode, BalanceAsset>;
};

export type RegistryErrorCode =
    | "UNKNOWN_EXCHANGE"
    | "INVALID_PAIR"
    | "UNSUPPORTED_PAIR"
    | "BALANCE_PARSE_FAILED";

export class RegistryError extends Error {
    code: RegistryErrorCode;

    constructor(code: RegistryErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "RegistryError";
    }
}
