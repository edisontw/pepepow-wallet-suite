import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Buffer } from "buffer";
import { deriveFromMnemonic, PEPEPOW, pubkeyToP2PKH } from "@pepepow/wallet-core";
import { apiFetch, API_ENDPOINTS, EXPLORER_BASE_URL } from "../lib/api";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

const INITIAL_HISTORY_LIMIT = 1;
const SHOW_MORE_HISTORY_LIMIT = 5;
const HISTORY_FETCH_THROTTLE_MS = 15000;

type FetchHealth = {
  status: "idle" | "ok" | "fail";
  statusCode: number | null;
  latencyMs: number | null;
};

type HistoryFetchSuccess = {
  ok: true;
  status: number;
  latencyMs: number;
  payload: any;
};

type HistoryFetchFailure = {
  ok: false;
  status: number | null;
  latencyMs: number;
  error: string;
};

type HistoryFetchResult = HistoryFetchSuccess | HistoryFetchFailure;

type CachedHistory = {
  ts: number;
  result: HistoryFetchResult;
};

type TxSummaryViewModel = {
  key: string;
  txid: string;
  timeLabel: string;
};

function parseHistoryPayload(payload: any) {
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
}

function createHistoryKey(addresses: string[], limit: number) {
  return `${limit}:${addresses.join("|")}`;
}

