import { useEffect, useState } from "react";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { buildAndSignP2PKH, selectUtxos, wifFromMnemonic, PEPEPOW } from "@pepepow/wallet-core";
import { apiFetch, getApiUrl } from "../lib/api";
import { broadcastTx, fetchRawTx, TxApiError } from "../lib/tx";
import { fmtPEPEWFromSats, satsToCoin } from "../lib/format";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

type U = { txid: string; vout: number; amount: number; };

const DEFAULT_PATH = "m/44'/5'/0'/0/0";
const COIN_MULTIPLIER = 100000000n;
const MIN_SEND_SATS = 100000000;
const FEE_FALLBACK = "0.0001";
const RECENT_RECIPIENTS_KEY = "pepew_recentRecipients";
const MAX_RECENT_RECIPIENTS = 6;

function parseCoinToSats(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, frac = ""] = normalized.split(".");
  if (frac.length > 8) return null;
  const padded = (frac + "00000000").slice(0, 8);
  try {
    const sats = BigInt(whole) * COIN_MULTIPLIER + BigInt(padded);
    const asNumber = Number(sats);
    if (!Number.isSafeInteger(asNumber)) return null;
    return asNumber;
  } catch {
    return null;
  }
}

function formatSatsInput(sats: number) {
  if (!Number.isFinite(sats) || sats <= 0) return "0";
  const coin = satsToCoin(sats);
  const fixed = coin.toFixed(8);
  return fixed.replace(/\.?0+$/, "");
}

function loadRecentRecipients() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_RECIPIENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

