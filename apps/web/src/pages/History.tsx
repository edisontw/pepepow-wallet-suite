import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Buffer } from "buffer";
import { deriveFromMnemonic, PEPEPOW, pubkeyToP2PKH } from "@pepepow/wallet-core";
import { apiFetch, API_BASE, API_ENDPOINTS, getApiUrl, withAddress, withQuery } from "../lib/api";
import { fmtPEPEWFromSats } from "../lib/format";
import { REFRESH_EVENT, readRefreshPayload } from "../lib/refresh";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

type Utxo = {
  txid: string;
  amount: number;
  confirmations?: number | null;
  vout?: number | null;
};

type FetchDebug = {
  lastRequestPath: string | null;
  lastRequestUrl: string | null;
  status: number | null;
  responseText200: string | null;
  errorName: string | null;
  errorMessage: string | null;
};

const UTXO_ADV_PAGE_SIZE = 50;
const UTXO_SUMMARY_CONCURRENCY = 6;
const UTXO_ADV_CONCURRENCY = 4;

function shortTxid(txid: string) {
  if (!txid) return "";
  return `${txid.slice(0, 8)}...${txid.slice(-6)}`;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
) {
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      await worker(items[current]);
    }
  });
  await Promise.all(workers);
}

export default function History() {
  const { t } = useTranslation();
  const [currentAddress] = useState(localStorage.getItem("pepew_address") || "");
  const [mnemonic] = useState(localStorage.getItem("pepew_mnemonic") || "");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [utxos, setUtxos] = useState<Utxo[]>([]);
  const [utxoError, setUtxoError] = useState<string | null>(null);
  const [utxoCount, setUtxoCount] = useState<number | null>(null);
  const [showAdvancedUtxos, setShowAdvancedUtxos] = useState(false);
  const [visibleUtxoCount, setVisibleUtxoCount] = useState(UTXO_ADV_PAGE_SIZE);
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);

  const makeEmptyDebug = (): FetchDebug => ({
    lastRequestPath: null,
    lastRequestUrl: null,
    status: null,
    responseText200: null,
    errorName: null,
    errorMessage: null,
  });
  const [historyDebug, setHistoryDebug] = useState<FetchDebug>(() => makeEmptyDebug());
  const [utxosDebug, setUtxosDebug] = useState<FetchDebug>(() => makeEmptyDebug());
  const historyAbortRef = useRef<AbortController | null>(null);
  const utxoAbortRef = useRef<AbortController | null>(null);
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent).detail as { ts?: number } | undefined;
      if (detail?.ts && detail.ts <= lastRefreshRef.current) return;
      if (detail?.ts) lastRefreshRef.current = detail.ts;
      setRefreshKey((v) => v + 1);
    };
    window.addEventListener(REFRESH_EVENT, handleRefresh);
    const stored = readRefreshPayload();
    if (stored?.ts && stored.ts > lastRefreshRef.current) {
      lastRefreshRef.current = stored.ts;
      setRefreshKey((v) => v + 1);
    }
    return () => window.removeEventListener(REFRESH_EVENT, handleRefresh);
  }, []);

  useEffect(() => {
    if (showAdvancedUtxos) {
      setVisibleUtxoCount(UTXO_ADV_PAGE_SIZE);
    }
  }, [showAdvancedUtxos, refreshKey]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      const addresses: string[] = [];
      if (mnemonic) {
        try {
          for (let i = 0; i < 20; i++) {
            const node = await deriveFromMnemonic(mnemonic, `m/44'/5'/0'/0/${i}`);
            addresses.push(pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW));
          }
          for (let i = 0; i < 20; i++) {
            const node = await deriveFromMnemonic(mnemonic, `m/44'/5'/0'/1/${i}`);
            addresses.push(pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW));
          }
        } catch (e) {
          console.error("Derivation failed", e);
        }
      }

      if (currentAddress && !addresses.includes(currentAddress)) {
        addresses.push(currentAddress);
      }
      if (!addresses.length) return;

      setErr(null);
      setUtxoError(null);
      setData(null);
      setUtxoCount(null);
      if (!showAdvancedUtxos) {
        setUtxos([]);
      }
      setLoading(true);

      const parseHistoryPayload = (payload: any) => {
        if (Array.isArray(payload)) return { txs: payload };
        if (payload && typeof payload === "object") {
          const txs = Array.isArray(payload.txs)
            ? payload.txs
            : Array.isArray(payload.transactions)
              ? payload.transactions
              : [];
          return { ...payload, txs };
        }
        return { txs: [] };
      };

      const readResponse = async (r: Response) => {
        const text = await r.text().catch(() => "");
        let json: any = {};
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = {};
          }
        }
        return { text, json };
      };

      try {
        const path = API_ENDPOINTS.v1.history;
        const url = getApiUrl(path);
        setHistoryDebug({ ...makeEmptyDebug(), lastRequestPath: path, lastRequestUrl: url });
        historyAbortRef.current?.abort();
        const controller = new AbortController();
        historyAbortRef.current = controller;

        const r = await apiFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses, limit: 5 }),
          signal: controller.signal,
        });
        const { text, json } = await readResponse(r);
        if (!active) return;

        setHistoryDebug((prev) => ({ ...prev, status: r.status, responseText200: text ? text.slice(0, 200) : "" }));
        if (!r.ok) {
          const detail = r.status === 404 ? t("errors.apiNotFound") : json?.error || json?.message || `HTTP ${r.status}`;
          setHistoryDebug((prev) => ({
            ...prev,
            errorName: r.status === 404 ? "NotFoundError" : "HttpError",
            errorMessage: detail,
          }));
          setErr(detail || t("history.readFailed"));
        } else {
          setHistoryDebug((prev) => ({ ...prev, errorName: null, errorMessage: null }));
          setData(parseHistoryPayload(json));
        }
      } catch (e: any) {
        if (active) {
          setHistoryDebug((prev) => ({
            ...prev,
            errorName: e?.name || "Error",
            errorMessage: e?.message || String(e),
          }));
          setErr(t("errors.apiUnreachable"));
        }
      } finally {
        if (active) setLoading(false);
      }

      const summaryRequests = addresses.map((addr) => {
        const summaryPath = withQuery(withAddress(API_ENDPOINTS.wallet.utxos, addr), { summary: 1 });
        return {
          address: addr,
          summaryPath,
          summaryUrl: getApiUrl(summaryPath),
          fullPath: withAddress(API_ENDPOINTS.wallet.utxos, addr),
        };
      });

      utxoAbortRef.current?.abort();
      const utxoController = new AbortController();
      utxoAbortRef.current = utxoController;

      let countTotal = 0;
      let countFailed: string | null = null;
      await runWithConcurrency(summaryRequests, UTXO_SUMMARY_CONCURRENCY, async (req) => {
        if (countFailed) return;
        try {
          setUtxosDebug((prev) => ({ ...prev, lastRequestPath: req.summaryPath, lastRequestUrl: req.summaryUrl }));
          const summaryRes = await apiFetch(req.summaryPath, { signal: utxoController.signal });
          const summaryPayload = await summaryRes.json().catch(() => ({}));
          if (!summaryRes.ok) {
            const fallbackPath = req.fullPath;
            const fallbackRes = await apiFetch(fallbackPath, { signal: utxoController.signal });
            const fallbackPayload = await fallbackRes.json().catch(() => ({}));
            if (!fallbackRes.ok) {
              countFailed = summaryPayload?.error || fallbackPayload?.error || `HTTP ${summaryRes.status}`;
              setUtxosDebug((prev) => ({
                ...prev,
                status: fallbackRes.status,
                errorName: "HttpError",
                errorMessage: countFailed,
              }));
              return;
            }
            const arr = Array.isArray(fallbackPayload) ? fallbackPayload : Array.isArray(fallbackPayload?.utxos) ? fallbackPayload.utxos : [];
            countTotal += arr.length;
            return;
          }

          const count = Number(summaryPayload?.count);
          if (!Number.isFinite(count) || count < 0) {
            const fallbackPath = req.fullPath;
            const fallbackRes = await apiFetch(fallbackPath, { signal: utxoController.signal });
            const fallbackPayload = await fallbackRes.json().catch(() => ({}));
            if (!fallbackRes.ok) {
              countFailed = fallbackPayload?.error || `HTTP ${fallbackRes.status}`;
              return;
            }
            const arr = Array.isArray(fallbackPayload) ? fallbackPayload : Array.isArray(fallbackPayload?.utxos) ? fallbackPayload.utxos : [];
            countTotal += arr.length;
            return;
          }
          countTotal += count;
          setUtxosDebug((prev) => ({ ...prev, status: summaryRes.status, errorName: null, errorMessage: null }));
        } catch (e: any) {
          if (e?.name === "AbortError") return;
          countFailed = e?.message || String(e);
          setUtxosDebug((prev) => ({
            ...prev,
            errorName: e?.name || "Error",
            errorMessage: countFailed,
          }));
        }
      });

      if (!active) return;
      if (countFailed) {
        setUtxoError(countFailed);
        setUtxoCount(null);
      } else {
        setUtxoCount(countTotal);
      }

      if (!showAdvancedUtxos) {
        setUtxos([]);
        return;
      }

      const fullRequests = addresses.map((addr) => {
        const path = withAddress(API_ENDPOINTS.wallet.utxos, addr);
        return { path, url: getApiUrl(path) };
      });

      const utxoResponses: Array<{ path: string; url: string; ok: boolean; status: number; text: string; json: any }> = [];
      await runWithConcurrency(fullRequests, UTXO_ADV_CONCURRENCY, async (req) => {
        const r = await apiFetch(req.path, { signal: utxoController.signal });
        const text = await r.text().catch(() => "");
        let json: any = {};
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = {};
          }
        }
        utxoResponses.push({ ...req, ok: r.ok, status: r.status, text, json });
      });
      if (!active) return;

      const failed = utxoResponses.find((res) => !res.ok);
      if (failed) {
        const detail = failed.status === 404 ? t("errors.apiNotFound") : failed.json?.error || failed.json?.message || `HTTP ${failed.status}`;
        setUtxoError(detail);
        setUtxos([]);
        setUtxosDebug((prev) => ({
          ...prev,
          lastRequestPath: failed.path,
          lastRequestUrl: failed.url,
          status: failed.status,
          responseText200: failed.text ? failed.text.slice(0, 200) : "",
          errorName: failed.status === 404 ? "NotFoundError" : "HttpError",
          errorMessage: detail,
        }));
        return;
      }

      const allUtxos = utxoResponses.flatMap((res) =>
        Array.isArray(res.json) ? res.json : Array.isArray(res.json?.utxos) ? res.json.utxos : []
      );
      const mapped = allUtxos.map((u: any) => ({
        txid: u.txid || u.txId || u.tx,
        amount: u.satoshis ?? (u.amount ? Math.round(Number(u.amount) * 1e8) : 0),
        confirmations: typeof u.confirmations === "number" ? u.confirmations : null,
        vout: Number.isFinite(Number(u.vout ?? u.n ?? u.outputIndex ?? u.output_index))
          ? Number(u.vout ?? u.n ?? u.outputIndex ?? u.output_index)
          : null,
      })).filter((u: any) => u.txid && Number.isFinite(u.amount));

      const byOutpoint = new Map<string, Utxo>();
      mapped.forEach((u) => {
        const key = `${u.txid}:${u.vout ?? "n/a"}`;
        if (!byOutpoint.has(key)) byOutpoint.set(key, u);
      });
      setUtxos(Array.from(byOutpoint.values()));
      setUtxosDebug((prev) => ({
        ...prev,
        status: 200,
        errorName: null,
        errorMessage: null,
      }));
    };

    void run();
    return () => {
      active = false;
    };
  }, [currentAddress, mnemonic, refreshKey, showAdvancedUtxos, t]);

  const txs = Array.isArray(data?.txs) ? data.txs.slice(0, 5) : null;
  const visibleUtxos = utxos.slice(0, visibleUtxoCount);

  const copyTxid = async (txid: string) => {
    if (!txid) return;
    try {
      await navigator.clipboard.writeText(txid);
      setCopiedTxid(txid);
      setTimeout(() => setCopiedTxid(null), 1400);
    } catch {
      setCopiedTxid(null);
    }
  };

  return (
    <AppLayout>
      <PageCard title={t("history.title")}>
        {!currentAddress ? (
          <div className="card">
            <p>{t("history.emptyAddress")}</p>
          </div>
        ) : err ? (
          <div className="card">
            <p className="error">{t("history.readFailed")}: {err}</p>
            <button className="btn secondary" onClick={() => setRefreshKey((v) => v + 1)}>{t("history.refresh")}</button>
          </div>
        ) : loading ? (
          <div className="card">
            <p>{t("history.loading")}</p>
          </div>
        ) : data ? (
          txs ? (
            <div className="card">
              {data?.error && <div className="muted" style={{ marginBottom: 8 }}>{data.error}</div>}
              {!txs.length ? (
                <div>
                  <p>{t("history.emptyTxs")}</p>
                  <div className="row">
                    <Link className="btn" to="/">{t("history.goReceive")}</Link>
                    <Link className="btn secondary" to="/send">{t("history.goSend")}</Link>
                  </div>
                </div>
              ) : (
                <div className="tx-list">
                  {txs.map((tx: any) => (
                    <div key={tx.txid} className="tx-row">
                      <div className="tx-info">
                        <code>{shortTxid(tx.txid)}</code>
                        <span className="muted">{t("history.confirmations")}: {tx.confirmations ?? "--"}</span>
                      </div>
                      <div className="tx-amount" style={{ fontWeight: "bold" }}>
                        {tx.netAmount !== undefined && tx.netAmount !== null ? (
                          <span style={{ color: tx.netAmount > 0 ? "#4caf50" : tx.netAmount < 0 ? "#f44336" : "inherit" }}>
                            {tx.netAmount > 0 ? "+" : tx.netAmount < 0 ? "-" : ""}{fmtPEPEWFromSats(Math.abs(tx.netAmount))}
                          </span>
                        ) : "--"}
                      </div>
                      <div className="tx-actions">
                        <button className="btn ghost small" onClick={() => copyTxid(tx.txid)}>
                          {copiedTxid === tx.txid ? t("copied") : t("copy")}
                        </button>
                        <a
                          href={`https://explorer.pepepow.net/tx/${tx.txid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn ghost small"
                          title={t("viewInExplorer")}
                        >
                          🔍
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(data, null, 2)}</pre>
          )
        ) : (
          <div className="card">
            <p>{t("history.loading")}</p>
          </div>
        )}

        {currentAddress && (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="muted">{t("history.utxoCountLabel")}</div>
                <div className="summary-value">
                  {utxoCount === null ? "--" : utxoCount}
                </div>
              </div>
              <button
                className="btn secondary"
                onClick={() => setShowAdvancedUtxos((v) => !v)}
              >
                {showAdvancedUtxos ? t("history.hideAdvancedUtxos") : t("history.showAdvancedUtxos")}
              </button>
            </div>
            {utxoError && <div className="error" style={{ marginTop: 8 }}>{utxoError}</div>}
          </div>
        )}

        {currentAddress && showAdvancedUtxos && (
          <details className="details" open>
            <summary>{t("history.utxosTitle")}</summary>
            {utxoError && <div className="error" style={{ marginTop: 8 }}>{utxoError}</div>}
            {!utxos.length ? (
              <div className="muted" style={{ marginTop: 8 }}>{t("history.utxosEmpty")}</div>
            ) : (
              <>
                <div className="utxo-list">
                  {visibleUtxos.map((u) => (
                    <div key={`${u.txid}-${u.vout ?? u.amount}`} className="utxo-row">
                      <div>
                        <div className="summary-value">{fmtPEPEWFromSats(u.amount)}</div>
                        <div className="muted">{t("history.confirmations")}: {u.confirmations ?? 0}</div>
                      </div>
                      <div className="utxo-actions">
                        <code>{shortTxid(u.txid)}</code>
                        <button className="btn ghost small" onClick={() => copyTxid(u.txid)}>
                          {copiedTxid === u.txid ? t("copied") : t("copy")}
                        </button>
                        <a
                          href={`https://explorer.pepepow.net/tx/${u.txid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn ghost small"
                          title={t("viewInExplorer")}
                        >
                          🔍
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
                {utxos.length > visibleUtxoCount && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn secondary"
                      onClick={() => setVisibleUtxoCount((v) => v + UTXO_ADV_PAGE_SIZE)}
                    >
                      {t("history.loadMoreUtxos")}
                    </button>
                  </div>
                )}
              </>
            )}
          </details>
        )}

        {currentAddress && (
          <details className="details">
            <summary>{t("history.debugTitle")}</summary>
            <div>{t("api.base")}: <code>{API_BASE}</code></div>
            <div style={{ marginTop: 8 }}><strong>{t("history.debug.historyLabel")}</strong></div>
            {historyDebug.lastRequestPath && (
              <div>{t("history.debug.lastRequestPath")}: <code>{historyDebug.lastRequestPath}</code></div>
            )}
            {historyDebug.lastRequestUrl && (
              <div>{t("history.debug.lastRequestUrl")}: <code>{historyDebug.lastRequestUrl}</code></div>
            )}
            {historyDebug.status !== null && (
              <div>{t("history.debug.status")}: <code>{historyDebug.status}</code></div>
            )}
            {historyDebug.responseText200 && (
              <div>{t("history.debug.responseSnippet")}: <code>{historyDebug.responseText200}</code></div>
            )}
            {(historyDebug.errorName || historyDebug.errorMessage) && (
              <div>{t("history.debug.error")}: <code>{historyDebug.errorName || t("errors.generic")}</code> {historyDebug.errorMessage || ""}</div>
            )}

            <div style={{ marginTop: 8 }}><strong>{t("history.debug.utxosLabel")}</strong></div>
            {utxosDebug.lastRequestPath && (
              <div>{t("history.debug.lastRequestPath")}: <code>{utxosDebug.lastRequestPath}</code></div>
            )}
            {utxosDebug.lastRequestUrl && (
              <div>{t("history.debug.lastRequestUrl")}: <code>{utxosDebug.lastRequestUrl}</code></div>
            )}
            {utxosDebug.status !== null && (
              <div>{t("history.debug.status")}: <code>{utxosDebug.status}</code></div>
            )}
            {utxosDebug.responseText200 && (
              <div>{t("history.debug.responseSnippet")}: <code>{utxosDebug.responseText200}</code></div>
            )}
            {(utxosDebug.errorName || utxosDebug.errorMessage) && (
              <div>{t("history.debug.error")}: <code>{utxosDebug.errorName || t("errors.generic")}</code> {utxosDebug.errorMessage || ""}</div>
            )}
            {err && <div>{t("history.errorLabel")}: {err}</div>}
          </details>
        )}
      </PageCard>
    </AppLayout>
  );
}
