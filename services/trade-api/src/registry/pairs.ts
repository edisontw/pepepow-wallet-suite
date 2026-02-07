import { CanonicalPair, ParsedPair, RegistryError } from "./types.js";

const SUPPORTED_PAIRS = new Set<CanonicalPair>(["PEPEW/USDT", "PEPEW/BNB"]);

function normalizePairInput(input: string): string {
    return input.trim().toUpperCase().replace(/_/g, "/").replace(/\s+/g, "");
}

export function parsePair(input: string): ParsedPair {
    const normalized = normalizePairInput(input);
    if (!normalized.includes("/")) {
        if (normalized.endsWith("USDT")) {
            return parsePair(`${normalized.slice(0, -4)}/USDT`);
        }
        if (normalized.endsWith("BNB")) {
            return parsePair(`${normalized.slice(0, -3)}/BNB`);
        }
        throw new RegistryError("INVALID_PAIR", `INVALID_PAIR: ${input}`);
    }

    const parts = normalized.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new RegistryError("INVALID_PAIR", `INVALID_PAIR: ${input}`);
    }

    const [base, quote] = parts;
    if (base !== "PEPEW") {
        throw new RegistryError("INVALID_PAIR", `INVALID_PAIR: unsupported base ${base}`);
    }
    if (quote !== "USDT" && quote !== "BNB") {
        throw new RegistryError("INVALID_PAIR", `INVALID_PAIR: unsupported quote ${quote}`);
    }

    const canonicalPair = `${base}/${quote}` as CanonicalPair;
    if (!SUPPORTED_PAIRS.has(canonicalPair)) {
        throw new RegistryError("UNSUPPORTED_PAIR", `UNSUPPORTED_PAIR: ${canonicalPair}`);
    }

    return {
        baseAsset: "PEPEW",
        quoteAsset: quote,
        canonicalPair,
    };
}

export function toCanonicalPair(input: string): CanonicalPair {
    return parsePair(input).canonicalPair;
}
