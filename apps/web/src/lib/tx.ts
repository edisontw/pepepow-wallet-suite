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

const BROADCAST_TIMEOUT_MS = 25000;
const BROADCAST_MAX_ATTEMPTS = 2;
const BROADCAST_RETRY_BACKOFF_MS = 800;

function sleep(ms: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
}

function normalizeFetchError(err: unknown, timedOut: boolean, attempt: number) {
  if (err instanceof TxApiError) return err;
  const rawMessage = err instanceof Error ? err.message : String(err || "");
  const isDomAbort = typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError";
  const isAbort = isDomAbort || (err instanceof Error && err.name === "AbortError");
  const detail = timedOut || isAbort
    ? `broadcast request timed out after ${BROADCAST_TIMEOUT_MS}ms`
    : rawMessage || "network request failed";
  const code = timedOut || isAbort ? "BROADCAST_TIMEOUT" : "NETWORK_ERROR";
  const message = timedOut || isAbort
    ? "Broadcast request timed out. The transaction may still have reached the node; retrying the same transaction is safe."
    : "Network error while broadcasting transaction. Please retry; duplicate raw transactions are safely deduplicated by the node/API.";
  return new TxApiError(message, timedOut || isAbort ? 504 : 0, detail, { code: `${code}_ATTEMPT_${attempt}` });
}

function shouldRetryBroadcastError(err: TxApiError) {
  const code = err.code || "";
  if (code === "UPSTREAM_BUSY" || err.status === 429) return false;
  if (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504) return true;
  return code.includes("TIMEOUT")
    || code.includes("NETWORK")
    || code === "RPC_UNAVAILABLE"
    || code === "UPSTREAM_ERROR";
}

async function broadcastFetchOnce(rawTx: string, attempt: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BROADCAST_TIMEOUT_MS);

  try {
    const r = await apiFetch(API_ENDPOINTS.wallet.txBroadcast, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawTx }),
      signal: controller.signal,
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
  } catch (err) {
    throw normalizeFetchError(err, timedOut, attempt);
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export async function broadcastTx(rawTx: string): Promise<any> {
  let lastError: TxApiError | null = null;
  for (let attempt = 1; attempt <= BROADCAST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await broadcastFetchOnce(rawTx, attempt);
    } catch (err) {
      const txErr = normalizeFetchError(err, false, attempt);
      lastError = txErr;
      const canRetry = attempt < BROADCAST_MAX_ATTEMPTS && shouldRetryBroadcastError(txErr);
      if (!canRetry) throw txErr;
      await sleep(BROADCAST_RETRY_BACKOFF_MS);
    }
  }
  throw lastError || new TxApiError("broadcastTx failed", 0, "unknown broadcast failure", { code: "BROADCAST_UNKNOWN" });
}

export function isTransientRawTxError(err: unknown) {
  if (err instanceof TxApiError) {
    if (err.status === 0 || err.status === 504) return true;
    if (err.code === "UPSTREAM_TIMEOUT"
      || err.code === "RPC_TIMEOUT"
      || err.code === "INDEXER_TIMEOUT"
      || err.code?.includes("NETWORK")
      || err.code?.includes("TIMEOUT")) return true;
    if ((err.detail || "").toLowerCase().includes("timeout")) return true;
    return false;
  }
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: string; message?: string };
  if (maybe.name === "AbortError") return true;
  return typeof maybe.message === "string" && /network|timeout|failed to fetch/i.test(maybe.message);
}
