import { apiFetch } from "./api";

export class TxApiError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "TxApiError";
    this.status = status;
    this.detail = detail;
  }
}

export async function fetchRawTx(txid: string): Promise<string> {
  const r = await apiFetch(`/wallet/tx/raw?txid=${encodeURIComponent(txid)}`);
  const text = await r.text();
  if (!r.ok) {
    throw new TxApiError(`fetchRawTx failed: ${r.status}`, r.status, text || undefined);
  }
  return text;
}

export async function fetchTxInfo(txid: string): Promise<any> {
  const r = await apiFetch(`/v1/tx/${encodeURIComponent(txid)}`);
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = typeof payload?.error === "string" ? payload.error : undefined;
    throw new TxApiError(`fetchTxInfo failed: ${r.status}`, r.status, detail);
  }
  return payload;
}

export async function broadcastTx(rawTx: string): Promise<any> {
  const r = await apiFetch("/wallet/tx/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawTx }),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = typeof payload?.error === "string" ? payload.error : undefined;
    throw new TxApiError(`broadcastTx failed: ${r.status}`, r.status, detail);
  }
  return payload;
}
