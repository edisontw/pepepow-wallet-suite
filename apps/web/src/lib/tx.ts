import { apiFetch, API_ENDPOINTS } from "./api";
import { PepewLightApiError, pepewLightClient } from "./pepewLightClient";

type RawTxBatchSuccessItem = { txid: string; ok: true; rawTx: string; source?: "cache" | "upstream"; };
type RawTxBatchFailedItem = { txid: string; ok: false; code?: string; error?: string; requestId?: string; source?: "upstream"; };
export type RawTxBatchItem = RawTxBatchSuccessItem | RawTxBatchFailedItem;
export type RawTxBatchResponse = {
  requestId?: string;
  results: RawTxBatchItem[];
  summary?: { total?: number; ok?: number; failed?: number; cacheHit?: number; cacheMiss?: number; timingMs?: number; };
};

export class TxApiError extends Error {
  status: number;
  detail?: string;
  code?: string;
  requestId?: string;
  txid?: string;
  constructor(message: string, status: number, detail?: string, extras?: { code?: string; requestId?: string; txid?: string }) {
    super(message);
    this.name = "TxApiError";
    this.status = status;
    this.detail = detail;
    this.code = extras?.code;
    this.requestId = extras?.requestId;
    this.txid = extras?.txid;
  }
}

function mapLightTxError(error: unknown, txid?: string) {
  if (error instanceof TxApiError) return error;
  if (error instanceof PepewLightApiError) {
    return new TxApiError(error.message, error.status ?? 0, error.message, { code: error.code, txid });
  }
  const detail = error instanceof Error ? error.message : String(error || "PEPEW Light API request failed");
  return new TxApiError("PEPEW Light API transaction lookup failed", 0, detail, { code: "NETWORK_ERROR", txid });
}

function extractRawTx(payload: any): string | null {
  const data = payload?.data ?? payload?.tx ?? payload;
  if (typeof data === "string" && /^[0-9a-fA-F]+$/.test(data)) return data;
  if (data && typeof data === "object") {
    const hex = data.hex ?? data.raw ?? data.rawTx;
    if (typeof hex === "string" && /^[0-9a-fA-F]+$/.test(hex)) return hex;
  }
  return null;
}

export async function fetchRawTx(txid: string): Promise<string> {
  try {
    const payload = await pepewLightClient.getTx(txid, true);
    const rawTx = extractRawTx(payload);
    if (!rawTx) {
      throw new TxApiError("Previous transaction raw hex is not available yet.", 502, "raw transaction hex missing from PEPEW Light API response", { code: "RAW_TX_UNAVAILABLE", txid });
    }
    return rawTx;
  } catch (error) {
    throw mapLightTxError(error, txid);
  }
}

const RAW_TX_LOOKUP_CONCURRENCY = 6;

export async function fetchRawTxBatchApi(txids: string[]): Promise<RawTxBatchResponse> {
  const uniqueTxids = Array.from(new Set(txids.filter(Boolean)));
  const startedAt = Date.now();
  const results: RawTxBatchItem[] = new Array(uniqueTxids.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueTxids.length) {
      const index = nextIndex++;
      const txid = uniqueTxids[index];
      try {
        const rawTx = await fetchRawTx(txid);
        results[index] = { txid, ok: true, rawTx, source: "upstream" };
      } catch (error) {
        const mapped = mapLightTxError(error, txid);
        results[index] = { txid, ok: false, code: mapped.code, error: mapped.detail || mapped.message, source: "upstream" };
      }
    }
  }

  const workerCount = Math.min(RAW_TX_LOOKUP_CONCURRENCY, uniqueTxids.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const ok = results.filter((item) => item?.ok === true).length;
  return {
    results,
    summary: {
      total: results.length,
      ok,
      failed: results.length - ok,
      cacheHit: 0,
      cacheMiss: results.length,
      timingMs: Date.now() - startedAt,
    },
  };
}

const BROADCAST_TIMEOUT_MS = 25000;
const BROADCAST_MAX_ATTEMPTS = 2;
const BROADCAST_RETRY_BACKOFF_MS = 800;

function sleep(ms: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
}

function isMissingInputsDetail(detail?: string) {
  return /missing[-\s]?inputs|already spent/i.test(detail || "");
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
  if (isMissingInputsDetail(err.detail)) return false;
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
      const message = isMissingInputsDetail(detail)
        ? "Missing inputs: selected UTXO is already spent or not yet indexed. Refresh the wallet and try again after the pending transaction updates."
        : `broadcastTx failed: ${r.status}`;
      throw new TxApiError(message, r.status, detail, { code, requestId });
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
    if (isMissingInputsDetail(err.detail) || isMissingInputsDetail(err.message)) return false;
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
