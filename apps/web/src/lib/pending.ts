const PENDING_SPEND_KEY = "pepew_pending_spend";
const PENDING_SPEND_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_SPENDS = 10;

export type PendingSpend = {
  ts: number;
  address: string;
  sats: number;
  txid?: string;
  balanceBeforeSats?: number;
};

export function hasPendingSpendTxid(txid: string, now = Date.now()) {
  if (!txid) return false;
  const list = loadPendingSpends(now);
  return list.some((entry) => entry.txid === txid);
}

function loadPendingSpends(now = Date.now()): PendingSpend[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(PENDING_SPEND_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const filtered = parsed.filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (typeof item.ts !== "number") return false;
      if (typeof item.address !== "string") return false;
      if (typeof item.sats !== "number") return false;
      return now - item.ts <= PENDING_SPEND_TTL_MS;
    }) as PendingSpend[];
    if (filtered.length !== parsed.length) {
      localStorage.setItem(PENDING_SPEND_KEY, JSON.stringify(filtered));
    }
    return filtered;
  } catch {
    return [];
  }
}

function savePendingSpends(list: PendingSpend[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PENDING_SPEND_KEY, JSON.stringify(list));
}

export function recordPendingSpend(entry: Omit<PendingSpend, "ts"> & { ts?: number }) {
  const now = typeof entry.ts === "number" ? entry.ts : Date.now();
  if (!entry.address || !Number.isFinite(entry.sats) || entry.sats <= 0) return;
  const list = loadPendingSpends(now);
  if (entry.txid && list.some((item) => item.txid === entry.txid)) {
    return;
  }
  const next: PendingSpend[] = [
    ...list,
    {
      ts: now,
      address: entry.address,
      sats: entry.sats,
      txid: entry.txid,
      balanceBeforeSats: Number.isFinite(entry.balanceBeforeSats as number) ? entry.balanceBeforeSats : undefined,
    },
  ].slice(-MAX_PENDING_SPENDS);
  savePendingSpends(next);
}

export function getPendingSpendTotal(address: string) {
  if (!address) return { totalSats: 0, entries: [] as PendingSpend[] };
  const list = loadPendingSpends();
  const entries = list.filter((entry) => entry.address === address);
  const totalSats = entries.reduce((sum, entry) => sum + entry.sats, 0);
  const maxBalanceBeforeSats = entries.reduce((max, entry) => {
    if (!Number.isFinite(entry.balanceBeforeSats as number)) return max;
    const value = entry.balanceBeforeSats as number;
    return max === null ? value : Math.max(max, value);
  }, null as number | null);
  return { totalSats, entries, maxBalanceBeforeSats };
}
