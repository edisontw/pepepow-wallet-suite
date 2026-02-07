import { normalizeExchangeId, getExchangeSpec } from "../registry/exchanges.js";
import { parsePair } from "../registry/pairs.js";

export function logStrategyTickContract(params: {
    strategyId: number | string;
    strategyType: "MM" | "GRID" | "DCA" | "DEVMM";
    requestedExchangeId: string;
    resolvedExchangeId?: string;
    canonicalPair: string;
    exchangeSymbol: string;
    balanceTs?: number | null;
    balanceStalenessMs?: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
    guards?: string[];
}): void {
    let normalizedExchangeId = params.requestedExchangeId;
    let resolvedExchangeId = params.resolvedExchangeId || params.requestedExchangeId;
    let adapterKey = params.requestedExchangeId;
    let canonicalPair = params.canonicalPair;

    try {
        normalizedExchangeId = normalizeExchangeId(params.requestedExchangeId);
        const spec = getExchangeSpec(normalizedExchangeId);
        resolvedExchangeId = spec.exchangeId;
        adapterKey = spec.adapterKey;
    } catch {
        // keep incoming values for diagnostics
    }

    try {
        canonicalPair = parsePair(params.canonicalPair).canonicalPair;
    } catch {
        // keep incoming values for diagnostics
    }

    console.log(
        JSON.stringify({
            strategyId: String(params.strategyId),
            strategyType: params.strategyType,
            requestedExchangeId: params.requestedExchangeId,
            normalizedExchangeId,
            resolvedExchangeId,
            adapterKey,
            canonicalPair,
            exchangeSymbol: params.exchangeSymbol,
            balanceTs: params.balanceTs ?? null,
            balanceStalenessMs: params.balanceStalenessMs ?? null,
            bestBid: params.bestBid ?? null,
            bestAsk: params.bestAsk ?? null,
            guards: params.guards || [],
        })
    );
}
