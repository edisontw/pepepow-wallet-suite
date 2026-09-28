const DEFAULT_BASE_URL = "https://light.pepepow.net";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_READ_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 2000;

export interface LightCacheInfo {
  enabled?: boolean;
  ttl_seconds?: number;
  hit?: boolean;
  bypass?: boolean;
  [key: string]: unknown;
}

export interface LightAddressBalance {
  confirmed: number;
  unconfirmed: number;
  confirmed_pepew: string;
  unconfirmed_pepew: string;
}

export interface LightHistoryEntry {
  txid: string;
  height: number;
  is_mempool?: boolean;
  direction?: "received" | "sent" | "self" | "unknown" | string;
  amount_atoms?: number;
  amount_pepew?: string;
  address_delta_atoms?: number;
  address_delta_pepew?: string;
  received_atoms?: number;
  spent_atoms?: number;
  timestamp?: number | null;
  confirmations?: number | null;
}

export interface LightAddressResponse {
  address: string;
  balance: LightAddressBalance;
  history: LightHistoryEntry[];
  source: string;
  read_only: boolean;
  cache?: LightCacheInfo;
}

export interface LightHistoryResponse {
  address: string;
  history: LightHistoryEntry[];
  mempool: LightHistoryEntry[];
  source: string;
  read_only: boolean;
  verbose?: boolean;
  detail_limit?: number;
  cache?: LightCacheInfo;
}

export interface LightUtxo {
  txid: string;
  vout: number;
  height: number;
  value: number;
}

export interface LightUtxoResponse {
  address: string;
  utxos: LightUtxo[];
  utxo_count: number;
  total: number;
  source: string;
  read_only: boolean;
  cache?: LightCacheInfo;
}

export interface LightTxResponse {
  txid: string;
  data: unknown;
  source: string;
  read_only: boolean;
  raw?: boolean;
}

export interface LightBroadcastResponse {
  ok: boolean;
  txid?: string | null;
  source: string;
  signed_raw_tx_only: boolean;
}

export interface LightAddressOptions {
  fresh?: boolean;
  verboseHistory?: boolean;
  detailLimit?: number;
}

export interface LightHistoryOptions {
  limit?: number;
  offset?: number;
  fresh?: boolean;
  verbose?: boolean;
  detailLimit?: number;
}

export interface LightUtxoOptions {
  fresh?: boolean;
}

export type LightApiErrorCode =
  | "invalid_request"
  | "invalid_address"
  | "invalid_txid"
  | "invalid_raw_tx"
  | "timeout"
  | "rate_limited"
  | "api_unavailable"
  | "network_error"
  | "unknown_error"
  | string;

export class PepewLightApiError extends Error {
  readonly code: LightApiErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { code: LightApiErrorCode; status?: number; retryable?: boolean }) {
    super(message);
    this.name = "PepewLightApiError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = Boolean(options.retryable);
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

export interface PepewLightApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxReadRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
}

function resolveConfiguredBaseUrl() {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_PEPEW_LIGHT_API_BASE_URL || DEFAULT_BASE_URL;
}

function normalizeBaseUrl(value?: string) {
  const base = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return base || DEFAULT_BASE_URL;
}

