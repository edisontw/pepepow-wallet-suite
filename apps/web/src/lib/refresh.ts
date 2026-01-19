export const REFRESH_EVENT = "pepew-refresh";
export const REFRESH_KEY = "pepew_refresh";

export type RefreshPayload = {
  ts: number;
  reason?: string;
  txid?: string;
};

export function triggerRefresh(payload: Omit<RefreshPayload, "ts"> = {}) {
  const data: RefreshPayload = { ts: Date.now(), ...payload };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(REFRESH_KEY, JSON.stringify(data));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: data }));
  }
  return data;
}

export function readRefreshPayload(): RefreshPayload | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(REFRESH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
