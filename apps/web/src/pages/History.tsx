// (Pending check of wallet.ts)
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Buffer } from "buffer";
import { deriveFromMnemonic, PEPEPOW, pubkeyToP2PKH } from "@pepepow/wallet-core";
import { apiFetch, API_BASE } from "../lib/api";
import { fmtPEPEWFromSats } from "../lib/format";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

type Utxo = {
  txid: string;
  amount: number;
  confirmations?: number | null;
  vout?: number | null;
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

      // Fetch History
      try {
        const r = await apiFetch("/v1/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses, limit: 50 })
        });
        const j = await r.json().catch(() => ({}));
        if (!active) return;

        if (!r.ok) {
          // If 404 (endpoint missing), try fallback to old single address method?
          // But we are updating backend too, so assume it works.
          const detail = j?.error || j?.message || `HTTP ${r.status}`;
          setErr(detail || t("history.readFailed"));
        } else {
          const normalized = Array.isArray(j)
            ? { txs: j }
            : j && typeof j === "object"
              ? { ...j, txs: Array.isArray(j.txs) ? j.txs : [] }
              : { txs: [] };
          setData(normalized);
        }
      } catch {
        if (active) setErr(t("errors.apiUnreachable"));
      } finally {
        if (active) setLoading(false);
      }

      // Fetch UTXOs
      setUtxoError(null);
      try {
        const r = await apiFetch("/v1/utxos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses })
        });
        const j = await r.json().catch(() => ({}));
        if (!active) return;

        if (!r.ok) {
          const detail = j?.error || j?.message || `HTTP ${r.status}`;
          setUtxoError(detail);
          setUtxos([]);
          return;
        }

        const rawUtxos = Array.isArray(j) ? j : Array.isArray(j?.utxos) ? j.utxos : [];
        const mapped = rawUtxos.map((u: any) => ({
          txid: u.txid || u.txId || u.tx,
          // Handle 'satoshis' (from getaddressutxos) or 'amount' (coins)
          amount: u.satoshis ?? (u.amount ? Math.round(Number(u.amount) * 1e8) : 0),
          confirmations: typeof u.confirmations === "number" ? u.confirmations : null,
          vout: Number.isFinite(Number(u.vout ?? u.n ?? u.outputIndex ?? u.output_index))
            ? Number(u.vout ?? u.n ?? u.outputIndex ?? u.output_index)
            : null,
        })).filter((u: any) => u.txid && Number.isFinite(u.amount));
        setUtxos(mapped);
      } catch {
        if (active) {
          setUtxos([]);
          setUtxoError(t("errors.apiUnreachable"));
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [currentAddress, mnemonic, refreshKey, t]);

  const txs = Array.isArray(data?.txs) ? data.txs : null;

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
                      <code>{shortTxid(tx.txid)}</code>
                      <span className="muted">{t("history.confirmations")}: {tx.confirmations ?? "--"}</span>
                      <button className="btn ghost small" onClick={() => copyTxid(tx.txid)}>
                        {copiedTxid === tx.txid ? t("copied") : t("copy")}
                      </button>
                      <a
                        href={`https://explorer.pepepow.net/tx/${tx.txid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn ghost small"
                        title="View in Explorer"
                      >
                        🔍
                      </a>
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
                        title="View in Explorer"
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
            {err && <div>{t("history.errorLabel")}: {err}</div>}
          </details>
        )}
      </PageCard>
    </AppLayout>
  );
}
