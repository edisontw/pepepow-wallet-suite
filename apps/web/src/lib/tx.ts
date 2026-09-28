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

function mapLightBroadcastError(error: unknown) {
  if (error instanceof TxApiError) return error;
  if (error instanceof PepewLightApiError) {
    if (error.code === "broadcast_rejected") {
      return new TxApiError(
        "Transaction was rejected. Refresh UTXOs and recent history before trying again.",
        error.status ?? 503,
        error.code,
        { code: error.code },
      );
    }
    if (error.code === "invalid_raw_tx") {
      return new TxApiError(
        "Signed raw transaction is invalid.",
        error.status ?? 400,
        error.code,
        { code: error.code },
      );
    }
    if (error.code === "rate_limited" || error.status === 429) {
      return new TxApiError(
        "PEPEW Light API rate limit reached. Please wait before trying again.",
        error.status ?? 429,
        error.code,
        { code: error.code },
      );
    }
    if (
      error.code === "timeout"
      || error.code === "network_error"
      || error.code === "electrumx_error"
      || error.code === "api_unavailable"
      || error.code === "internal_error"
      || (typeof error.status === "number" && error.status >= 500)
    ) {
      return new TxApiError(
        "Broadcast status is uncertain. Do not retry immediately; refresh history and UTXOs first.",
        error.status ?? 0,
        error.code,
        { code: "BROADCAST_STATUS_UNCERTAIN" },
      );
    }
    return new TxApiError(error.message, error.status ?? 0, error.code, { code: error.code });
  }
  const detail = error instanceof Error ? error.message : String(error || "unknown broadcast failure");
  return new TxApiError(
    "Broadcast status is uncertain. Do not retry immediately; refresh history and UTXOs first.",
    0,
    detail,
    { code: "BROADCAST_STATUS_UNCERTAIN" },
  );
}

/**
 * Submit an already-signed transaction to PEPEW Light API exactly once.
 *
 * Do not automatically retry POST /api/wallet/broadcast. A timeout or network
 * failure can happen after the upstream accepted the transaction, so a blind
 * retry risks confusing recovery and stale-UTXO handling.
 */
export async function broadcastTx(rawTx: string): Promise<any> {
  try {
    return await pepewLightClient.broadcastSignedRawTx(rawTx);
  } catch (error) {
    throw mapLightBroadcastError(error);
  }
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
