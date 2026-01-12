import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";
import { fmtPEPEWFromSats } from "../lib/format";
import { normalizeLang } from "../i18n";
import { deriveFromMnemonic, generateMnemonic, PEPEPOW, pubkeyToP2PKH } from "@pepepow/wallet-core";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

type CopyStatus = "idle" | "copied" | "failed";

function maskMnemonic(value: string) {
  if (!value) return "";
  return "•".repeat(Math.min(value.length, 64));
}

export default function WalletHome() {
  const { t, i18n } = useTranslation();
  const currentLang = normalizeLang(i18n.language);
  const nextLang = currentLang === "en" ? "zh-TW" : "en";
  const langLabel = currentLang === "en" ? t("lang.zh") : t("lang.en");
  const [address, setAddress] = useState(localStorage.getItem("pepew_address") || "");
  const [balanceSats, setBalanceSats] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [qr, setQr] = useState<string>("");
  const [usdRate, setUsdRate] = useState<string>("—");
  const [usdError, setUsdError] = useState<string | null>(null);
  const [mnemo, setMnemo] = useState(localStorage.getItem("pepew_mnemonic") || "");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [amount, setAmount] = useState<string>("");
  const [memo, setMemo] = useState<string>("");
  const [payUrl, setPayUrl] = useState<string>("");
  const [payLinkError, setPayLinkError] = useState<string | null>(null);
  const defaultPath = "m/44'/5'/0'/0/0";

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!address) {
        if (active) {
          setBalanceSats(null);
          setBalanceError(null);
          setQr("");
        }
        return;
      }
      setBalanceError(null);
      try {
        const r = await apiFetch(`/wallet/balance?address=${encodeURIComponent(address)}`);
        const j = await r.json().catch(() => ({}));
        if (!active) return;
        if (!r.ok) {
          setBalanceError(j?.error || t("home.balanceFailed"));
        } else {
          // If backend returns balanceSat (integer), use it directly.
          // Otherwise try 'balance' (coins) * 1e8, but prefer explicit sats field.
          const sat = typeof j.balanceSat === "number"
            ? j.balanceSat
            : typeof j.balance === "number"
              ? Math.round(j.balance * 1e8)
              : Number(j?.balance ?? 0) * 1e8; // fallback

          setBalanceSats(Number.isFinite(sat) ? sat : null);
        }
      } catch {
        if (active) {
          setBalanceSats(null);
          setBalanceError(t("errors.apiUnreachable"));
        }
      }

      try {
        const dataUrl = await QRCode.toDataURL(address);
        if (active) setQr(dataUrl);
      } catch {
        if (active) setQr("");
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [address]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      setUsdError(null);
      try {
        const r = await apiFetch("/wallet/price");
        const j = await r.json().catch(() => ({}));
        if (!active) return;
        const price = typeof j?.price === "number" ? j.price : Number(j?.price);
        if (!r.ok || !Number.isFinite(price)) {
          const detail = typeof j?.error === "string"
            ? j.error
            : typeof j?.detail === "string"
              ? j.detail
              : `HTTP ${r.status}`;
          setUsdRate("—");
          setUsdError(detail);
          return;
        }
        setUsdRate(String(price));
      } catch {
        if (active) {
          setUsdRate("—");
          setUsdError(t("home.usdNetworkError"));
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, []);

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
      localStorage.setItem("pepew_mnemonic", mnemonic);
      localStorage.setItem("pepew_address", derived);
    } catch {
      setWalletError(t("home.walletCreateFailed"));
    }
  };

  const applyMnemonic = async () => {
    const trimmed = mnemo.trim();
    if (!trimmed) {
      setWalletError(t("home.mnemonicMissing"));
      return;
    }
    setWalletError(null);
    try {
      const node = await deriveFromMnemonic(trimmed, defaultPath);
      const derived = pubkeyToP2PKH(Buffer.from(node.publicKey!), PEPEPOW);
      setAddress(derived);
      localStorage.setItem("pepew_mnemonic", trimmed);
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

  return (
    <AppLayout>
      <PageCard title={t("title")}>
        <div className="card">
          <div className="section-title">{t("home.localWallet")}</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn" onClick={createWallet}>{t("home.createWallet")}</button>
            <button className="btn secondary" onClick={applyMnemonic}>{t("home.useMnemonic")}</button>
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
            placeholder={t("home.mnemonicPlaceholder")}
          />
        </div>
        <div className="card">
          <label className="field-label">{t("address")}</label>
          <div className="row">
            <input className="input" placeholder="PMXw..." value={address} onChange={(e) => setAddress(e.target.value)} />
            <button className="btn secondary" onClick={() => localStorage.setItem('pepew_address', address)}>{t("home.save")}</button>
            <a
              href={`https://explorer.pepepow.net/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn ghost"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              Explorer
            </a>
          </div>
        </div>

        {address && (
          <div className="grid two">
            <div className="card">
              <div className="balance-line">
                <span>{t("balance")}:</span>
                <strong>{fmtPEPEWFromSats(balanceSats)}</strong>
              </div>
              {balanceError && <div className="error" style={{ marginTop: 4 }}>{balanceError}</div>}
              <div className="muted" style={{ marginTop: 6 }}>
                {t("home.usdLabel")}: <strong>{usdRate}</strong>{" "}
                <span>
                  ({usdError ? `${t("home.usdUnavailable")}: ${usdError}` : t("home.usdNote")})
                </span>
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
      </PageCard>
    </AppLayout>
  );
}
