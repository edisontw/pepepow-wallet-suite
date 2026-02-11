import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Buffer } from "buffer";
import { useTranslation } from "react-i18next";
import { addressToScript, buildAndSignP2PKH, selectUtxos, wifFromMnemonic, PEPEPOW } from "@pepepow/wallet-core";
import { apiFetch, getApiUrl, createPaymentRequest as apiCreatePaymentRequest, API_ENDPOINTS, withAddress } from "../lib/api";
import { broadcastTx, fetchRawTx, isTransientRawTxError, TxApiError } from "../lib/tx";
import { fmtPEPEWFromSats, satsToCoin } from "../lib/format";
import { triggerRefresh } from "../lib/refresh";
import { hasPendingSpendTxid, recordPendingSpend } from "../lib/pending";
import { walletStore, WalletState, type Utxo } from "../lib/walletStore";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";
import {
  buildConsolidationTx,
  estimateP2PKHTxBytes,
  type ConsolidationInput,
  MAX_CONSOLIDATE_INPUTS,
  MAX_CONSOLIDATE_TX_BYTES,
  selectConsolidationUtxos
} from "../utils/consolidate";

type ConsolidationPreview = {
  selected: Utxo[];
  totalInSats: number;
  outputSats: number;
  feeSats: number;
  estimatedBytes: number;
};

type RawTxBatchFailure = {
  txid: string;
  error: string;
  requestId?: string;
  code?: string;
  status?: number;
};

type RawTxBatchResult = {
  ok: Array<{ txid: string; rawTx: string }>;
  failed: RawTxBatchFailure[];
  fromCache: number;
  total: number;
  durationMs: number;
};

type RawTxRetryContext = {
  mode: "send" | "consolidate";
  failedTxids: string[];
  succeeded: number;
  failed: number;
  total: number;
  requestIds: string[];
};

const DEFAULT_PATH = "m/44'/5'/0'/0/0";
const COIN_MULTIPLIER = 100000000n;
const MIN_SEND_SATS = 100000000;
const DUST_THRESHOLD_SATS = 546;
const FEE_FALLBACK = "0.0001";
const RECENT_RECIPIENTS_KEY = "pepew_recentRecipients";
const MAX_RECENT_RECIPIENTS = 6;
const SPENT_OUTPOINT_TTL_MS = 10 * 60 * 1000;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const LAST_RAWTX_KEY = "pepew_last_broadcast";
const LAST_RAWTX_TTL_MS = 2 * 60 * 1000;
const RAWTX_BATCH_CONCURRENCY = 4;
const RAWTX_BATCH_RETRIES = 1;
const RAWTX_RETRY_BACKOFF_MS = [200, 500];

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

function normalizeAddressInput(value: string) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutZeroWidth = trimmed.replace(ZERO_WIDTH_RE, "");
  const withoutScheme = withoutZeroWidth
    .replace(/^(pepepow|pepew):\/\//i, "")
    .replace(/^(pepepow|pepew):/i, "");
  const withoutQuery = withoutScheme.split("?")[0] || "";
  return withoutQuery.trim();
}

function hexToBytes(hex: string) {
  if (!hex || typeof hex !== "string") return null;
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = hex.slice(i * 2, i * 2 + 2);
    bytes[i] = Number.parseInt(byte, 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexFromHexString(hex: string) {
  if (typeof crypto?.subtle === "undefined") return null;
  const bytes = hexToBytes(hex);
  if (!bytes) return null;
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function computeTxidFromRawTx(rawTx: string) {
  if (typeof crypto?.subtle === "undefined") return null;
  const bytes = hexToBytes(rawTx);
  if (!bytes) return null;
  try {
    const hash1 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash2 = new Uint8Array(await crypto.subtle.digest("SHA-256", hash1));
    return bytesToHex(new Uint8Array(Array.from(hash2).reverse()));
  } catch {
    return null;
  }
}

type LastBroadcastCache = {
  hash: string;
  ts: number;
  txid?: string;
};

function loadLastBroadcastCache(now = Date.now()): LastBroadcastCache | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LAST_RAWTX_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.hash !== "string" || typeof parsed.ts !== "number") return null;
    if (now - parsed.ts > LAST_RAWTX_TTL_MS) {
      localStorage.removeItem(LAST_RAWTX_KEY);
      return null;
    }
    return parsed as LastBroadcastCache;
  } catch {
    return null;
  }
}

function saveLastBroadcastCache(entry: LastBroadcastCache) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LAST_RAWTX_KEY, JSON.stringify(entry));
}

