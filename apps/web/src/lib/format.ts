import { formatAtomicToPepew, PEPEW_DECIMALS } from "./amount";
import { assertAtomic } from "./atomic";

const SATS_PER_COIN = 100000000;

type SatsInput = number | bigint | string | null | undefined;

type FormatOptions = {
  decimals?: number;
  fallback?: string;
};

export function satsToCoin(sats: SatsInput): number {
  if (sats === null || sats === undefined) return 0;
  const value = typeof sats === "bigint" ? Number(sats) : typeof sats === "string" ? Number(sats) : sats;
  if (!Number.isFinite(value)) return 0;
  return value / SATS_PER_COIN;
}

function normalizeSatsToAtomic(sats: SatsInput): bigint | null {
  if (sats === null || sats === undefined) return null;
  if (typeof sats === "bigint") return sats >= 0n ? sats : null;
  if (typeof sats === "number") {
    if (!Number.isFinite(sats) || !Number.isInteger(sats) || sats < 0) return null;
    return BigInt(sats);
  }
  if (typeof sats === "string") {
    try {
      return assertAtomic(sats, "sats");
    } catch {
      return null;
    }
  }
  return null;
}

export function fmtPEPEWFromSats(sats: SatsInput, options: FormatOptions = {}): string {
  const { decimals = 4, fallback = "--" } = options;
  if (sats === null || sats === undefined) return `${fallback} PEPEW`;
  const atomic = normalizeSatsToAtomic(sats);
  if (atomic === null) return `${fallback} PEPEW`;
  const formatted = formatAtomicToPepew(atomic, PEPEW_DECIMALS, {
    group: true,
    trimTrailingZeros: false,
    minFractionDigits: decimals,
    maxFractionDigits: decimals,
  });
  return `${formatted} PEPEW`;
}