function buildQuery(path: string, params: Record<string, string | number | boolean | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}${path.includes("?") ? "&" : "?"}${suffix}` : path;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function validateAddress(address: string) {
  const value = address.trim();
  if (!value) {
    throw new PepewLightApiError("Address is required.", { code: "invalid_address" });
  }
  return value;
}

function validateTxid(txid: string) {
  const value = txid.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new PepewLightApiError("Transaction id must be 64 hexadecimal characters.", { code: "invalid_txid" });
  }
  return value.toLowerCase();
}

function validateSignedRawTx(rawTx: string) {
  const value = rawTx.trim().replace(/^0x/i, "");
  if (!value || value.length < 20 || value.length > 200000 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new PepewLightApiError("Signed raw transaction is invalid.", { code: "invalid_raw_tx" });
  }
  return value;
}

function safeMessageForCode(code: string, status?: number) {
  if (code === "empty_address" || code === "invalid_address" || code === "invalid_address_checksum" || code === "unsupported_address_prefix") {
    return "Invalid PEPEW address.";
  }
  if (code === "invalid_txid") return "Invalid transaction id.";
  if (code === "invalid_raw_tx" || code === "invalid_broadcast_payload" || code === "raw_tx_too_short" || code === "raw_tx_too_large") {
    return "Signed raw transaction is invalid.";
  }
  if (code === "rate_limited" || status === 429) return "PEPEW Light API rate limit reached. Please retry later.";
  if (code === "broadcast_rejected") {
    return "Transaction was rejected. Refresh UTXOs and reconcile recent history before trying again.";
  }
  if (code === "electrumx_error" || code === "internal_error" || (status !== undefined && status >= 500)) {
    return "PEPEW Light API is temporarily unavailable.";
  }
  if (code === "tx_not_found") return "Transaction was not found.";
  return "PEPEW Light API request failed.";
}

async function parseApiError(res: Response) {
  let code = res.status === 429 ? "rate_limited" : res.status >= 500 ? "api_unavailable" : "unknown_error";
  try {
    const body = await res.json() as { error?: { code?: unknown } | string };
    if (typeof body?.error === "object" && body.error && typeof body.error.code === "string") {
      code = body.error.code;
    }
  } catch {
    // Return a safe, stable error below.
  }

  const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
  return new PepewLightApiError(safeMessageForCode(code, res.status), {
    code,
    status: res.status,
    retryable,
  });
}

function retryAfterMs(res: Response, fallbackMs: number) {
  const raw = res.headers.get("retry-after");
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class PepewLightApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: SleepLike;

  constructor(options: PepewLightApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? resolveConfiguredBaseUrl());
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxReadRetries = Math.max(0, Math.min(3, Math.trunc(options.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES)));
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  private async request<T>(path: string, options: RequestInit = {}, retryReads = true): Promise<T> {
    const method = String(options.method || "GET").toUpperCase();
    const canRetry = retryReads && (method === "GET" || method === "HEAD");
    const attempts = canRetry ? this.maxReadRetries + 1 : 1;
    let lastError: PepewLightApiError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
        const headers = new Headers(options.headers || {});
        if (!headers.has("Accept")) headers.set("Accept", "application/json");
        if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-cache");

        const res = await this.fetchImpl(url, {
          ...options,
          cache: "no-store",
          headers,
          signal: controller.signal,
        });

        if (res.ok) return await res.json() as T;

        const apiError = await parseApiError(res);
        lastError = apiError;
        if (!canRetry || !apiError.retryable || attempt + 1 >= attempts) throw apiError;
        await this.sleepImpl(res.status === 429 ? retryAfterMs(res, this.retryDelayMs) : this.retryDelayMs);
      } catch (error) {
        const mapped = error instanceof PepewLightApiError
          ? error
          : error instanceof Error && error.name === "AbortError"
            ? new PepewLightApiError("PEPEW Light API request timed out.", { code: "timeout", retryable: canRetry })
            : new PepewLightApiError("Unable to reach PEPEW Light API.", { code: "network_error", retryable: canRetry });
        lastError = mapped;
        if (!canRetry || !mapped.retryable || attempt + 1 >= attempts) throw mapped;
        await this.sleepImpl(this.retryDelayMs);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new PepewLightApiError("PEPEW Light API request failed.", { code: "unknown_error" });
  }

  async getAddress(address: string, options: LightAddressOptions = {}): Promise<LightAddressResponse> {
    const normalized = validateAddress(address);
    const path = buildQuery(`/api/wallet/address/${encodeURIComponent(normalized)}`, {
      fresh: options.fresh ? 1 : undefined,
      verbose_history: options.verboseHistory,
      detail_limit: options.detailLimit === undefined ? undefined : clampInteger(options.detailLimit, 0, 25, 10),
    });
    return this.request<LightAddressResponse>(path);
  }

  async getHistory(address: string, options: LightHistoryOptions = {}): Promise<LightHistoryResponse> {
    const normalized = validateAddress(address);
    const path = buildQuery(`/api/wallet/history/${encodeURIComponent(normalized)}`, {
      limit: options.limit === undefined ? undefined : clampInteger(options.limit, 1, 500, 50),
      offset: options.offset === undefined ? undefined : clampInteger(options.offset, 0, 1_000_000_000, 0),
      fresh: options.fresh ? 1 : undefined,
      verbose: options.verbose,
      detail_limit: options.detailLimit === undefined ? undefined : clampInteger(options.detailLimit, 0, 25, 10),
    });
    return this.request<LightHistoryResponse>(path);
  }

  async getUtxo(address: string, options: LightUtxoOptions = {}): Promise<LightUtxoResponse> {
    const normalized = validateAddress(address);
    const path = buildQuery(`/api/wallet/utxo/${encodeURIComponent(normalized)}`, {
      fresh: options.fresh ? 1 : undefined,
    });
    return this.request<LightUtxoResponse>(path);
  }

  async getTx(txid: string, raw = false): Promise<LightTxResponse> {
    const normalized = validateTxid(txid);
    const path = buildQuery(`/api/wallet/tx/${normalized}`, { raw: raw ? 1 : undefined });
    return this.request<LightTxResponse>(path);
  }

  async broadcastSignedRawTx(rawTx: string): Promise<LightBroadcastResponse> {
    const normalized = validateSignedRawTx(rawTx);
    return this.request<LightBroadcastResponse>(
      "/api/wallet/broadcast",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_tx: normalized }),
      },
      false,
    );
  }
}

export const pepewLightClient = new PepewLightApiClient();