export default function Send() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [address, setAddress] = useState(localStorage.getItem("pepew_address") || "");
  const [to, setTo] = useState(searchParams.get("to") || "");
  const [amount, setAmount] = useState(searchParams.get("amount") || "");
  const [fee, setFee] = useState("");
  const [subtractFee, setSubtractFee] = useState(false);
  const [mnemo] = useState(localStorage.getItem("pepew_mnemonic") || "");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sendLocked, setSendLocked] = useState(false);
  const [lastTxid, setLastTxid] = useState<string | null>(null);
  const [sendStatusNote, setSendStatusNote] = useState<string | null>(null);
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);
  const [tgUserQuery, setTgUserQuery] = useState(searchParams.get("to") || "");
  const [resolveStatus, setResolveStatus] = useState<"idle" | "loading" | "ok" | "not_started" | "not_found" | "error">("idle");
  const [resolveMessage, setResolveMessage] = useState<string | null>(null);
  const [resolveResult, setResolveResult] = useState<{
    ok: boolean;
    resolved: boolean;
    address?: string;
    reason?: "user_not_found" | "no_default_address" | "invalid_default_address";
  } | null>(null);
  const [requestUrl, setRequestUrl] = useState<string | null>(null);
  const [requestLoading, setRequestLoading] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState<string | null>(null);
  const [feeEstimateSource, setFeeEstimateSource] = useState<string | null>(null);
  const [feeEstimateError, setFeeEstimateError] = useState<string | null>(null);
  const [feeNotice, setFeeNotice] = useState<string | null>(null);
  const [feeTouched, setFeeTouched] = useState(false);
  const [recentRecipients, setRecentRecipients] = useState<string[]>(loadRecentRecipients());
  const [sendAttempted, setSendAttempted] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateOpen, setConsolidateOpen] = useState(false);
  const [consolidatePreview, setConsolidatePreview] = useState<ConsolidationPreview | null>(null);
  const [rawTxRetryContext, setRawTxRetryContext] = useState<RawTxRetryContext | null>(null);
  const [walletState, setWalletState] = useState<WalletState>(walletStore.getState());
  const resolveSeq = useRef(0);
  const mountedRef = useRef(true);
  const sendInFlightRef = useRef(false);
  const consolidateInFlightRef = useRef(false);
  const rawTxCacheRef = useRef<Map<string, string>>(new Map());
  const lastSuccessSnapshotRef = useRef<{
    to: string;
    amount: string;
    fee: string;
    subtractFee: boolean;
    address: string;
  } | null>(null);
  const normalizedTo = useMemo(() => normalizeAddressInput(to), [to]);
  const normalizedAddress = useMemo(() => normalizeAddressInput(address), [address]);

  useEffect(() => {
    return walletStore.subscribe(setWalletState);
  }, []);

  useEffect(() => {
    walletStore.setAddress(address);
  }, [address]);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(RECENT_RECIPIENTS_KEY, JSON.stringify(recentRecipients));
  }, [recentRecipients]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      rawTxCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!sendLocked) return;
    const snapshot = lastSuccessSnapshotRef.current;
    if (!snapshot) return;
    if (snapshot.to !== to
      || snapshot.amount !== amount
      || snapshot.fee !== fee
      || snapshot.subtractFee !== subtractFee
      || snapshot.address !== address) {
      setSendLocked(false);
      setResult(null);
      setLastTxid(null);
      setSendStatusNote(null);
      setErr(null);
    }
  }, [sendLocked, to, amount, fee, subtractFee, address]);


  useEffect(() => {
    let active = true;
    const run = async () => {
      setFeeEstimateError(null);
      setFeeNotice(null);
      try {
        const r = await apiFetch(API_ENDPOINTS.wallet.feeEstimate);
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

  const resolveUser = useCallback(async (query: string) => {
    const isId = /^\d+$/.test(query);
    const params = new URLSearchParams();
    if (isId) {
      params.append("toTgUserId", query);
    } else {
      params.append("username", query.replace(/^@/, ""));
    }
    const r = await apiFetch(API_ENDPOINTS.v1.resolve(params));
    const payload = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, payload };
  }, []);

  const runResolve = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResolveStatus("idle");
      setResolveMessage(null);
      setResolveResult(null);
      return;
    }
    const debug = new URLSearchParams(window.location.search).get("debug") === "1";
    const seq = resolveSeq.current + 1;
    resolveSeq.current = seq;
    setResolveStatus("loading");
    setResolveMessage(null);
    setResolveResult(null);
    setErr(null);

    try {
      if (debug) console.info(`[send] resolve request for ${trimmed}`);
      const res = await resolveUser(trimmed);
      if (resolveSeq.current !== seq) return;
      if (debug) console.info(`[send] resolve response`, { status: res.status, payload: res.payload });

      if (res.status === 401) {
        setResolveStatus("error");
        setResolveMessage(t("send.resolveAuthExpired"));
        return;
      }
      if (res.status === 429 || res.status >= 500) {
        setResolveStatus("error");
        setResolveMessage(t("send.resolveUnavailable"));
        return;
      }

      if (!res.ok) {
        const code = typeof res.payload?.error === "string"
          ? res.payload.error
          : typeof res.payload?.code === "string"
            ? res.payload.code
            : "";
        if (String(code).toUpperCase() === "NOT_STARTED") {
          setResolveStatus("not_started");
          setResolveMessage(t("send.tgUserNotFound"));
        } else {
          setResolveStatus("not_found");
          setResolveMessage(t("send.resolveNotFound"));
        }
        return;
      }

      const payload = res.payload;
      if (payload?.ok === false) {
        const code = typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.code === "string"
            ? payload.code
            : "";
        if (String(code).toUpperCase() === "NOT_STARTED") {
          setResolveStatus("not_started");
          setResolveMessage(t("send.tgUserNotFound"));
        } else {
          setResolveStatus("not_found");
          setResolveMessage(t("send.resolveNotFound"));
        }
        return;
      }

      setResolveResult(payload);
      if (payload?.resolved && payload?.address) {
        setResolveStatus("ok");
        setResolveMessage(null);
        setTo(payload.address);
        return;
      }

      if (payload?.reason === "user_not_found") {
        setResolveStatus("not_started");
        setResolveMessage(t("send.tgUserNotFound"));
      } else if (payload?.reason === "no_default_address") {
        setResolveStatus("not_found");
        setResolveMessage(t("send.tgNoDefaultAddress"));
      } else if (payload?.reason === "invalid_default_address") {
        setResolveStatus("not_found");
        setResolveMessage(t("send.tgInvalidDefaultAddress"));
      } else {
        setResolveStatus("not_found");
        setResolveMessage(t("send.resolveNotFound"));
      }
    } catch (e: any) {
      if (resolveSeq.current !== seq) return;
      if (debug) console.error(`[send] resolve error`, e);
      setResolveStatus("error");
      setResolveMessage(t("send.resolveUnavailable"));
    }
  }, [resolveUser, t]);

  const handleResolve = () => {
    void runResolve(tgUserQuery);
  };

  const isTelegram = !!(window as any).Telegram?.WebApp?.initData;

  useEffect(() => {
    if (!isTelegram) return;
    const initialTo = searchParams.get("to");
    if (initialTo && !to) {
      void runResolve(initialTo);
    }
  }, [isTelegram, runResolve, searchParams, to]);

  useEffect(() => {
    if (!isTelegram) return;
    const query = tgUserQuery.trim();
    if (!query) {
      setResolveStatus("idle");
      setResolveMessage(null);
      setResolveResult(null);
      return;
    }
    setResolveStatus("loading");
    setResolveMessage(null);
    setResolveResult(null);
    const timer = window.setTimeout(() => {
      void runResolve(query);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [isTelegram, runResolve, tgUserQuery]);

  const handleCreateRequest = async () => {
    const query = tgUserQuery.trim();
    if (!query) return;
    setRequestLoading(true);
    setRequestUrl(null);
    try {
      const isId = /^\d+$/.test(query);
      const res = await apiCreatePaymentRequest({
        toTgUserId: isId ? query : "",
        toUsername: isId ? "" : query.replace(/^@/, ""),
        amountSats: amountSats || undefined,
        memo: t("send.defaultMemo"),
      });
      if (res.ok) {
        const urlBase = window.location.origin;
        const link = `${urlBase}/?requestId=${res.requestId}`;
        setRequestUrl(link);
      } else {
        setErr(res.error || t("send.errors.requestCreateFailed"));
      }
    } catch {
      setErr(t("send.errors.requestNetworkError"));
    } finally {
      setRequestLoading(false);
    }
  };

  const availableSats = walletStore.getDisplayBalance() ?? 0;
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
  const debugEnabled = import.meta.env.DEV || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1");
  const networkMeta = {
    pubKeyHash: PEPEPOW.pubKeyHash,
    scriptHash: PEPEPOW.scriptHash,
    bech32: PEPEPOW.bech32,
    wif: PEPEPOW.wif
  };

  const validateAddressInput = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return { ok: false as const, reason: "missing" as const };
    try {
      const info = addressToScript(trimmed, PEPEPOW);
      return { ok: true as const, info };
    } catch (e: any) {
      return { ok: false as const, reason: "invalid" as const, error: e?.message || String(e) };
    }
  };

  const recipientValidation = useMemo(() => validateAddressInput(normalizedTo), [normalizedTo]);
  const changeValidation = useMemo(() => validateAddressInput(normalizedAddress), [normalizedAddress]);
  const recipientAddressError = (sendAttempted || to.trim())
    ? recipientValidation.ok
      ? null
      : recipientValidation.reason === "missing"
        ? t("send.errors.recipientMissing")
        : t("send.errors.recipientInvalid")
    : null;
  const changeAddressError = (sendAttempted || address.trim())
    ? changeValidation.ok
      ? null
      : changeValidation.reason === "missing"
        ? t("send.errors.senderAddressMissing")
        : t("send.errors.senderAddressInvalid")
    : null;
  const resolveBlocked = isTelegram
    && tgUserQuery.trim().length > 0
    && !to
    && (resolveStatus === "not_started" || resolveStatus === "not_found" || resolveStatus === "error");
  const addressInvalid = !recipientValidation.ok || !changeValidation.ok;

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

  const resetSendState = () => {
    setSendLocked(false);
    setResult(null);
    setLastTxid(null);
    setSendStatusNote(null);
    setErr(null);
    setSendAttempted(false);
    setConsolidating(false);
    setConsolidateOpen(false);
    setConsolidatePreview(null);
    setRawTxRetryContext(null);
    setTo("");
    setAmount("");
    setSubtractFee(false);
    setFeeTouched(false);
    setFee(feeEstimate || "");
    setTgUserQuery("");
    setResolveStatus("idle");
    setResolveMessage(null);
    setResolveResult(null);
    setRequestUrl(null);
  };

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


  const mapBroadcastError = (detail?: string) => {
    if (!detail) return null;
    const message = detail.toLowerCase();
    if (message.includes("dust")) {
      return t("send.errors.amountDust");
    }
    if (message.includes("fee too low")
      || message.includes("insufficient fee")
      || message.includes("min relay fee")
      || message.includes("mempool min fee")
      || message.includes("min relay tx fee")) {
      return t("send.errors.feeTooLow");
    }
    if (message.includes("insufficient funds")
      || message.includes("insufficient balance")
      || message.includes("bad-txns-in-belowout")
      || message.includes("value out of range")
      || message.includes("negative")) {
      return t("send.errors.insufficientBalance");
    }
    if (message.includes("missing inputs")
      || message.includes("inputs missing")
      || message.includes("missing-inputs")
      || message.includes("already spent")) {
      return t("send.errors.utxoPending");
    }
    return null;
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const shouldOfferFailedOnlyRetry = (failed: number, total: number) => {
    if (failed <= 1) return true;
    if (total <= 0) return false;
    return failed / total <= 0.1;
  };

  const summarizeRawTxBatchError = (result: RawTxBatchResult) => {
    const requestIds = Array.from(new Set(
      result.failed
        .map((item) => item.requestId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ));
    const requestIdSummary = requestIds.length ? requestIds.slice(0, 3).join(", ") : "-";
    const failed = result.failed.length;
    const total = result.total;
    const timeoutLike = result.failed.some((item) =>
      item.status === 504
      || item.code === "UPSTREAM_TIMEOUT"
      || item.code === "RPC_TIMEOUT"
      || item.code === "INDEXER_TIMEOUT"
      || /timeout/i.test(item.error)
    );
    const firstNotFound = result.failed.find((item) => item.status === 404);

    if (failed === 1 && firstNotFound) {
      const notFoundMessage = t("send.errors.txRawNotFound", { txid: firstNotFound.txid });
      return {
        message: requestIds.length ? `${notFoundMessage}. request-id: ${requestIds[0]}` : notFoundMessage,
        requestIds,
      };
    }
    if (timeoutLike && shouldOfferFailedOnlyRetry(failed, total)) {
      return {
        message: t("send.errors.txRawBatchPartialTimeout", { failed, total, requestIds: requestIdSummary }),
        requestIds,
      };
    }
    if (timeoutLike) {
      return {
        message: t("send.errors.txRawBatchManyTimeout", { failed, total, requestIds: requestIdSummary }),
        requestIds,
      };
    }
    if (shouldOfferFailedOnlyRetry(failed, total)) {
      return {
        message: t("send.errors.txRawBatchPartialFailed", { failed, total, requestIds: requestIdSummary }),
        requestIds,
      };
    }
    return {
      message: t("send.errors.txRawBatchManyFailed", { failed, total, requestIds: requestIdSummary }),
      requestIds,
    };
  };

  const fetchRawTxWithRetry = useCallback(async (txid: string) => {
    const cached = rawTxCacheRef.current.get(txid);
    if (cached) {
      return { txid, rawTx: cached, fromCache: true, attempts: 0 };
    }

    let attempt = 0;
    while (attempt <= RAWTX_BATCH_RETRIES) {
      attempt += 1;
      try {
        const rawTx = await fetchRawTx(txid);
        rawTxCacheRef.current.set(txid, rawTx);
        return { txid, rawTx, fromCache: false, attempts: attempt };
      } catch (err: any) {
        const willRetry = isTransientRawTxError(err) && attempt <= RAWTX_BATCH_RETRIES;
        if (debugEnabled) {
          console.warn("[rawtx-batch] fetch attempt failed", {
            txid,
            attempt,
            willRetry,
            status: err instanceof TxApiError ? err.status : undefined,
            code: err instanceof TxApiError ? err.code : undefined,
            requestId: err instanceof TxApiError ? err.requestId : undefined,
            error: err instanceof TxApiError ? (err.detail || err.message) : (err?.message || String(err))
          });
        }
        if (!willRetry) throw err;
        const backoffMs = RAWTX_RETRY_BACKOFF_MS[Math.min(attempt - 1, RAWTX_RETRY_BACKOFF_MS.length - 1)];
        await sleep(backoffMs);
      }
    }

    throw new Error(`rawtx fetch retries exhausted: ${txid}`);
  }, [debugEnabled]);

  const fetchRawTxBatch = useCallback(async (txids: string[]): Promise<RawTxBatchResult> => {
    const uniqueTxids = Array.from(new Set(txids.filter(Boolean)));
    const startedAt = Date.now();
    if (!uniqueTxids.length) {
      return { ok: [], failed: [], fromCache: 0, total: 0, durationMs: 0 };
    }

    const ok: Array<{ txid: string; rawTx: string }> = [];
    const failed: RawTxBatchFailure[] = [];
    let fromCache = 0;
    let nextIndex = 0;
    const workerCount = Math.min(RAWTX_BATCH_CONCURRENCY, uniqueTxids.length);

    if (debugEnabled) {
      console.info("[rawtx-batch] start", {
        total: uniqueTxids.length,
        concurrency: workerCount,
        retries: RAWTX_BATCH_RETRIES
      });
    }

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < uniqueTxids.length) {
        const current = nextIndex;
        nextIndex += 1;
        const txid = uniqueTxids[current];
        try {
          const fetched = await fetchRawTxWithRetry(txid);
          if (fetched.fromCache) fromCache += 1;
          ok.push({ txid, rawTx: fetched.rawTx });
        } catch (err: any) {
          const errorText = err instanceof TxApiError ? (err.detail || err.message) : (err?.message || String(err));
          failed.push({
            txid,
            error: errorText,
            requestId: err instanceof TxApiError ? err.requestId : undefined,
            code: err instanceof TxApiError ? err.code : undefined,
            status: err instanceof TxApiError ? err.status : undefined,
          });
        }
      }
    });

    await Promise.all(workers);
    const durationMs = Date.now() - startedAt;

    if (debugEnabled) {
      console.info("[rawtx-batch] complete", {
        total: uniqueTxids.length,
        ok: ok.length,
        failed: failed.length,
        fromCache,
        durationMs
      });
    }

    return {
      ok,
      failed,
      fromCache,
      total: uniqueTxids.length,
      durationMs
    };
  }, [debugEnabled, fetchRawTxWithRetry]);

  const prepareConsolidationPreview = () => {
    const st = walletStore.getState();
    const utxosForCheck = st.utxos;
    if (!utxosForCheck || utxosForCheck.length === 0) {
      if (st.status === "loading") {
        setErr(t("send.errors.utxoLoading"));
      } else if (st.status === "error") {
        const detail = st.rawUtxoSumError || st.error || t("errors.unknown");
        setErr(t("send.errors.utxoFetchFailed", { error: detail }));
      } else {
        setErr(t("send.errors.utxoEmpty"));
      }
      return null;
    }

    const invalidUtxos = utxosForCheck.filter(u => u.invalid);
    if (invalidUtxos.length > 0) {
      setErr(t("send.errors.utxoIncomplete", { count: invalidUtxos.length }));
      return null;
    }

    const trimmedMnemonic = mnemo.trim();
    if (!trimmedMnemonic) {
      setErr(t("send.errors.mnemonicMissing"));
      return null;
    }

    const sendFrom = normalizeAddressInput(address);
    if (!sendFrom) {
      setErr(t("send.errors.senderAddressMissing"));
      return null;
    }
    if (!changeValidation.ok) {
      setErr(changeValidation.reason === "missing"
        ? t("send.errors.senderAddressMissing")
        : t("send.errors.senderAddressInvalid"));
      return null;
    }

    if (feeSats === null || feeSats < 0) {
      setErr(t("send.errors.feeInvalid"));
      return null;
    }

    const selected = selectConsolidationUtxos(utxosForCheck, MAX_CONSOLIDATE_INPUTS);
    if (!selected.length) {
      setErr(t("send.errors.insufficientUtxo"));
      return null;
    }

    const totalInSats = selected.reduce((sum, u) => sum + Number(u.valueSats || 0), 0);
    const outputSats = totalInSats - feeSats;
    if (outputSats <= 0) {
      setErr(t("send.errors.amountUnderFee"));
      return null;
    }
    if (outputSats < DUST_THRESHOLD_SATS) {
      setErr(t("send.errors.amountDust"));
      return null;
    }

    // Guardrail: avoid building a tx that's too large to relay reliably.
    const estimatedBytes = estimateP2PKHTxBytes(selected.length, 1);
    if (estimatedBytes > MAX_CONSOLIDATE_TX_BYTES) {
      setErr(t("send.errors.consolidateTooLarge"));
      return null;
    }

    return {
      selected,
      totalInSats,
      outputSats,
      feeSats,
      estimatedBytes
    };
  };

  const openConsolidateConfirm = () => {
    setErr(null);
    setRawTxRetryContext(null);
    const preview = prepareConsolidationPreview();
    if (!preview) return;
    setConsolidatePreview(preview);
    setConsolidateOpen(true);
  };

  const closeConsolidateConfirm = () => {
    setConsolidateOpen(false);
    setConsolidatePreview(null);
  };

  async function doConsolidate() {
    if (consolidateInFlightRef.current) return;
    const preview = consolidatePreview ?? prepareConsolidationPreview();
    if (!preview) return;
    consolidateInFlightRef.current = true;
    setConsolidating(true);
    setErr(null);
    setRawTxRetryContext(null);
    setResult(null);
    setLastTxid(null);
    setSendStatusNote(null);
    setConsolidateOpen(false);

    try {
      const trimmedMnemonic = mnemo.trim();
      if (!trimmedMnemonic) {
        setErr(t("send.errors.mnemonicMissing"));
        return;
      }

      const sendFrom = normalizeAddressInput(address);
      if (!sendFrom) {
        setErr(t("send.errors.senderAddressMissing"));
        return;
      }
      if (!changeValidation.ok) {
        setErr(changeValidation.reason === "missing"
          ? t("send.errors.senderAddressMissing")
          : t("send.errors.senderAddressInvalid"));
        return;
      }

      const wif = await wifFromMnemonic(trimmedMnemonic, DEFAULT_PATH, PEPEPOW);
      // nonWitnessUtxo is required for each input; each txid fetch is independent, so bounded parallel fetch is safe.
      const requiredTxids = preview.selected.map((u) => u.txid).filter((txid): txid is string => typeof txid === "string" && txid.length > 0);
      const rawTxBatch = await fetchRawTxBatch(requiredTxids);
      if (rawTxBatch.failed.length > 0) {
        const summary = summarizeRawTxBatchError(rawTxBatch);
        const canRetryFailedOnly = shouldOfferFailedOnlyRetry(rawTxBatch.failed.length, rawTxBatch.total);
        if (canRetryFailedOnly) {
          setRawTxRetryContext({
            mode: "consolidate",
            failedTxids: rawTxBatch.failed.map((item) => item.txid),
            succeeded: rawTxBatch.ok.length,
            failed: rawTxBatch.failed.length,
            total: rawTxBatch.total,
            requestIds: summary.requestIds,
          });
        } else {
          setRawTxRetryContext(null);
        }
        setErr(summary.message);
        return;
      }

      const rawTxByTxid = new Map(rawTxBatch.ok.map((item) => [item.txid, item.rawTx]));
      const inputs: ConsolidationInput[] = [];
      for (const u of preview.selected) {
        if (!u.txid || u.vout === undefined || !Number.isFinite(u.valueSats)) {
          console.error("[CONSOLIDATE_ASSERT] Invalid UTXO structure", u);
          throw new Error(`Invalid UTXO in Selection: ${JSON.stringify(u)}`);
        }
        const hex = rawTxByTxid.get(u.txid);
        if (!hex || typeof hex !== "string" || hex.length === 0) {
          setErr(t("send.errors.txRawFailed", { txid: u.txid }));
          return;
        }
        inputs.push({
          txid: u.txid,
          vout: u.vout,
          value: Number(u.valueSats),
          nonWitnessUtxo: hex
        });
      }

      const { rawTx, totalInSats, outputSats } = buildConsolidationTx({
        network: PEPEPOW,
        inputs,
        wif,
        address: sendFrom,
        feeSats: preview.feeSats
      });

      if (!rawTx) {
        console.error("[CONSOLIDATE_ASSERT] buildConsolidationTx returned empty/undefined");
        setErr(t("send.errors.txBuildMissingOutput"));
        return;
      }
      if (typeof rawTx !== "string" || rawTx.length < 20) {
        console.error("[CONSOLIDATE_ASSERT] invalid raw tx hex", { rawTx });
        setErr(t("send.errors.txBuildInvalidHex"));
        return;
      }

      const rawTxLen = rawTx.length;
      const rawTxHash = rawTx ? await sha256HexFromHexString(rawTx) : null;
      const rawTxHash16 = rawTxHash ? rawTxHash.slice(0, 16) : "n/a";
      const localTxid = await computeTxidFromRawTx(rawTx);
      console.info("[consolidate] raw tx result", {
        rawTxLen,
        rawTxHash16,
        localTxid,
        inputCount: preview.selected.length,
        totalInSats,
        outputSats
      });

      const cached = loadLastBroadcastCache();
      const cachedMatch = !!cached
        && ((rawTxHash && cached.hash === rawTxHash)
          || (localTxid && cached.txid === localTxid));
      const pendingMatch = localTxid ? hasPendingSpendTxid(localTxid) : false;

      if (pendingMatch || cachedMatch) {
        const txidToShow = localTxid || cached?.txid || null;
        if (txidToShow) {
          setResult(txidToShow);
          setLastTxid(txidToShow);
        }
        setSendStatusNote(t("send.alreadyBroadcast"));
        return;
      }

      try {
        const j = await broadcastTx(rawTx);
        const txid = j.result || j.txid;
        const txidString = typeof txid === "string" ? txid : (localTxid || null);
        setResult(txidString || JSON.stringify(j));
        setLastTxid(txidString);
        setSendStatusNote(null);
        if (txidString) {
          saveLastBroadcastCache({
            hash: rawTxHash || "",
            ts: Date.now(),
            txid: txidString
          });
        }
        const spendSats = preview.feeSats;
        const alreadyPending = txidString ? hasPendingSpendTxid(txidString) : false;

        if (alreadyPending) {
          setSendStatusNote(t("send.alreadyBroadcast"));
        }

        if (!alreadyPending && Number.isFinite(spendSats) && spendSats > 0) {
          walletStore.applyOptimistic(spendSats);
          recordPendingSpend({
            address: sendFrom,
            sats: spendSats,
            txid: txidString || undefined,
            balanceBeforeSats: Number.isFinite(availableSats) ? availableSats : undefined
          });
        }
        if (!alreadyPending) {
          triggerRefresh({ reason: "consolidate", txid: txidString || undefined });
          walletStore.scheduleRefresh();
        }
      } catch (e: any) {
        if (e instanceof TxApiError) {
          const mapped = mapBroadcastError(e.detail);
          if (mapped) {
            setErr(mapped);
          } else if (e.detail) {
            setErr(e.detail);
          } else {
            setErr(t("send.errors.broadcastFailed"));
          }
        } else {
          setErr(t("send.errors.broadcastFailed"));
        }
        return;
      }
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      consolidateInFlightRef.current = false;
      setConsolidating(false);
      setConsolidatePreview(null);
    }
  }

  async function doSend() {
    if (sendLocked) {
      setSendStatusNote(t("send.alreadyBroadcast"));
      return;
    }
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      setSendAttempted(true);
      setSending(true);
      setErr(null);
      setRawTxRetryContext(null);
      setResult(null);
      setLastTxid(null);
      setSendStatusNote(null);

      // 3️⃣ 加一道防呆：確保沒有 UTXO 時不會進到組交易邏輯
      const st = walletStore.getState();
      const utxosForCheck = st.utxos;
      if (!utxosForCheck || utxosForCheck.length === 0) {
        if (st.status === "loading") {
          setErr(t("send.errors.utxoLoading"));
        } else if (st.status === "error") {
          const detail = st.rawUtxoSumError || st.error || t("errors.unknown");
          setErr(t("send.errors.utxoFetchFailed", { error: detail }));
        } else {
          setErr(t("send.errors.utxoEmpty"));
        }
        setSending(false);
        return;
      }

      const invalidUtxos = utxosForCheck.filter(u => u.invalid);
      if (invalidUtxos.length > 0) {
        setErr(t("send.errors.utxoIncomplete", { count: invalidUtxos.length }));
        setSending(false);
        return;
      }

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
      if (recipientSats < DUST_THRESHOLD_SATS) {
        setErr(t("send.errors.amountDust"));
        return;
      }
      if (recipientSats < MIN_SEND_SATS) {
        setErr(t("send.errors.amountTooLow", { min: 1 }));
        return;
      }
      const totalSats = subtractFee ? amountSats : amountSats + feeSats;
      const usableUtxos = walletStore.getState().utxos;
      const availSatsRaw = usableUtxos.reduce((sum, u) => sum + Number(u.valueSats || 0), 0);
      const sendTo = normalizeAddressInput(to);
      const sendFrom = normalizeAddressInput(address);
      if (!sendTo) {
        setErr(t("send.errors.recipientMissing"));
        return;
      }
      if (!sendFrom) {
        setErr(t("send.errors.senderAddressMissing"));
        return;
      }
      if (!recipientValidation.ok) {
        setErr(recipientValidation.reason === "missing"
          ? t("send.errors.recipientMissing")
          : t("send.errors.recipientInvalid"));
        return;
      }
      if (!changeValidation.ok) {
        setErr(changeValidation.reason === "missing"
          ? t("send.errors.senderAddressMissing")
          : t("send.errors.senderAddressInvalid"));
        return;
      }
      if (resolveBlocked) {
        setErr(t("send.errors.telegramResolveBlocked"));
        return;
      }
      const wif = await wifFromMnemonic(trimmedMnemonic, DEFAULT_PATH, PEPEPOW);
      const target = totalSats;
      const chosen = usableUtxos.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: Number(u.valueSats),
        amount: Number(u.valueSats),
        scriptPubKey: u.scriptHex
      }));
      const { picked, total } = selectUtxos(chosen as any, target);
      if (!picked?.length) {
        setErr(t("send.errors.insufficientUtxo"));
        return;
      }
      const totalIn = Number(total);
      let changeSats = totalIn - recipientSats - feeSats;
      if (changeSats < 0) {
        setErr(t("send.errors.insufficientBalance"));
        return;
      }
      let effectiveFeeSats = feeSats;
      if (changeSats > 0 && changeSats < DUST_THRESHOLD_SATS) {
        effectiveFeeSats += changeSats;
        changeSats = 0;
      }
      let toScriptHex = "";
      let toScriptLen = 0;
      try {
        const info = addressToScript(sendTo, PEPEPOW);
        toScriptHex = info.script.toString("hex");
        toScriptLen = info.script.length;
      } catch (e: any) {
        console.warn("[send] toScript failed", { error: e?.message || String(e), toAddress: sendTo });
      }

      console.info("[SEND_ASSERT]", {
        fromAddress: sendFrom,
        toAddress: sendTo,
        recipientSats,
        feeSats,
        effectiveFeeSats,
        totalInSats: totalIn,
        changeSats,
        utxoCount: picked.length,
        utxos: picked.map(u => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          scriptHex: u.scriptPubKey || (u as any).scriptHex || "MISSING"
        }))
      });

      // nonWitnessUtxo is required for each selected input; fetches are independent and can be parallelized.
      const requiredTxids = picked
        .map((u) => u.txid)
        .filter((txid): txid is string => typeof txid === "string" && txid.length > 0);
      const rawTxBatch = await fetchRawTxBatch(requiredTxids);
      if (rawTxBatch.failed.length > 0) {
        const summary = summarizeRawTxBatchError(rawTxBatch);
        const canRetryFailedOnly = shouldOfferFailedOnlyRetry(rawTxBatch.failed.length, rawTxBatch.total);
        if (canRetryFailedOnly) {
          setRawTxRetryContext({
            mode: "send",
            failedTxids: rawTxBatch.failed.map((item) => item.txid),
            succeeded: rawTxBatch.ok.length,
            failed: rawTxBatch.failed.length,
            total: rawTxBatch.total,
            requestIds: summary.requestIds,
          });
        } else {
          setRawTxRetryContext(null);
        }
        setErr(summary.message);
        return;
      }

      const rawTxByTxid = new Map(rawTxBatch.ok.map((item) => [item.txid, item.rawTx]));
      const inputs = [];
      for (const u of picked) {
        // buildAndSignP2PKH requires nonWitnessUtxo (full raw tx) as hex string
        // We must fetch the raw transaction for each UTXO
        if (!u.txid || u.vout === undefined || (!u.amount && !u.value)) {
          console.error("[SEND_ASSERT] Invalid UTXO structure", u);
          throw new Error(`Invalid UTXO in Selection: ${JSON.stringify(u)}`);
        }
        const hex = rawTxByTxid.get(u.txid);
        if (!hex || typeof hex !== "string" || hex.length === 0) {
          setErr(t("send.errors.txRawFailed", { txid: u.txid }));
          return;
        }
        // Pass hex string directly, NOT Buffer - buildAndSignP2PKH will convert it
        inputs.push({
          txid: u.txid,
          vout: u.vout,
          value: Number(u.amount || u.value),
          nonWitnessUtxo: hex  // hex string, not Buffer
        });
      }

      if (debugEnabled) {
        const inspect = (label: string, addr: string) => {
          try {
            const info = addressToScript(addr, PEPEPOW);
            console.info("[send] address script", {
              label,
              address: addr,
              type: info.type,
              scriptHex: info.script.toString("hex"),
            });
          } catch (e: any) {
            console.warn("[send] address script failed", { label, address: addr, error: e?.message });
          }
        };
        inspect("recipient", sendTo);
        inspect("change", sendFrom);
      }

      const raw = buildAndSignP2PKH({
        network: PEPEPOW,
        utxos: inputs as any,
        wif,
        to: sendTo,
        amount: recipientSats,
        changeAddress: sendFrom,
        fee: effectiveFeeSats
      });

      if (!raw) {
        console.error("[SEND_ASSERT] buildAndSignP2PKH returned empty/undefined");
        setErr(t("send.errors.txBuildMissingOutput"));
        return;
      }
      if (typeof raw !== "string" || raw.length < 20) {
        console.error("[SEND_ASSERT] invalid raw tx hex", { raw });
        setErr(t("send.errors.txBuildInvalidHex"));
        return;
      }

      const rawTxLen = raw.length;
      const rawTxHash = raw ? await sha256HexFromHexString(raw) : null;
      const rawTxHash16 = rawTxHash ? rawTxHash.slice(0, 16) : "n/a";
      const localTxid = await computeTxidFromRawTx(raw);
      console.info("[send] raw tx result", { rawTxLen, rawTxHash16, localTxid });

      const cached = loadLastBroadcastCache();
      const cachedMatch = !!cached
        && ((rawTxHash && cached.hash === rawTxHash)
          || (localTxid && cached.txid === localTxid));
      const pendingMatch = localTxid ? hasPendingSpendTxid(localTxid) : false;

      if (pendingMatch || cachedMatch) {
        const txidToShow = localTxid || cached?.txid || null;
        if (txidToShow) {
          setResult(txidToShow);
          setLastTxid(txidToShow);
        }
        setSendStatusNote(t("send.alreadyBroadcast"));
        setSendLocked(true);
        lastSuccessSnapshotRef.current = {
          to,
          amount,
          fee,
          subtractFee,
          address
        };
        return;
      }

      try {
        const j = await broadcastTx(raw);
        const txid = j.result || j.txid;
        const txidString = typeof txid === "string" ? txid : (localTxid || null);
        setResult(txidString || JSON.stringify(j));
        setLastTxid(txidString);
        setSendLocked(true);
        setSendStatusNote(null);
        lastSuccessSnapshotRef.current = {
          to,
          amount,
          fee,
          subtractFee,
          address
        };
        if (txidString) {
          saveLastBroadcastCache({
            hash: rawTxHash || "",
            ts: Date.now(),
            txid: txidString
          });
        }
        addRecentRecipient(sendTo);
        const spendSats = recipientSats + effectiveFeeSats;
        const alreadyPending = txidString ? hasPendingSpendTxid(txidString) : false;

        if (alreadyPending) {
          setSendStatusNote(t("send.alreadyBroadcast"));
        }

        if (debugEnabled) {
          console.log("[Send] TX Success Debug:", {
            oldSpendableSats: availableSats,
            sendAmountSats: recipientSats,
            feeSats: effectiveFeeSats,
            optimisticDeltaSats: spendSats,
            newSpendableSatsOptimistic: availableSats - spendSats,
            lastBroadcastTxid: txid
          });
        }

        if (!alreadyPending && Number.isFinite(spendSats) && spendSats > 0) {
          walletStore.applyOptimistic(spendSats);
          recordPendingSpend({
            address: sendFrom,
            sats: spendSats,
            txid: txidString || undefined,
            balanceBeforeSats: Number.isFinite(availableSats) ? availableSats : undefined
          });
        }
        const spentOutpoints = picked
          .map((u) => `${u.txid}:${u.vout}`)
          .filter((key) => key && !key.endsWith(":undefined"));
        // walletStore.markSpentOutpoints(spentOutpoints); // DISABLED to avoid double-deduction
        if (!alreadyPending) {
          triggerRefresh({ reason: "send", txid: txidString || undefined });
          walletStore.scheduleRefresh();
        }
      } catch (e: any) {
        if (e instanceof TxApiError) {
          const mapped = mapBroadcastError(e.detail);
          if (mapped) {
            setErr(mapped);
          } else if (e.detail) {
            setErr(e.detail);
          } else {
            setErr(t("send.errors.broadcastFailed"));
          }
        } else {
          setErr(t("send.errors.broadcastFailed"));
        }
        return;
      }
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  const retryFailedRawTxOnly = () => {
    if (!rawTxRetryContext) return;
    setErr(null);
    if (rawTxRetryContext.mode === "send") {
      void doSend();
      return;
    }
    void doConsolidate();
  };

  return (
    <AppLayout>
      <PageCard title={t("send.title")}>
        <div className="card">
          <label className="field-label">{t("send.yourAddress")}</label>
          <div className="row">
            <input className="input" value={address} onChange={e => setAddress(e.target.value)} placeholder="PMXw..." />
            <button className="btn secondary" onClick={() => localStorage.setItem('pepew_address', address)}>{t("send.saveAddress")}</button>
          </div>
          {changeAddressError && <div className="error" style={{ marginTop: 6 }}>{changeAddressError}</div>}
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
              {recipientAddressError && <div className="error" style={{ marginTop: 6 }}>{recipientAddressError}</div>}
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
              <label className="field-label" style={{ marginTop: 16 }}>{t("send.amountLabel")}</label>
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

          {isTelegram && (
            <div className="card" style={{ marginTop: 20 }}>
              <label className="field-label">{t("send.tgTransfer")}</label>
              <div className="row">
                <input
                  className="input"
                  value={tgUserQuery}
                  onChange={e => setTgUserQuery(e.target.value)}
                  placeholder="@username or ID"
                />
                <button className="btn secondary" onClick={handleResolve} disabled={resolveStatus === "loading" || !tgUserQuery.trim()}>
                  {resolveStatus === "loading" ? "..." : t("send.resolve")}
                </button>
              </div>
              {resolveMessage && (
                <div style={{ marginTop: 8 }}>
                  <small className={resolveStatus === "error" ? "error" : "muted"}>
                    {resolveMessage}
                  </small>
                  {resolveResult && !resolveResult.resolved && (
                    <button className="btn ghost" style={{ marginLeft: 8 }} onClick={handleCreateRequest} disabled={requestLoading}>
                      {requestLoading ? "..." : t("send.createRequest")}
                    </button>
                  )}
                </div>
              )}
              {requestUrl && (
                <div className="card" style={{ marginTop: 8, padding: 8, fontSize: '0.9em' }}>
                  <div className="muted">{t("send.requestLink")}</div>
                  <div style={{ wordBreak: 'break-all', marginTop: 4 }}>
                    <a href={requestUrl} target="_blank" rel="noreferrer">{requestUrl}</a>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="note" style={{ marginTop: 10 }}>
            <div>{t("send.feeEstimate")} {feeEstimateLabel}</div>
            {feeEstimateSource && <div>{t("send.sourceLabel")}: {feeEstimateSource}</div>}
            {feeEstimateError && <div className="error">{feeEstimateError}</div>}
            {feeNotice && <div className="muted">{feeNotice}</div>}
            {walletState.error && <div className="error">{walletState.error}</div>}
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
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="section-title">{t("send.utilitiesTitle")}</div>
              <div className="muted" style={{ marginTop: 6 }}>{t("send.consolidateHint")}</div>
            </div>
            <button
              className="btn secondary"
              onClick={openConsolidateConfirm}
              title={t("send.consolidateHint")}
              disabled={sending || consolidating || walletState.status === "error" || !changeValidation.ok || walletState.utxos.length === 0}
            >
              {t("send.consolidate")}
            </button>
          </div>
        </div>

        {(walletState.status === "error") && (
          <div className="error" style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(255,0,0,0.1)' }}>
            {t("errors.apiUnreachable")}
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <button
            className="btn primary full"
            onClick={doSend}
            disabled={sending || consolidating || sendLocked || addressInvalid || overBalance || !!err || walletState.status === "error" || walletState.utxos.length === 0}
          >
            {sending ? t("send.sending") : t("send.submit")}
          </button>
        </div>

        {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
        {err && rawTxRetryContext && (
          <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
            <button
              className="btn secondary"
              onClick={retryFailedRawTxOnly}
              disabled={sending || consolidating}
            >
              {t("send.retryFailedRawTx")}
            </button>
            <span className="muted">
              {t("send.rawTxRetrySummary", {
                ok: rawTxRetryContext.succeeded,
                failed: rawTxRetryContext.failed,
                total: rawTxRetryContext.total
              })}
            </span>
          </div>
        )}
        {result && (
          <div className="card" style={{ marginTop: 12 }}>
            <div>✅ {t("send.broadcasted")}: <code>{result}</code></div>
            {sendStatusNote && <div className="muted" style={{ marginTop: 6 }}>{sendStatusNote}</div>}
            <div className="row" style={{ marginTop: 8 }}>
              {lastTxid && (
                <>
                  <button className="btn ghost small" onClick={() => copyTxid(lastTxid)}>
                    {copiedTxid === lastTxid ? t("copied") : t("copy")}
                  </button>
                  <a
                    href={`https://explorer.pepepow.net/tx/${lastTxid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn ghost small"
                    title={t("viewInExplorer")}
                  >
                    🔍
                  </a>
                </>
              )}
              <button className="btn secondary" onClick={resetSendState}>
                {t("send.newTransfer")}
              </button>
            </div>
          </div>
        )}

        <div className="muted" style={{ marginTop: 12, fontSize: "0.85em" }}>
          {t("send.pathLabel")}: <code>{DEFAULT_PATH}</code>
        </div>
      </PageCard>

      {consolidateOpen && consolidatePreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="section-title">{t("send.consolidateConfirmTitle")}</div>
            <div className="note" style={{ marginTop: 12 }}>
              <div>{t("send.consolidateConfirmCount", { count: consolidatePreview.selected.length })}</div>
              <div>{t("send.consolidateConfirmFee")}: {fmtPEPEWFromSats(consolidatePreview.feeSats)}</div>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button className="btn secondary" onClick={closeConsolidateConfirm} disabled={consolidating}>
                {t("send.consolidateCancel")}
              </button>
              <button className="btn" onClick={doConsolidate} disabled={consolidating}>
                {consolidating ? t("send.sending") : t("send.consolidateConfirmAction")}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
