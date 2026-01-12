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

export function fmtPEPEWFromSats(sats: SatsInput, options: FormatOptions = {}): string {
  const { decimals = 4, fallback = "--" } = options;
  if (sats === null || sats === undefined) return `${fallback} PEPEW`;
  const coin = satsToCoin(sats);
  if (!Number.isFinite(coin)) return `${fallback} PEPEW`;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(coin);
  return `${formatted} PEPEW`;
}
