// (Pending check of wallet.ts)
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Buffer } from "buffer";
import { deriveFromMnemonic, PEPEPOW, pubkeyToP2PKH } from "@pepepow/wallet-core";
import { apiFetch, API_BASE, API_ENDPOINTS, getApiUrl, withAddress } from "../lib/api";
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

function shortTxid(txid: string) {
  if (!txid) return "";
  return `${txid.slice(0, 8)}...${txid.slice(-6)}`;
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

  // Derive addresses (memoized or inside effect)
  useEffect(() => {
    let active = true;
    const run = async () => {
      // If we have a mnemonic, derive first 20 external + 20 internal
      // If only address (watch only), use just that.
      const addresses: string[] = [];
      if (mnemonic) {
        try {
          // External (Receive) 0-19
          for (let i = 0; i < 20; i++) {
            const node = await deriveFromMnemonic(mnemonic, `m/44'/5'/0'/0/${i}`);
            addresses.push(pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW));
          }
          // Internal (Change) 0-19
          for (let i = 0; i < 20; i++) {
            const node = await deriveFromMnemonic(mnemonic, `m/44'/5'/0'/1/${i}`);
            addresses.push(pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW));
          }
        } catch (e) {
          console.error("Derivation failed", e);
        }
      }

      // Fallback or addition: always include the current saved address if not already in list
      if (currentAddress && !addresses.includes(currentAddress)) {
        addresses.push(currentAddress);
      }

      if (!addresses.length) return;

      setErr(null);
      setData(null);
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

      // Fetch History
      try {
        const path = API_ENDPOINTS.v1.history;
        const url = getApiUrl(path);
        setHistoryDebug({
          ...makeEmptyDebug(),
          lastRequestPath: path,
          lastRequestUrl: url,
        });
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
        setHistoryDebug((prev) => ({
          ...prev,
          status: r.status,
          responseText200: text ? text.slice(0, 200) : "",
        }));
        if (!r.ok) {
          const detail = r.status === 404
            ? t("errors.apiNotFound")
            : json?.error || json?.message || `HTTP ${r.status}`;
          setHistoryDebug((prev) => ({
            ...prev,
            errorName: r.status === 404 ? "NotFoundError" : "HttpError",
            errorMessage: detail,
          }));
          setErr(detail || t("history.readFailed"));
        } else {
          setHistoryDebug((prev) => ({
            ...prev,
            errorName: null,
            errorMessage: null,
          }));
          const payload = parseHistoryPayload(json);
          setData(payload);
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

      // Fetch UTXOs
      setUtxoError(null);
      try {
        const utxoRequests = addresses.map((addr) => ({
          addr,
          path: withAddress(API_ENDPOINTS.wallet.utxos, addr),
          url: getApiUrl(withAddress(API_ENDPOINTS.wallet.utxos, addr))
        }));
        if (utxoRequests.length) {
          const last = utxoRequests[utxoRequests.length - 1];
          setUtxosDebug({
            ...makeEmptyDebug(),
            lastRequestPath: last.path,
            lastRequestUrl: last.url,
          });
        }
        utxoAbortRef.current?.abort();
        const utxoController = new AbortController();
        utxoAbortRef.current = utxoController;
        const utxoResponses = await Promise.all(utxoRequests.map(async (req) => {
          const r = await apiFetch(req.path, { signal: utxoController.signal });
          const { text, json } = await readResponse(r);
          return { ...req, r, text, json };
        }));
        if (!active) return;

        const failed = utxoResponses.find((res) => !res.r.ok);
        if (failed) {
          setUtxosDebug((prev) => ({
            ...prev,
            lastRequestUrl: failed.url,
            lastRequestPath: failed.path,
            status: failed.r.status,
            responseText200: failed.text ? failed.text.slice(0, 200) : "",
            errorName: failed.r.status === 404 ? "NotFoundError" : "HttpError",
            errorMessage: failed.json?.error || failed.json?.message || `HTTP ${failed.r.status}`,
          }));
          const detail = failed.r.status === 404
            ? t("errors.apiNotFound")
            : failed.json?.error || failed.json?.message || `HTTP ${failed.r.status}`;
          setUtxoError(detail);
          setUtxos([]);
          return;
        }

        const last = utxoResponses[utxoResponses.length - 1];
        if (last) {
          setUtxosDebug((prev) => ({
            ...prev,
            status: last.r.status,
            responseText200: last.text ? last.text.slice(0, 200) : "",
            errorName: null,
            errorMessage: null,
          }));
        }

        const allUtxos = utxoResponses.flatMap((res) =>
          Array.isArray(res.json) ? res.json : Array.isArray(res.json?.utxos) ? res.json.utxos : []
        );
        const mapped = allUtxos.map((u: any) => ({
          txid: u.txid || u.txId || u.tx,
          // Handle 'satoshis' (from getaddressutxos) or 'amount' (coins)
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
      } catch (e: any) {
        if (active) {
          setUtxos([]);
          setUtxoError(t("errors.apiUnreachable"));
          setUtxosDebug((prev) => ({
            ...prev,
            errorName: e?.name || "Error",
            errorMessage: e?.message || String(e),
          }));
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [currentAddress, mnemonic, refreshKey, t]);

  const txs = Array.isArray(data?.txs) ? data.txs.slice(0, 5) : null;

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
                      <div className="tx-amount" style={{ fontWeight: 'bold' }}>
                        {tx.netAmount !== undefined && tx.netAmount !== null ? (
                          <span style={{ color: tx.netAmount > 0 ? '#4caf50' : tx.netAmount < 0 ? '#f44336' : 'inherit' }}>
                            {tx.netAmount > 0 ? '+' : tx.netAmount < 0 ? '-' : ''}{fmtPEPEWFromSats(Math.abs(tx.netAmount))}
                          </span>
                        ) : '--'}
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
          <details className="details">
            <summary>{t("history.utxosTitle")}</summary>
            {utxoError && <div className="error" style={{ marginTop: 8 }}>{utxoError}</div>}
            {!utxos.length ? (
              <div className="muted" style={{ marginTop: 8 }}>{t("history.utxosEmpty")}</div>
            ) : (
              <div className="utxo-list">
                {utxos.map((u) => (
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