export default function Send() {
  const { t } = useTranslation();
  const [address, setAddress] = useState(localStorage.getItem("pepew_address") || "");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [subtractFee, setSubtractFee] = useState(false);
  const [mnemo] = useState(localStorage.getItem("pepew_mnemonic") || "");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [utxos, setUtxos] = useState<U[]>([]);
  const [utxoError, setUtxoError] = useState<string | null>(null);
  const [feeEstimate, setFeeEstimate] = useState<string | null>(null);
  const [feeEstimateSource, setFeeEstimateSource] = useState<string | null>(null);
  const [feeEstimateError, setFeeEstimateError] = useState<string | null>(null);
  const [feeNotice, setFeeNotice] = useState<string | null>(null);
  const [feeTouched, setFeeTouched] = useState(false);
  const [recentRecipients, setRecentRecipients] = useState<string[]>(loadRecentRecipients());

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(RECENT_RECIPIENTS_KEY, JSON.stringify(recentRecipients));
  }, [recentRecipients]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!address) return;
      setUtxoError(null);
      const path = `/wallet/utxos?address=${encodeURIComponent(address)}`;
      const url = getApiUrl(path);
      console.info("[send] utxos request", { address, url });
      try {
        const r = await apiFetch(path);
        const data = await r.json().catch(() => null);
        if (!active) return;
        console.info("[send] utxos response", {
          status: r.status,
          statusText: r.statusText,
          error: data?.error,
        });
        if (!r.ok) {
          setUtxos([]);
          const statusLabel = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`;
          const detail = typeof data?.error === "string"
            ? data.error
            : typeof data?.message === "string"
              ? data.message
              : typeof data === "string"
                ? data
                : statusLabel;
          setUtxoError(`${t("send.errors.utxoApiError")}: ${detail}`);
          return;
        }
        const rawUtxos = Array.isArray(data) ? data : Array.isArray(data?.utxos) ? data.utxos : [];
        const mapped = rawUtxos.map((u: any) => ({
          txid: u.txid || u.txId || u.tx,
          vout: Number(u.vout ?? u.n ?? u.outputIndex ?? u.output_index),
          amount: Number(u.satoshis ?? u.amount ?? u.value),
        })).filter((u: any) =>
          u.txid && Number.isFinite(u.vout) && Number.isFinite(u.amount)
        );
        const availableSats = mapped.reduce((sum: number, u: U) => sum + Number(u.amount || 0), 0);
        const availableCoins = availableSats / 1e8;
        console.info("[send] utxos parsed", { count: mapped.length, availableSats, availableCoins });
        setUtxos(mapped);
      } catch (err) {
        if (active) {
          console.warn("[send] utxos fetch failed", err);
          setUtxos([]);
          setUtxoError(t("errors.apiUnreachable"));
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [address, t]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      setFeeEstimateError(null);
      setFeeNotice(null);
      try {
        const r = await apiFetch("/wallet/fee/estimate");
        const j = await r.json().catch(() => ({}));
        if (!active) return;
        if (!r.ok) {
          setFeeEstimate(FEE_FALLBACK);
          setFeeEstimateSource("fallback");
          if (!feeTouched) setFee(FEE_FALLBACK);
          setFeeEstimateError(j?.error || t("send.errors.feeEstimateFailed"));
          setFeeNotice(t("send.feeFallbackNotice", { fee: FEE_FALLBACK }));
          return;
        }
        const rawEstimate = j?.feerate ?? j?.feeRate;
        const estimateNumber = typeof rawEstimate === "number" ? rawEstimate : Number(rawEstimate);
        if (!Number.isFinite(estimateNumber) || estimateNumber <= 0) {
          setFeeEstimate(FEE_FALLBACK);
          setFeeEstimateSource("fallback");
          if (!feeTouched) setFee(FEE_FALLBACK);
          setFeeEstimateError(t("send.errors.feeEstimateFailed"));
          setFeeNotice(t("send.feeFallbackNotice", { fee: FEE_FALLBACK }));
          return;
        }
        const estimate = String(estimateNumber);
        setFeeEstimate(estimate);
        setFeeEstimateSource(j?.source || null);
        if (!feeTouched) setFee(estimate);
      } catch {
        if (active) {
          setFeeEstimate(FEE_FALLBACK);
          setFeeEstimateSource("fallback");
          if (!feeTouched) setFee(FEE_FALLBACK);
          setFeeEstimateError(t("errors.apiUnreachable"));
          setFeeNotice(t("send.feeFallbackNotice", { fee: FEE_FALLBACK }));
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [feeTouched, t]);

  const addRecentRecipient = (addr: string) => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    setRecentRecipients((prev) => {
      const next = [trimmed, ...prev.filter((item) => item !== trimmed)];
      return next.slice(0, MAX_RECENT_RECIPIENTS);
    });
  };

  const removeRecentRecipient = (addr: string) => {
    setRecentRecipients((prev) => prev.filter((item) => item !== addr));
  };

  const availableSats = utxos.reduce((sum, u) => sum + Number(u.amount || 0), 0);
  const amountSats = parseCoinToSats(amount);
  const feeSats = parseCoinToSats(fee);
  const amountValid = amountSats !== null;
  const feeValid = feeSats !== null && feeSats >= 0;
  const recipientSats = amountValid && feeValid
    ? subtractFee
      ? amountSats - feeSats
      : amountSats
    : null;
  const totalSats = amountValid && feeValid
    ? subtractFee
      ? amountSats
      : amountSats + feeSats
    : null;
  const overBalance = totalSats !== null && totalSats > availableSats;
  const invalidRecipient = recipientSats !== null && recipientSats <= 0;

  const balanceLabel = fmtPEPEWFromSats(address ? availableSats : null);
  const feeLabel = feeValid ? fmtPEPEWFromSats(feeSats) : fmtPEPEWFromSats(null);
  const totalLabel = totalSats !== null ? fmtPEPEWFromSats(totalSats) : fmtPEPEWFromSats(null);
  const receiveLabel = recipientSats !== null ? fmtPEPEWFromSats(recipientSats) : fmtPEPEWFromSats(null);
  const feeEstimateLabel = feeEstimate ? `${feeEstimate} PEPEW` : "--";

  const handleMax = () => {
    const feeForMax = feeValid ? feeSats : 0;
    const maxSats = Math.max(availableSats - feeForMax, 0);
    setAmount(formatSatsInput(maxSats));
  };

  async function doSend() {
    try {
      setSending(true);
      setErr(null);
      setResult(null);
      const trimmedMnemonic = mnemo.trim();
      if (!trimmedMnemonic) {
        setErr(t("send.errors.mnemonicMissing"));
        return;
      }
      const amountSats = parseCoinToSats(amount);
      if (amountSats === null) {
        setErr(t("send.errors.amountInvalid"));
        return;
      }
      const feeSats = parseCoinToSats(fee);
      if (feeSats === null || feeSats < 0) {
        setErr(t("send.errors.feeInvalid"));
        return;
      }
      const recipientSats = subtractFee ? amountSats - feeSats : amountSats;
      if (recipientSats <= 0) {
        setErr(t("send.errors.amountUnderFee"));
        return;
      }
      if (recipientSats < MIN_SEND_SATS) {
        setErr(t("send.errors.amountTooLow", { min: 1 }));
        return;
      }
      const totalSats = subtractFee ? amountSats : amountSats + feeSats;
      const availableSats = utxos.reduce((sum, u) => sum + Number(u.amount || 0), 0);
      if (totalSats > availableSats) {
        setErr(t("send.errors.insufficientBalance"));
        return;
      }
      const wif = await wifFromMnemonic(trimmedMnemonic, DEFAULT_PATH, PEPEPOW);
      const target = totalSats;
      const chosen = utxos.map(u => ({ txid: u.txid, vout: u.vout, value: Number(u.amount) }));
      const { picked } = selectUtxos(chosen as any, target);
      if (!picked?.length) {
        setErr(t("send.errors.insufficientUtxo"));
        return;
      }

      const inputs = [];
      for (const u of picked) {
        try {
          const hex = await fetchRawTx(u.txid);
          inputs.push({ ...u, nonWitnessUtxo: Buffer.from(hex, "hex") });
        } catch (e: any) {
          if (e instanceof TxApiError && e.status === 404) {
            setErr(t("send.errors.txRawNotFound", { txid: u.txid }));
          } else if (e instanceof TxApiError && e.detail) {
            setErr(`${t("send.errors.txRawFailed", { txid: u.txid })}: ${e.detail}`);
          } else {
            setErr(t("send.errors.txRawFailed", { txid: u.txid }));
          }
          return;
        }
      }

      const raw = buildAndSignP2PKH({
        network: PEPEPOW,
        utxos: inputs as any,
        wif,
        to,
        amount: recipientSats,
        changeAddress: address,
        fee: feeSats
      });

      try {
        const j = await broadcastTx(raw);
        setResult(j.result || j.txid || JSON.stringify(j));
        addRecentRecipient(to);
      } catch (e: any) {
        if (e instanceof TxApiError && e.detail) {
          setErr(e.detail);
        } else {
          setErr(t("send.errors.broadcastFailed"));
        }
        return;
      }
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setSending(false);
    }
  }

  return (
    <AppLayout>
      <PageCard title={t("send.title")}>
        <div className="card">
          <label className="field-label">{t("send.yourAddress")}</label>
          <div className="row">
            <input className="input" value={address} onChange={e => setAddress(e.target.value)} placeholder="PMXw..." />
            <button className="btn secondary" onClick={() => localStorage.setItem('pepew_address', address)}>{t("send.saveAddress")}</button>
          </div>
        </div>

        <div className="card">
          <div className="grid two">
            <div>
              <label className="field-label">{t("send.toLabel")}</label>
              <input
                className="input"
                value={to}
                onChange={e => setTo(e.target.value)}
                placeholder="P..."
                autoComplete="off"
              />
              <div style={{ marginTop: 10 }}>
                <div className="muted">{t("send.recentRecipients")}</div>
                {recentRecipients.length ? (
                  <div className="chip-row">
                    {recentRecipients.map((addr) => (
                      <span key={addr} className="chip">
                        <button onClick={() => setTo(addr)} className="chip-btn">{addr}</button>
                        <button onClick={() => removeRecentRecipient(addr)} className="chip-close">x</button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 6 }}>
                    {t("send.noRecentRecipients")}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="field-label">{t("send.amountLabel")}</label>
              <div className="row">
                <input
                  className="input"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="1.0"
                  inputMode="decimal"
                />
                <button className="btn ghost" onClick={handleMax}>{t("send.max")}</button>
              </div>
              <label className="field-label" style={{ marginTop: 10 }}>{t("send.feeLabel")}</label>
              <input
                className="input"
                value={fee}
                onChange={(e) => { setFee(e.target.value); setFeeTouched(true); }}
                placeholder={FEE_FALLBACK}
                inputMode="decimal"
              />
              <label className="checkbox-row" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={subtractFee}
                  onChange={(e) => setSubtractFee(e.target.checked)}
                />
                <span>{t("send.subtractFee")}</span>
              </label>
            </div>
          </div>
          <div className="note" style={{ marginTop: 10 }}>
            <div>{t("send.feeEstimate")} {feeEstimateLabel}</div>
            {feeEstimateSource && <div>{t("send.sourceLabel")}: {feeEstimateSource}</div>}
            {feeEstimateError && <div className="error">{feeEstimateError}</div>}
            {feeNotice && <div className="muted">{feeNotice}</div>}
            {utxoError && <div className="error">{utxoError}</div>}
          </div>
        </div>

        <div className="card">
          <div className="summary-grid">
            <div>
              <div className="muted">{t("balance")}</div>
              <div className="summary-value">{balanceLabel}</div>
            </div>
            <div>
              <div className="muted">{t("send.feeSummary")}</div>
              <div className="summary-value">{feeLabel}</div>
            </div>
            <div>
              <div className="muted">{t("send.recipientReceives")}</div>
              <div className="summary-value">{receiveLabel}</div>
            </div>
            <div>
              <div className="muted">{t("send.totalCost")}</div>
              <div className="summary-value">{totalLabel}</div>
            </div>
          </div>
          {invalidRecipient && <div className="error" style={{ marginTop: 8 }}>{t("send.errors.amountUnderFee")}</div>}
          {overBalance && <div className="error" style={{ marginTop: 8 }}>{t("send.errors.insufficientBalance")}</div>}
        </div>

        <div className="card">
          <div className="row">
            <button className="btn" disabled={sending || overBalance || invalidRecipient} onClick={doSend}>
              {sending ? t("send.sending") : "SEND"}
            </button>
          </div>
          {err && <p className="error">{err}</p>}
          {result && <p>✅ {t("send.broadcasted")}: <code>{result}</code></p>}

          <div className="muted" style={{ marginTop: 12, fontSize: "0.85em" }}>
            {t("send.pathLabel")}: <code>{DEFAULT_PATH}</code>
          </div>
        </div>
      </PageCard>
    </AppLayout>
  );
}