function parseTxTimestampMs(tx: any): number | null {
  const raw = tx?.time ?? tx?.blocktime ?? tx?.timestamp ?? tx?.ts ?? tx?.date;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) return Math.round(raw);
    if (raw > 1e9) return Math.round(raw * 1000);
    return null;
  }
  if (typeof raw === "string" && raw.trim()) {
    if (/^\d+$/.test(raw.trim())) {
      const asNum = Number(raw.trim());
      if (Number.isFinite(asNum)) {
        if (asNum > 1e12) return Math.round(asNum);
        if (asNum > 1e9) return Math.round(asNum * 1000);
      }
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatTimeLabel(tx: any): string {
  const tsMs = parseTxTimestampMs(tx);
  if (tsMs === null) return "--";
  try {
    return new Date(tsMs).toLocaleString();
  } catch {
    return "--";
  }
}

function shortTxid(txid: string): string {
  const value = String(txid || "");
  if (!value) return "--";
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export default function History() {
  const { t } = useTranslation();
  const [currentAddress] = useState(localStorage.getItem("pepew_address") || "");
  const [mnemonic] = useState(localStorage.getItem("pepew_mnemonic") || "");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(INITIAL_HISTORY_LIMIT);
  const [reloadKey, setReloadKey] = useState(0);
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);
  const [health, setHealth] = useState<FetchHealth>({ status: "idle", statusCode: null, latencyMs: null });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const historyAbortRef = useRef<AbortController | null>(null);
  const historyCacheRef = useRef<Map<string, CachedHistory>>(new Map());
  const historyInflightRef = useRef<Map<string, Promise<HistoryFetchResult>>>(new Map());
  const addressesRef = useRef<string[] | null>(null);
  const forceNextFetchRef = useRef(false);

  const resolveAddresses = async () => {
    if (addressesRef.current) return addressesRef.current;

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
      } catch (deriveError) {
        console.error("[history] Derivation failed", deriveError);
      }
    }

    if (currentAddress && !addresses.includes(currentAddress)) {
      addresses.push(currentAddress);
    }

    const unique = Array.from(new Set(addresses));
    addressesRef.current = unique;
    return unique;
  };

  const fetchHistory = async (addresses: string[], limit: number, force = false): Promise<HistoryFetchResult> => {
    const key = createHistoryKey(addresses, limit);
    const now = Date.now();

    const inFlight = historyInflightRef.current.get(key);
    if (inFlight) return inFlight;

    const cached = historyCacheRef.current.get(key);
    if (!force && cached && now - cached.ts < HISTORY_FETCH_THROTTLE_MS) {
      return cached.result;
    }

    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;

    const promise = (async (): Promise<HistoryFetchResult> => {
      const startedAt = Date.now();
      try {
        const r = await apiFetch(API_ENDPOINTS.v1.history, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses, limit }),
          signal: controller.signal,
        });

        const text = await r.text().catch(() => "");
        const latencyMs = Date.now() - startedAt;
        let json: any = {};
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = {};
          }
        }

        if (!r.ok) {
          const detail = json?.error || json?.message || `HTTP ${r.status}`;
          return {
            ok: false,
            status: r.status,
            latencyMs,
            error: detail,
          };
        }

        return {
          ok: true,
          status: r.status,
          latencyMs,
          payload: parseHistoryPayload(json),
        };
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        return {
          ok: false,
          status: null,
          latencyMs: Date.now() - startedAt,
          error: e?.message || t("errors.apiUnreachable"),
        };
      }
    })();

    historyInflightRef.current.set(key, promise);

    try {
      const result = await promise;
      historyCacheRef.current.set(key, { ts: Date.now(), result });
      return result;
    } finally {
      historyInflightRef.current.delete(key);
    }
  };

  useEffect(() => {
    let active = true;

    const run = async () => {
      if (!currentAddress) return;

      setLoading(true);
      setErr(null);
      const force = forceNextFetchRef.current;
      forceNextFetchRef.current = false;

      try {
        const addresses = await resolveAddresses();
        if (!active) return;
        if (!addresses.length) {
          setErr(t("history.emptyAddress"));
          setLoading(false);
          return;
        }

        const result = await fetchHistory(addresses, historyLimit, force);
        if (!active) return;

        if (!result.ok) {
          setErr(result.error || t("history.readFailed"));
          setHealth({ status: "fail", statusCode: result.status, latencyMs: result.latencyMs });
          return;
        }

        setData(result.payload);
        setHealth({ status: "ok", statusCode: result.status, latencyMs: result.latencyMs });
        setLastUpdatedAt(Date.now());
      } catch (e: any) {
        if (!active || e?.name === "AbortError") return;
        setErr(t("errors.apiUnreachable"));
        setHealth((prev) => ({ ...prev, status: "fail" }));
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [currentAddress, historyLimit, mnemonic, reloadKey, t]);

  const txs = useMemo(() => {
    const all = Array.isArray(data?.txs) ? data.txs : [];
    return all.slice(0, historyLimit);
  }, [data, historyLimit]);

  const txViewModels = useMemo<TxSummaryViewModel[]>(() => {
    return txs.map((tx: any, idx: number) => {
      const txid = String(tx?.txid || "");
      return {
        key: txid || `tx-${idx}`,
        txid,
        timeLabel: formatTimeLabel(tx),
      };
    });
  }, [txs]);

  const lastUpdatedLabel = lastUpdatedAt
    ? new Date(lastUpdatedAt).toLocaleTimeString()
    : "--";

  const apiHealthLabel = health.status === "ok"
    ? `${t("history.debug.apiHealthOk")} (${health.latencyMs ?? "--"} ms)`
    : health.status === "fail"
      ? `${t("history.debug.apiHealthFail")} (${health.latencyMs ?? "--"} ms)`
      : t("history.debug.apiHealthIdle");

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

  const handleRefresh = () => {
    forceNextFetchRef.current = true;
    setReloadKey((v) => v + 1);
  };

  const handleShowMore = () => {
    setHistoryLimit(SHOW_MORE_HISTORY_LIMIT);
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
            <button className="btn secondary" onClick={handleRefresh}>{t("history.refresh")}</button>
          </div>
        ) : loading ? (
          <div className="card">
            <p>{t("history.loading")}</p>
          </div>
        ) : data ? (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <div className="section-title">{t("history.title")}</div>
              <button className="btn secondary" onClick={handleRefresh}>{t("history.refresh")}</button>
            </div>

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
              <>
                <div className="tx-list">
                  {txViewModels.map((tx) => {
                    return (
                      <div key={tx.key} className="tx-row">
                        <div className="tx-info">
                          <div className="tx-line">
                            <span className="muted">{t("history.timeLabel")}: </span>
                            <span>{tx.timeLabel}</span>
                          </div>
                          <div className="tx-line">
                            <span className="muted">{t("history.txidLabel")}: </span>
                            <code title={tx.txid}>{shortTxid(tx.txid)}</code>
                          </div>
                        </div>

                        <div className="tx-actions">
                          <button className="btn ghost small" onClick={() => copyTxid(tx.txid)} disabled={!tx.txid}>
                            {copiedTxid === tx.txid ? t("copied") : t("copy")}
                          </button>
                          {tx.txid && (
                            <a
                              href={`${EXPLORER_BASE_URL}/tx/${tx.txid}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn ghost small"
                              title={t("viewInExplorer")}
                            >
                              {t("viewInExplorer")}
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {historyLimit === INITIAL_HISTORY_LIMIT && txs.length > 0 && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn secondary" onClick={handleShowMore}>
                      {t("history.showMore")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="card">
            <p>{t("history.loading")}</p>
          </div>
        )}

        {currentAddress && (
          <details className="details">
            <summary>{t("history.debugTitle")}</summary>
            <div style={{ marginTop: 8 }}><strong>{t("history.debug.summaryTitle")}</strong></div>
            <div>{t("history.debug.lastUpdatedAt")}: <strong>{lastUpdatedLabel}</strong></div>
            <div>{t("history.debug.apiHealth")}: <strong>{apiHealthLabel}</strong></div>
            {health.statusCode !== null && (
              <div>{t("history.debug.status")}: <code>{health.statusCode}</code></div>
            )}
          </details>
        )}
      </PageCard>
    </AppLayout>
  );
}
