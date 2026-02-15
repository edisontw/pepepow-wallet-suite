import { apiFetch, API_ENDPOINTS, withTxid } from "./api";

type ErrorLikePayload = {
  error?: string;
  message?: string;
  code?: string;
  requestId?: string;
};

type RawTxBatchSuccessItem = {
  txid: string;
  ok: true;
  rawTx: string;
  source?: "cache" | "upstream";
};

type RawTxBatchFailedItem = {
  txid: string;
  ok: false;
  code?: string;
  error?: string;
  requestId?: string;
  source?: "upstream";
};

export type RawTxBatchItem = RawTxBatchSuccessItem | RawTxBatchFailedItem;

export type RawTxBatchResponse = {
  requestId?: string;
  results: RawTxBatchItem[];
  summary?: {
    total?: number;
    ok?: number;
    failed?: number;
    cacheHit?: number;
    cacheMiss?: number;
    timingMs?: number;
  };
};

export class TxApiError extends Error {
  status: number;
  detail?: string;
  code?: string;
  requestId?: string;
  txid?: string;

  constructor(
    message: string,
    status: number,
    detail?: string,
    extras?: { code?: string; requestId?: string; txid?: string }
  ) {
    super(message);
    this.name = "TxApiError";
    this.status = status;
    this.detail = detail;
    this.code = extras?.code;
    this.requestId = extras?.requestId;
    this.txid = extras?.txid;
  }
}

function parseErrorPayload(raw: string): ErrorLikePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ErrorLikePayload;
  } catch {
    return null;
  }
}

export async function fetchRawTx(txid: string): Promise<string> {
  const r = await apiFetch(withTxid(API_ENDPOINTS.wallet.txRaw, txid), {
    headers: {
      Accept: "text/plain",
    },
  });
  const text = await r.text();
  if (!r.ok) {
    const payload = parseErrorPayload(text);
    const detail = payload?.error || payload?.message || text || undefined;
    const requestId = r.headers.get("x-request-id") || payload?.requestId || undefined;
    const code = payload?.code || undefined;
    throw new TxApiError(`fetchRawTx failed: ${r.status}`, r.status, detail, { requestId, code, txid });
  }
  return text;
}

export async function fetchRawTxBatchApi(txids: string[]): Promise<RawTxBatchResponse> {
  const r = await apiFetch(API_ENDPOINTS.wallet.txRawBatch, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txids }),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = typeof payload?.error === "string" ? payload.error : `HTTP ${r.status}`;
    const code = typeof payload?.code === "string" ? payload.code : undefined;
    const requestId = r.headers.get("x-request-id")
      || (typeof payload?.requestId === "string" ? payload.requestId : undefined);
    throw new TxApiError(`fetchRawTxBatchApi failed: ${r.status}`, r.status, detail, { code, requestId });
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  return {
    requestId: typeof payload?.requestId === "string" ? payload.requestId : (r.headers.get("x-request-id") || undefined),
    results,
    summary: payload?.summary,
  };
}

export async function broadcastTx(rawTx: string): Promise<any> {
  const r = await apiFetch(API_ENDPOINTS.wallet.txBroadcast, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawTx }),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = typeof payload?.message === "string"
      ? payload.message
      : typeof payload?.error === "string"
        ? payload.error
        : undefined;
    const code = typeof payload?.code === "string" ? payload.code : undefined;
    const requestId = r.headers.get("x-request-id")
      || (typeof payload?.requestId === "string" ? payload.requestId : undefined);
    throw new TxApiError(`broadcastTx failed: ${r.status}`, r.status, detail, { code, requestId });
  }
  return payload;
}

export function isTransientRawTxError(err: unknown) {
  if (err instanceof TxApiError) {
    if (err.status === 504) return true;
    if (err.code === "UPSTREAM_TIMEOUT" || err.code === "RPC_TIMEOUT" || err.code === "INDEXER_TIMEOUT") return true;
    if ((err.detail || "").toLowerCase().includes("timeout")) return true;
    return false;
  }
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: string; message?: string };
  if (maybe.name === "AbortError") return true;
  return typeof maybe.message === "string" && /network|timeout|failed to fetch/i.test(maybe.message);
}
