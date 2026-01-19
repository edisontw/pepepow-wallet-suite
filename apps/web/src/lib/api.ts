const AUTH_TOKEN_KEY = "pepew_api_token";

export const API_BASE =
  import.meta.env.VITE_API_BASE ?? "https://api.pepepow.net";

export const API_ENDPOINTS = {
  wallet: {
    healthz: "/wallet/healthz",
    balance: "/wallet/balance",
    utxos: "/wallet/utxos",
    history: "/wallet/history",
    feeEstimate: "/wallet/fee/estimate",
    price: "/wallet/price",
    txRaw: "/wallet/tx/raw",
    txBroadcast: "/wallet/tx/broadcast",
  },
  v1: {
    whoami: "/v1/whoami",
    profileUpsert: "/v1/profile/upsert",
    addressDefault: "/v1/address/default",
    history: "/v1/history",
    resolve: (params: URLSearchParams) => `/v1/resolve?${params.toString()}`,
    requests: "/v1/requests",
    request: (id: string) => `/v1/requests/${id}`,
    requestClaim: (id: string) => `/v1/requests/${id}/claim`,
    txInfo: (txid: string) => `/v1/tx/${encodeURIComponent(txid)}`,
  }
} as const;

export function joinUrl(base: string, path: string) {
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const baseTrimmed = base.replace(/\/+$/, "");
  const pathTrimmed = path.startsWith("/") ? path : `/${path}`;
  return `${baseTrimmed}${pathTrimmed}`;
}

export function withQuery(path: string, params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    search.append(key, String(value));
  });
  const query = search.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

export function withAddress(path: string, address: string) {
  return withQuery(path, { address });
}

export function withTxid(path: string, txid: string) {
  return withQuery(path, { txid });
}

export function getApiUrl(path: string) {
  return joinUrl(API_BASE, path);
}

export function getAuthToken() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function apiFetch(path: string, options: RequestInit & { signal?: AbortSignal } = {}) {
  const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const url = getApiUrl(path);
  if (debug) {
    const kid = token ? token.split('.')[1]?.slice(0, 10) : 'none';
    console.info(`[api] fetch: ${path}, token_kid=${kid}`, options);
  }
  const res = await fetch(url, { ...options, headers });
  if (debug) {
    console.info(`[api] response: ${path}, status=${res.status}`);
  }
  return res;
}

export async function getWhoami() {
  const res = await apiFetch(API_ENDPOINTS.v1.whoami);
  return res.json();
}

export async function sha256hex(text: string) {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function upsertProfile(username?: string) {
  const res = await apiFetch(API_ENDPOINTS.v1.profileUpsert, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  return res.json();
}

export async function getDefaultAddress() {
  const res = await apiFetch(API_ENDPOINTS.v1.addressDefault);
  return res.json();
}

export async function setDefaultAddress(address: string, label?: string) {
  const res = await apiFetch(API_ENDPOINTS.v1.addressDefault, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, label }),
  });
  return res.json();
}

export async function resolveUser(query: { toTgUserId?: string; username?: string }) {
  const params = new URLSearchParams();
  if (query.toTgUserId) params.append("toTgUserId", query.toTgUserId);
  if (query.username) params.append("username", query.username);
  const res = await apiFetch(API_ENDPOINTS.v1.resolve(params));
  return res.json();
}

export async function createPaymentRequest(data: {
  toTgUserId: string;
  toUsername?: string;
  amountSats?: number;
  memo?: string;
}) {
  const res = await apiFetch(API_ENDPOINTS.v1.requests, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function claimPaymentRequest(id: string, address: string) {
  const res = await apiFetch(API_ENDPOINTS.v1.requestClaim(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  return res.json();
}

export async function getPaymentRequest(id: string) {
  const res = await apiFetch(API_ENDPOINTS.v1.request(id));
  return res.json();
}
