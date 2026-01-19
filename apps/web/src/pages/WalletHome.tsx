import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useTranslation } from "react-i18next";
import {
  apiFetch,
  getAuthToken,
  setAuthToken,
  upsertProfile,
  getWhoami,
  sha256hex,
  setDefaultAddress as apiSetDefaultAddress,
  getDefaultAddress as apiGetDefaultAddress,
  claimPaymentRequest as apiClaimPaymentRequest,
  getApiUrl,
  API_BASE,
  API_ENDPOINTS,
  withAddress
} from "../lib/api";
import { fmtPEPEWFromSats, satsToCoin } from "../lib/format";
import { deriveFromMnemonic, generateMnemonic, validateMnemonic, PEPEPOW, pubkeyToP2PKH } from "@pepepow/wallet-core";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";
import { REFRESH_EVENT, readRefreshPayload } from "../lib/refresh";
import { getPendingSpendTotal } from "../lib/pending";
import { walletStore } from "../lib/walletStore";

type CopyStatus = "idle" | "copied" | "failed";

function maskMnemonic(value: string) {
  if (!value) return "";
  return "•".repeat(Math.min(value.length, 64));
}

function normalizeMnemonicInput(value: string) {
  if (!value) return "";
  return value.normalize("NFKD").toLowerCase().replace(/\s+/g, " ").trim();
}

function formatUsdValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsdPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(8);
}

export default function WalletHome() {
  const { t } = useTranslation();
  const [address, setAddress] = useState(localStorage.getItem("pepew_address") || "");
  const [balanceSats, setBalanceSats] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [qr, setQr] = useState<string>("");
  const [usdRate, setUsdRate] = useState<number | null>(null);
  const [usdError, setUsdError] = useState<string | null>(null);
  const [mnemo, setMnemo] = useState(localStorage.getItem("pepew_mnemonic") || "");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [amount, setAmount] = useState<string>("");
  const [memo, setMemo] = useState<string>("");
  const [payUrl, setPayUrl] = useState<string>("");
  const [payLinkError, setPayLinkError] = useState<string | null>(null);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);
  const [isDefaulting, setIsDefaulting] = useState(false);
  const [defaultStatus, setDefaultStatus] = useState<string | null>(null);
  const [defaultStatusIsError, setDefaultStatusIsError] = useState(false);
  const [needsDefaultSync, setNeedsDefaultSync] = useState(false);
  const [isDefaultConfirmed, setIsDefaultConfirmed] = useState<boolean | null>(null);
  const [debugData, setDebugData] = useState<any>(null);
  const [showDebug, setShowDebug] = useState(new URLSearchParams(window.location.search).get("debug") === "1");
  const [reopenTip, setReopenTip] = useState(false);
  const [justSavedDefault, setJustSavedDefault] = useState(false);
  const [pendingSpendSats, setPendingSpendSats] = useState(0);
  const [pendingBaselineSats, setPendingBaselineSats] = useState<number | null>(null);
  const [balanceApiRaw, setBalanceApiRaw] = useState<any>(null);
  const [utxoSumSats, setUtxoSumSats] = useState<number | null>(null);
  const [utxoSumError, setUtxoSumError] = useState<string | null>(null);
  const [balanceDebug, setBalanceDebug] = useState<any>(null);
  const [priceDebug, setPriceDebug] = useState<any>(null);
  const [walletState, setWalletState] = useState(walletStore.getState());
  const defaultPath = "m/44'/5'/0'/0/0";
  const balanceRef = useRef<number | null>(null);
  const lastRefreshRef = useRef(0);
  const isTelegram = !!(window as any).Telegram?.WebApp?.initData;
  const normalizedMnemonic = normalizeMnemonicInput(mnemo);
  const mnemonicWordCount = normalizedMnemonic ? normalizedMnemonic.split(" ").length : 0;
  const mnemonicValid = (mnemonicWordCount === 12 || mnemonicWordCount === 24)
    && validateMnemonic(normalizedMnemonic);
  const showMnemonicHint = mnemo.trim().length > 0 && !mnemonicValid;

  useEffect(() => {
    balanceRef.current = balanceSats;
  }, [balanceSats]);

  const parseNumericField = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  useEffect(() => {
    return walletStore.subscribe(setWalletState);
  }, []);

  useEffect(() => {
    walletStore.setAddress(address);
  }, [address]);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent).detail as { ts?: number } | undefined;
      if (detail?.ts && detail.ts <= lastRefreshRef.current) return;
      if (detail?.ts) lastRefreshRef.current = detail.ts;
      walletStore.scheduleRefresh();
    };
    window.addEventListener(REFRESH_EVENT, handleRefresh);
    const stored = readRefreshPayload();
    if (stored?.ts && stored.ts > lastRefreshRef.current) {
      lastRefreshRef.current = stored.ts;
      walletStore.scheduleRefresh();
    }
    return () => window.removeEventListener(REFRESH_EVENT, handleRefresh);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestId = params.get("requestId") || params.get("claim");
    if (requestId && address) {
      void handleClaim(requestId);
    }
  }, [address]);

  const handleClaim = async (requestId: string) => {
    setClaimStatus(t("claim.processing"));
    try {
      const res = await apiClaimPaymentRequest(requestId, address);
      if (res.ok) {
        setClaimStatus(t("claim.success"));
      } else {
        setClaimStatus(res.error || t("claim.failed"));
      }
    } catch {
      setClaimStatus(t("errors.networkError"));
    }
  };

  const setAsDefault = async () => {
    if (!address) return;
    if (!isTelegram) return;
    setIsDefaulting(true);
    setDefaultStatus(null);
    setDefaultStatusIsError(false);
    try {
      const res = await apiSetDefaultAddress(address);
      if (res.ok) {
        setDefaultStatus(t("home.defaultAddressSet"));
        setDefaultStatusIsError(false);
        setNeedsDefaultSync(false);
        setIsDefaultConfirmed(true);
        setJustSavedDefault(true);
        // Refresh to be sure
        void checkDefault();
      } else {
        if (res.error === "Unauthorized") {
          setDefaultStatus(t("home.defaultSyncTelegramOnly"));
          setDefaultStatusIsError(true);
        } else {
          setDefaultStatus(res.error || t("home.defaultSetFailed"));
          setDefaultStatusIsError(true);
        }
      }
    } catch {
      setDefaultStatus(t("errors.networkError"));
      setDefaultStatusIsError(true);
    } finally {
      setIsDefaulting(false);
      // F1: Rotation logic
      try {
        const up = await upsertProfile();
        if (up.token) {
          setAuthToken(up.token);
          if (showDebug) console.info("[home] token rotated after default set");
        }
      } catch (e) {
        if (showDebug) console.error("[home] failed to rotate token", e);
      }

      // Force a slight delay before checkDefault to ensure DB commit is visible
      setTimeout(() => void checkDefault(), 200);

      // UX Fallback if still not confirmed after rotation
      setTimeout(() => {
        if (!isDefaultConfirmed && (window as any).Telegram?.WebApp?.initData && justSavedDefault) {
          setReopenTip(true);
        }
        setJustSavedDefault(false);
      }, 1500);

      setTimeout(() => {
        setDefaultStatus(null);
        setDefaultStatusIsError(false);
      }, 3000);
    }
  };

  const checkDefault = async () => {
    try {
      const res = await apiGetDefaultAddress();
      if (res.ok && res.address === address) {
        setIsDefaultConfirmed(true);
        setNeedsDefaultSync(false);
      } else {
        setIsDefaultConfirmed(false);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (address && isTelegram) {
      void checkDefault();
    }

    if (showDebug) {
      void (async () => {
        try {
          const w = await getWhoami();
          const token = getAuthToken();
          const tokenHash8 = token ? (await sha256hex(token)).slice(0, 8) : "none";
          const telegramWebApp = (window as any).Telegram?.WebApp;
          setDebugData({
            API_BASE,
            tokenHash8,
            whoami: w,
            initDataLen: telegramWebApp?.initData?.length ?? 0,
            hasTelegram: !!telegramWebApp,
          });
        } catch (e) {
          setDebugData({ error: String(e) });
        }
      })();
    }
  }, [address, isDefaultConfirmed, isTelegram, showDebug]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      setUsdError(null);
      try {
        const path = API_ENDPOINTS.wallet.price;
        const r = await apiFetch(path);
        const text = await r.text().catch(() => "");
        let j: any = {};
        if (text) {
          try {
            j = JSON.parse(text);
          } catch {
            j = {};
          }
        }
        if (!active) return;
        const price = typeof j?.price === "number"
          ? j.price
          : typeof j?.price === "string"
            ? Number(j.price)
            : null;
        if (!r.ok || !Number.isFinite(price as number) || j?.error) {
          const detail = typeof j?.error === "string"
            ? j.error
            : typeof j?.detail === "string"
              ? j.detail
              : typeof j?.message === "string"
                ? j.message
                : `HTTP ${r.status}`;
          setUsdRate(null);
          // Suppress banner error in normal mode
          if (showDebug) setUsdError(detail);
          if (showDebug) {
            setPriceDebug({
              lastRequestPath: path,
              lastRequestUrl: getApiUrl(path),
              status: r.status,
              responseText200: text ? text.slice(0, 200) : "",
              error: detail
            });
          }
          return;
        }
        setUsdRate(price);
        if (showDebug) {
          setPriceDebug({
            lastRequestPath: path,
            lastRequestUrl: getApiUrl(path),
            status: r.status,
            responseText200: text ? text.slice(0, 200) : "",
            error: null
          });
        }
      } catch {
        if (active) {
          setUsdRate(null);
          setUsdError(t("home.usdNetworkError"));
          if (showDebug) {
            setPriceDebug({
              lastRequestPath: API_ENDPOINTS.wallet.price,
              lastRequestUrl: getApiUrl(API_ENDPOINTS.wallet.price),
              status: null,
              responseText200: "",
              error: t("home.usdNetworkError")
            });
          }
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [showDebug, t]);

  const displayBalanceSats = walletStore.getDisplayBalance();

  useEffect(() => {
    if (!showDebug) {
      setBalanceDebug(null);
      return;
    }
    setBalanceDebug({
      address: walletState.address,
      status: walletState.status,
      error: walletState.error,
      utxoSumSats: walletState.utxoSumSats,
      pendingSpendSats: walletState.pendingSpendSats,
      optimisticDeductionSats: walletState.optimisticDeductionSats,
      rawUtxoSumStatus: walletState.rawUtxoSumStatus,
      rawUtxoSumLastRequestUrl: walletState.rawUtxoSumLastRequestUrl,
      rawUtxoSumError: walletState.rawUtxoSumError,
      displayBalanceSats,
      displayBalanceCoin: displayBalanceSats !== null ? satsToCoin(displayBalanceSats) : null,
      fmtPEPEWFromSats: {
        input: displayBalanceSats,
        output: fmtPEPEWFromSats(displayBalanceSats)
      }
    });
  }, [displayBalanceSats, walletState, showDebug]);

  const genPayLink = async () => {
    setPayLinkError(null);
    setPayUrl("");
    try {
      const r = await apiFetch("/api/paylink/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, amount: Number(amount || 0), memo }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPayLinkError(j?.error || t("home.paylinkFailed"));
        return;
      }
      if (j.url) {
        setPayUrl(j.url);
      } else {
        setPayLinkError(t("home.paylinkFailed"));
      }
    } catch {
      setPayLinkError(t("errors.apiUnreachable"));
    }
  };

  const createWallet = async () => {
    setWalletError(null);
    try {
      const mnemonic = generateMnemonic();
      const node = await deriveFromMnemonic(mnemonic, defaultPath);
      const derived = pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW);
      setMnemo(mnemonic);
      setAddress(derived);
      setNeedsDefaultSync(true);
      localStorage.setItem("pepew_mnemonic", mnemonic);
      localStorage.setItem("pepew_address", derived);
    } catch {
      setWalletError(t("home.walletCreateFailed"));
    }
  };

  const applyMnemonic = async () => {
    const normalized = normalizeMnemonicInput(mnemo);
    const words = normalized ? normalized.split(" ").length : 0;
    if (!normalized) {
      setWalletError(t("home.mnemonicMissing"));
      return;
    }
    if ((words !== 12 && words !== 24) || !validateMnemonic(normalized)) {
      setWalletError(t("home.mnemonicInvalid"));
      return;
    }
    setWalletError(null);
    try {
      setMnemo(normalized);
      const node = await deriveFromMnemonic(normalized, defaultPath);
      const derived = pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW);
      setAddress(derived);
      setNeedsDefaultSync(true);
      localStorage.setItem("pepew_mnemonic", normalized);
      localStorage.setItem("pepew_address", derived);
    } catch {
      setWalletError(t("home.mnemonicInvalid"));
    }
  };

  const copyMnemonic = async () => {
    if (!mnemo) return;
    try {
      await navigator.clipboard.writeText(mnemo);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    } finally {
      setTimeout(() => setCopyStatus("idle"), 1600);
    }
  };

  const usdPriceLabel = formatUsdPrice(usdRate);
  const usdBalanceValue = displayBalanceSats !== null && usdRate !== null
    ? satsToCoin(displayBalanceSats) * usdRate
    : null;
  const usdBalanceLabel = usdBalanceValue !== null ? formatUsdValue(usdBalanceValue) : null;

  return (
    <AppLayout>
      <PageCard title={t("title")}>
        <div className="card">
          <div className="section-title">{t("home.localWallet")}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn" onClick={createWallet}>{t("home.createWallet")}</button>
            <button className="btn secondary" onClick={applyMnemonic} disabled={!mnemonicValid}>{t("home.useMnemonic")}</button>
            <button className="btn ghost" onClick={() => setShowMnemonic((prev) => !prev)}>
              {showMnemonic ? t("hide") : t("show")}
            </button>
            <button className="btn secondary" onClick={copyMnemonic} disabled={!mnemo}>{t("copy")}</button>
            {copyStatus === "copied" && <span className="muted">{t("copied")}</span>}
            {copyStatus === "failed" && <span className="error">{t("copyFailed")}</span>}
            {walletError && <span className="error">{walletError}</span>}
          </div>
          <textarea
            className="input"
            style={{ marginTop: 6, WebkitTextSecurity: showMnemonic ? "none" : "disc" } as React.CSSProperties}
            value={mnemo}
            onChange={(e) => setMnemo(e.target.value)}
            onBlur={() => {
              const normalized = normalizeMnemonicInput(mnemo);
              if (normalized && normalized !== mnemo) setMnemo(normalized);
            }}
            placeholder={t("home.mnemonicPlaceholder")}
          />
          {showMnemonicHint && (
            <div className="muted" style={{ marginTop: 6 }}>
              {t("home.mnemonicHint")}
            </div>
          )}
        </div>
        <div className="card">
          <label className="field-label">{t("address")}</label>
          <div className="row">
            <input
              className="input"
              placeholder="PMXw..."
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                if (e.target.value.trim()) setNeedsDefaultSync(true);
              }}
            />
            <button className="btn secondary" onClick={() => localStorage.setItem('pepew_address', address)}>{t("home.save")}</button>
            <a
              href={`https://explorer.pepepow.net/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn ghost"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              {t("viewInExplorer")}
            </a>
          </div>
          {isTelegram && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn secondary" onClick={setAsDefault} disabled={!address || isDefaulting}>
                {isDefaulting ? "..." : isDefaultConfirmed ? t("home.defaultAddressConfirmed") : t("home.setDefault")}
              </button>
              {defaultStatus && <small className={defaultStatusIsError ? "error" : "muted"}>{defaultStatus}</small>}
              {needsDefaultSync && !defaultStatus && !isDefaultConfirmed && (
                <small className="muted">{t("home.defaultSyncHint")}</small>
              )}
            </div>
          )}
          {claimStatus && <div className="muted" style={{ marginTop: 8, fontWeight: "bold" }}>{claimStatus}</div>}
        </div>

        {address && (
          <div className="grid two">
            <div className="card">
              <div className="balance-line">
                <span>{t("balance")}:</span>
                <strong>{address ? fmtPEPEWFromSats(displayBalanceSats) : "—"}</strong>
                {usdBalanceLabel && (
                  <span className="muted" style={{ marginLeft: 8 }}>
                    ≈ ${usdBalanceLabel}
                  </span>
                )}
              </div>
              {pendingSpendSats > 0 && (
                <div className="muted" style={{ marginTop: 4 }}>
                  {t("home.pendingSpend")}: {fmtPEPEWFromSats(pendingSpendSats)}
                </div>
              )}
              {showDebug && walletState.error && <div className="error" style={{ marginTop: 4 }}>{walletState.error}</div>}
              <div className="muted" style={{ marginTop: 6 }}>
                {t("home.usdLabel")}: <strong>{usdPriceLabel}</strong>{" "}
                {showDebug && usdError && (
                  <span className="error" style={{ marginLeft: 4 }}>
                    ({usdError})
                  </span>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="section-title">{t("receive")}</div>
                {qr && <img alt="qr" src={qr} className="qr" />}
              </div>
            </div>
            <div className="card">
              <div className="section-title">{t("createPayLink")}</div>
              <div className="field">
                <label className="field-label">{t("home.amountLabel")}</label>
                <input className="input" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">{t("memo")}</label>
                <input className="input" value={memo} onChange={e => setMemo(e.target.value)} />
              </div>
              <button className="btn" onClick={genPayLink}>{t("generate")}</button>
              {payLinkError && <div className="error" style={{ marginTop: 6 }}>{payLinkError}</div>}
              {payUrl && <div style={{ marginTop: 8 }}><small>{t("home.payUrlLabel")}:</small> <a href={payUrl} target="_blank" rel="noreferrer">{payUrl}</a></div>}
            </div>
          </div>
        )}

        {reopenTip && (
          <div className="card" style={{ border: '2px dashed #ffaa00', marginTop: 20 }}>
            <div style={{ color: '#ffaa00', fontWeight: 'bold' }}>
              {t("home.telegramReopenTip")}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn secondary" onClick={() => window.location.reload()}>{t("history.refresh")}</button>
              <button className="btn ghost" onClick={() => {
                navigator.clipboard.writeText(t("home.telegramReopenTip"));
              }}>{t("copy")}</button>
            </div>
          </div>
        )}

        {showDebug && debugData && (
          <div className="card muted" style={{ marginTop: 20, fontSize: '0.8em' }}>
            <div style={{ fontWeight: 'bold' }}>{t("home.debugTitle")}</div>
            {balanceDebug && (
              <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>
                {JSON.stringify({ balance: balanceDebug }, null, 2)}
              </pre>
            )}
            {priceDebug && (
              <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>
                {JSON.stringify({ price: priceDebug }, null, 2)}
              </pre>
            )}
            <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>
              {JSON.stringify(debugData, null, 2)}
            </pre>
            <button className="btn ghost" onClick={() => setShowDebug(false)}>{t("home.hideDebug")}</button>
          </div>
        )}
      </PageCard>
    </AppLayout>
  );
}
