import express from "express";
import crypto from "crypto";
import { promises as fs } from "fs";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { webhookCallback, Bot, InlineKeyboard } from "grammy";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import bs58check from "bs58check";
import {
  upsertUser,
  setDefaultAddress,
  resolveUserDetail,
  createPaymentRequest,
  claimPaymentRequest,
  getPaymentRequest
} from "./db.js";

const app = express();
// Behind nginx, trust a single proxy hop so req.ip uses X-Forwarded-For.
app.set("trust proxy", 1);
app.use(express.json({ limit: "512kb" }));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const {
  BOT_TOKEN,
  BOT_SECRET_TOKEN,
  JWT_SECRET,
  PEPEW_API_BASE,
  CORE_RPC_URL,
  CORS_ORIGINS,
  CMC_API_KEY,
  TELEGRAM_BOT_TOKEN,
  WALLET_API_DEBUG_AUTH,
} = process.env as Record<string, string>;

const corsOrigins = (CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const telegramInitToken = TELEGRAM_BOT_TOKEN || BOT_TOKEN || "";
const jwtSecret = JWT_SECRET || "changeme";

app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const serviceName = "wallet-api";

function logStartupConfig() {
  const missing: string[] = [];
  if (!PEPEW_API_BASE) missing.push("PEPEW_API_BASE (wallet read APIs)");
  if (!CORE_RPC_URL) missing.push("CORE_RPC_URL (defaulting to http://127.0.0.1:8093)");
  if (!telegramInitToken) missing.push("TELEGRAM_BOT_TOKEN (Telegram initData auth disabled)");
  if (!BOT_TOKEN) missing.push("BOT_TOKEN (Telegram bot disabled)");
  if (!BOT_SECRET_TOKEN) missing.push("BOT_SECRET_TOKEN (webhook auth disabled)");
  if (!CMC_API_KEY) missing.push("CMC_API_KEY (/wallet/price disabled)");
  if (missing.length) {
    console.warn(`[startup] Env not set: ${missing.join(", ")}`);
  }
  if (!JWT_SECRET || JWT_SECRET === "changeme") {
    console.warn("[startup] JWT_SECRET not set or default; tokens are insecure.");
  }
  if (telegramInitToken && !isLikelyTelegramToken(telegramInitToken)) {
    console.warn("[startup] Telegram bot token format looks invalid; expected '<bot_id>:<token>'.");
  }
}

function normalizeApiBase(base: string) {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/, "");
}

function getPepewApiBaseV1() {
  if (!PEPEW_API_BASE) return "";
  const base = normalizeApiBase(PEPEW_API_BASE);
  return `${base}/v1`;
}

function isLikelyTelegramToken(token: string) {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token);
}

function classifyFetchError(err: any, url: string) {
  const code = err?.code || "";
  if (code === "ECONNREFUSED") return `connection refused at ${url}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `host not found for ${url}`;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `timeout contacting ${url}`;
  }
  if (err?.name === "AbortError") return `timeout contacting ${url}`;
  return err?.message || String(err);
}

type PriceResponse = {
  status: "ok" | "stale" | "error";
  symbol: string;
  convert: string;
  price: number | null;
  lastUpdated: string | null;
  source: "cmc";
  stale: boolean;
  error?: string;
};

const priceCache: {
  price: number | null;
  lastUpdated: string | null;
  stale: boolean;
  error?: string;
  lastAttemptAt: number;
} = {
  price: null,
  lastUpdated: null,
  stale: false,
  lastAttemptAt: 0,
};

async function fetchCmcPrice(): Promise<void> {
  const now = Date.now();
  const apiKey = process.env.CMC_API_KEY;
  const symbol = process.env.CMC_SYMBOL || "PEPEW";
  const convert = process.env.CMC_CONVERT || "USD";

  if (!apiKey) {
    priceCache.error = "CMC_API_KEY not set";
    priceCache.stale = true;
    priceCache.lastAttemptAt = now;
    console.warn("[cmc] price refresh failed: CMC_API_KEY not set");
    return;
  }

  // CoinMarketCap v2 API for quotes
  const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(symbol)}&convert=${encodeURIComponent(convert)}`;

  try {
    const { res: r, data } = await fetchJson<any>(
      url,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-CMC_PRO_API_KEY": apiKey,
        },
      },
      10000
    );

    if (!r.ok) {
      const detail = data?.status?.error_message || r.statusText;
      console.error(`[cmc] price refresh HTTP error: ${r.status} ${detail}`);
      priceCache.error = `HTTP ${r.status}: ${detail}`;
      priceCache.stale = true;
      priceCache.lastAttemptAt = now;
      return;
    }

    const dataBySymbol = data?.data?.[symbol];
    const entry = Array.isArray(dataBySymbol) ? dataBySymbol[0] : dataBySymbol;
    const price = entry?.quote?.[convert]?.price;

    if (typeof price !== "number") {
      const detail = data?.status?.error_message || "price not found in response";
      console.error(`[cmc] price refresh data error: ${detail}`);
      priceCache.error = detail;
      priceCache.stale = true;
      priceCache.lastAttemptAt = now;
      return;
    }

    // Success
    priceCache.price = price;
    priceCache.lastUpdated = new Date().toISOString();
    priceCache.stale = false;
    delete priceCache.error;
    priceCache.lastAttemptAt = now;
    console.info(`[cmc] price refreshed: ${symbol} = ${price} ${convert}`);
  } catch (err: any) {
    const detail = classifyFetchError(err, url);
    console.error(`[cmc] price refresh exception: ${detail}`);
    priceCache.error = detail;
    priceCache.stale = true;
    priceCache.lastAttemptAt = now;
  }
}

async function getCmcPriceCached(): Promise<PriceResponse> {
  const symbol = process.env.CMC_SYMBOL || "PEPEW";
  const convert = process.env.CMC_CONVERT || "USD";

  let status: "ok" | "stale" | "error" = "ok";
  if (priceCache.error && !priceCache.price) {
    status = "error";
  } else if (priceCache.stale) {
    status = "stale";
  }

  return {
    status,
    symbol,
    convert,
    price: priceCache.price,
    lastUpdated: priceCache.lastUpdated,
    source: "cmc",
    stale: priceCache.stale,
    error: priceCache.error,
  };
}

function getCoreRpcRequestConfig() {
  const raw = process.env.CORE_RPC_URL || "http://127.0.0.1:8093";
  let url = raw;
  let urlUser = "";
  let urlPass = "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      urlUser = decodeURIComponent(parsed.username || "");
      urlPass = decodeURIComponent(parsed.password || "");
      parsed.username = "";
      parsed.password = "";
      url = parsed.toString();
    }
  } catch {
    if (raw.includes("@")) {
      url = raw.replace(/\/\/[^@]*@/, "//");
    }
  }

  const envUser = process.env.CORE_RPC_USER;
  const envPass = process.env.CORE_RPC_PASS;
  const finalUser = envUser || urlUser;
  const finalPass = envPass || urlPass;
  if (finalUser || finalPass) {
    const auth = Buffer.from(`${finalUser}:${finalPass}`).toString("base64");
    headers.Authorization = `Basic ${auth}`;
  }

  return { url, headers };
}

function getCoreRpcHostLabel() {
  const raw = process.env.CORE_RPC_URL || "http://127.0.0.1:8093";
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
    if (host) return port ? `${host}:${port}` : host;
  } catch {
    // fall through to string parsing
  }
  const withoutCreds = raw.includes("@") ? raw.replace(/^[^@]*@/, "") : raw;
  const cleaned = withoutCreds.replace(/^[a-zA-Z]+:\/\//, "");
  const hostPort = cleaned.split("/")[0];
  return hostPort || "unknown";
}

async function fetchJson<T = any>(url: string, options: any = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => null);
    return { res, data: data as T | null };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkPepewApi() {
  if (!PEPEW_API_BASE) return { ok: false, error: "PEPEW_API_BASE not set" };
  const base = normalizeApiBase(PEPEW_API_BASE);
  const urls = [`${base}/readyz`, `${base}/healthz`, `${base}/health`];
  let lastError = "";
  for (const url of urls) {
    try {
      const { res, data } = await fetchJson(url, { method: "GET" }, 5000);
      if (res.status === 404) {
        lastError = `not found: ${url}`;
        continue;
      }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} from ${url}` };
      }
      if (data && typeof data.ok === "boolean" && !data.ok) {
        return { ok: false, error: data.error || "upstream not ok" };
      }
      return { ok: true };
    } catch (err: any) {
      lastError = classifyFetchError(err, url);
    }
  }
  return { ok: false, error: lastError || "upstream health check failed" };
}

async function checkCoreRpc() {
  const { url, headers } = getCoreRpcRequestConfig();
  const timeoutMs = parseEnvNumber(
    process.env.CORE_RPC_CHECK_TIMEOUT_MS || process.env.CORE_RPC_TIMEOUT_MS || process.env.CORE_RPC_TIMEOUT,
    5000
  );
  try {
    const { res, data } = await fetchJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: "health",
          method: "getblockcount",
          params: [],
        }),
      },
      timeoutMs
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `RPC auth failed (${res.status}). Check CORE_RPC_URL credentials or pepepowd rpcuser/rpcpassword.` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (data?.error) return { ok: false, error: `RPC error: ${JSON.stringify(data.error)}` };
    return { ok: true, height: data?.result };
  } catch (err: any) {
    return { ok: false, error: classifyFetchError(err, url) };
  }
}

async function checkTelegram(logFailures = false) {
  const token = telegramInitToken;
  if (!token) return { ok: true, detail: "disabled" };
  const url = `https://api.telegram.org/bot${token}/getMe`;
  try {
    const { res, data } = await fetchJson(url, { method: "GET" }, 5000);
    if (!res.ok || data?.ok === false) {
      const error = data?.description || `HTTP ${res.status}`;
      const hint = isLikelyTelegramToken(token)
        ? "Check outbound HTTPS to api.telegram.org:443."
        : "Telegram bot token format looks invalid; expected '<bot_id>:<token>'.";
      const errorWithHint = `${error}. ${hint}`;
      if (logFailures) {
        console.warn(`[startup] Telegram check failed: ${errorWithHint}`);
      }
      return { ok: false, error: errorWithHint };
    }
    return { ok: true };
  } catch (err: any) {
    const error = classifyFetchError(err, url);
    const hint = isLikelyTelegramToken(token)
      ? "Check outbound HTTPS to api.telegram.org:443."
      : "Telegram bot token format looks invalid; expected '<bot_id>:<token>'.";
    const errorWithHint = `${error}. ${hint}`;
    if (logFailures) {
      console.warn(`[startup] Telegram check failed: ${errorWithHint}`);
    }
    return { ok: false, error: errorWithHint };
  }
}

function summarizeDependencyErrors(deps: Record<string, any>) {
  const errors: string[] = [];
  if (deps.pepewApi && !deps.pepewApi.ok) {
    errors.push(`pepew-api: ${deps.pepewApi.error || "unreachable"}`);
  }
  if (deps.coreRpc && !deps.coreRpc.ok) {
    errors.push(`core-rpc: ${deps.coreRpc.error || "unreachable"}`);
  }
  if (deps.telegram && !deps.telegram.ok) {
    errors.push(`telegram: ${deps.telegram.error || "unreachable"}`);
  }
  return errors;
}

async function checkDependencies(logFailures = false) {
  const [api, rpc, bot] = await Promise.all([
    checkPepewApi(),
    checkCoreRpc(),
    checkTelegram(logFailures),
  ]);
  const ok = api.ok && rpc.ok && bot.ok;
  return { ok, deps: { pepewApi: api, coreRpc: rpc, telegram: bot } };
}

logStartupConfig();

function safeCompareHex(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function validateTelegramInitData(initData: string, botToken: string) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  if (!hash) return { ok: false, error: "missing hash" };
  urlParams.delete("hash");
  const dataCheckString = Array.from(urlParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!safeCompareHex(computedHash, hash)) {
    return { ok: false, error: "invalid hash" };
  }
  const authDateRaw = urlParams.get("auth_date");
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) {
    return { ok: false, error: "invalid auth_date" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = Number(process.env.TELEGRAM_INITDATA_MAX_AGE_SEC || "86400");
  if (authDate > nowSec + 60) {
    return { ok: false, error: "auth_date in future" };
  }
  if (nowSec - authDate > maxAgeSec) {
    return { ok: false, error: "auth_date expired" };
  }
  let user: any = null;
  const userRaw = urlParams.get("user");
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      user = null;
    }
  }
  return { ok: true, authDate, user };
}

const addrSchema = z.string().min(26).max(64).regex(/^P[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/, "address format invalid");
const PEPEPOW_PUBKEY_HASH = 0x37;
const PEPEPOW_SCRIPT_HASH = 0x10;

function validatePepepowAddress(address: string) {
  try {
    const payload = bs58check.decode(address);
    if (payload.length !== 21) {
      return { ok: false, error: "address payload length invalid" };
    }
    const version = payload[0];
    if (version === PEPEPOW_PUBKEY_HASH) return { ok: true, type: "p2pkh" };
    if (version === PEPEPOW_SCRIPT_HASH) return { ok: true, type: "p2sh" };
    return { ok: false, error: "address version mismatch" };
  } catch (e: any) {
    return { ok: false, error: e?.message || "address checksum invalid" };
  }
}

type RateLimitRequest = express.Request & { walletJwtSub?: string };

function parseEnvNumber(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getJwtSubject(req: RateLimitRequest) {
  if (typeof req.walletJwtSub === "string") return req.walletJwtSub;
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    req.walletJwtSub = "";
    return "";
  }
  try {
    const payload = jwt.verify(match[1], jwtSecret) as any;
    const subject =
      typeof payload?.sub === "string" ? payload.sub :
        typeof payload?.telegramUserId === "string" ? payload.telegramUserId :
          typeof payload?.user_id === "string" ? payload.user_id :
            "";
    req.walletJwtSub = subject || "";
    return req.walletJwtSub;
  } catch {
    req.walletJwtSub = "";
    return "";
  }
}

const authWindowMs = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_AUTH_WINDOW_MS, 10 * 60 * 1000);
const authMax = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_AUTH_MAX, 60);
const readWindowMs = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_READ_WINDOW_MS, 1 * 60 * 1000);
const readMax = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_READ_MAX, 120);
const readJwtMax = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_JWT_READ_MAX, readMax);
const txWindowMs = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_TX_WINDOW_MS, 10 * 60 * 1000);
const txMax = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_TX_MAX, 20);
const txJwtMax = parseEnvNumber(process.env.WALLET_API_RATE_LIMIT_JWT_TX_MAX, txMax);

type RateLimiterType = "auth" | "read" | "tx";
const makeRateLimitHandler =
  (limiterType: RateLimiterType) =>
    (req: express.Request, res: express.Response) => {
      const jwtSub = getJwtSubject(req as RateLimitRequest) || undefined;
      const path = req.originalUrl || req.path;
      const payload = {
        event: "rate_limit",
        limiter: limiterType,
        path,
        ip: req.ip,
        ...(jwtSub ? { jwtSub } : {}),
      };
      console.log("rate_limit", JSON.stringify(payload));
      res.status(429).json({ error: "too many requests" });
    };

const ipKeyGenerator = (req: express.Request) => req.ip;

const authLimiter = rateLimit({
  windowMs: authWindowMs,
  max: authMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: makeRateLimitHandler("auth"),
});
const readLimiter = rateLimit({
  windowMs: readWindowMs,
  max: readMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: makeRateLimitHandler("read"),
});
const readJwtLimiter = rateLimit({
  windowMs: readWindowMs,
  max: readJwtMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `jwt:${getJwtSubject(req as RateLimitRequest)}`,
  skip: (req) => !getJwtSubject(req as RateLimitRequest),
  handler: makeRateLimitHandler("read"),
});
const txLimiter = rateLimit({
  windowMs: txWindowMs,
  max: txMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: makeRateLimitHandler("tx"),
});
const txJwtLimiter = rateLimit({
  windowMs: txWindowMs,
  max: txJwtMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `jwt:${getJwtSubject(req as RateLimitRequest)}`,
  skip: (req) => !getJwtSubject(req as RateLimitRequest),
  handler: makeRateLimitHandler("tx"),
});

const resolveLimiter = rateLimit({
  windowMs: readWindowMs,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `resolve:${getJwtSubject(req as RateLimitRequest)}`,
  handler: makeRateLimitHandler("read"),
});

const readLimiters = [readLimiter, readJwtLimiter];
const txLimiters = [txLimiter, txJwtLimiter];

const walletApiVersion = process.env.WALLET_API_VERSION;
const walletApiGitSha = process.env.WALLET_API_GIT_SHA || process.env.GIT_SHA;
const buildHealthzPayload = () => ({
  ok: true,
  service: serviceName,
  uptimeSec: Math.round(process.uptime()),
  ...(walletApiVersion ? { version: walletApiVersion } : {}),
  ...(walletApiGitSha ? { gitSha: walletApiGitSha } : {}),
});

app.get("/healthz", async (_req, res) => {
  return res.json(buildHealthzPayload());
});

app.get("/wallet/healthz", async (_req, res) => {
  return res.json(buildHealthzPayload());
});

async function handleRpcHealthz(_req: express.Request, res: express.Response) {
  const { url, headers } = getCoreRpcRequestConfig();
  const startedAt = Date.now();
  const rpcTimeoutMs = parseEnvNumber(process.env.CORE_RPC_TIMEOUT_MS || process.env.CORE_RPC_TIMEOUT, 4000);
  const rpcHost = getCoreRpcHostLabel();
  try {
    const { res: rpcRes, data } = await fetchJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: "healthz",
          method: "getblockcount",
          params: [],
        }),
      },
      rpcTimeoutMs
    );
    const latencyMs = Date.now() - startedAt;
    if (!rpcRes.ok || data?.error) {
      const detail = data?.error?.message || data?.error || `RPC HTTP ${rpcRes.status}`;
      return res.status(503).json({ ok: false, error: detail, latencyMs, rpcHost, timeoutMs: rpcTimeoutMs });
    }
    const height = data?.result;
    if (!Number.isFinite(height)) {
      return res.status(503).json({ ok: false, error: "invalid block height", latencyMs, rpcHost, timeoutMs: rpcTimeoutMs });
    }
    return res.json({ ok: true, height, latencyMs, rpcHost, timeoutMs: rpcTimeoutMs });
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    return res.status(503).json({ ok: false, error: classifyFetchError(err, url), latencyMs, rpcHost, timeoutMs: rpcTimeoutMs });
  }
}

app.get("/healthz/rpc", handleRpcHealthz);
app.get("/wallet/healthz/rpc", handleRpcHealthz);

async function handleReadyz(_req: express.Request, res: express.Response) {
  const status = await checkDependencies();
  if ((status.deps as any)?.coreRpc?.height !== undefined) {
    res.setHeader("x-block-height", String((status.deps as any).coreRpc.height));
  }
  const errors = status.ok ? [] : summarizeDependencyErrors(status.deps);
  return res.status(status.ok ? 200 : 503).json({
    ok: status.ok,
    service: serviceName,
    uptimeSec: Math.round(process.uptime()),
    deps: status.deps,
    ...(status.ok ? {} : { error: errors.join("; ") })
  });
}

app.get("/readyz", handleReadyz);
app.get("/wallet/readyz", handleReadyz);

function handleTelegramAuth(req: express.Request, res: express.Response) {
  try {
    const { initData } = req.body as { initData: string };
    if (!initData) return res.status(400).json({ error: "missing initData" });
    if (!telegramInitToken) return res.status(500).json({ error: "Telegram bot token not configured" });
    const result = validateTelegramInitData(initData, telegramInitToken);
    if (!result.ok) return res.status(401).json({ error: result.error || "invalid initData" });
    const user = result.user || {};
    const telegramUserId = user?.id ? String(user.id) : "";
    if (!telegramUserId) return res.status(401).json({ error: "missing telegram user id" });
    const payload = {
      telegramUserId,
      username: typeof user?.username === "string" ? user.username : undefined,
    };
    const token = jwt.sign(payload, jwtSecret, { expiresIn: "30m", subject: telegramUserId });
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: "auth failed" });
  }
}

app.post("/auth/telegram", authLimiter, handleTelegramAuth);
app.post("/api/auth/telegram", authLimiter, handleTelegramAuth);

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  let payload: any = null;
  if (match) {
    try {
      payload = jwt.verify(match[1], jwtSecret) as any;
    } catch {
      // ignore
    }
  }

  const sub = getJwtSubject(req as RateLimitRequest);

  if (WALLET_API_DEBUG_AUTH === "1") {
    const tokenHash8 = match ? crypto.createHash("sha256").update(match[1]).digest("hex").slice(0, 8) : "none";
    const iat = payload?.iat;
    const username = payload?.username || "none";
    console.info(`[auth] requireAuth: path=${req.path}, sub=${sub || "unauthorized"}, token_hash8=${tokenHash8}, iat=${iat}, username=${username}, ip=${req.ip}`);
  }

  if (!sub) return res.status(401).json({ error: "Unauthorized" });
  (req as any).telegramUserId = sub;
  (req as any).jwtPayload = payload;
  (req as any).authToken = match ? match[1] : null;
  next();
}

app.get("/v1/whoami", ...readLimiters, requireAuth, (req, res) => {
  const sub = (req as any).telegramUserId;
  const payload = (req as any).jwtPayload;
  const token = (req as any).authToken;
  const tokenHash8 = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 8) : null;

  res.json({
    ok: true,
    tg_user_id: sub,
    tg_username: payload?.username,
    token_iat: payload?.iat,
    token_hash8: tokenHash8,
  });
});

app.post("/v1/profile/upsert", ...readLimiters, requireAuth, (req, res) => {
  const sub = (req as any).telegramUserId;
  const { username } = req.body;
  try {
    upsertUser(sub, username);
    const logUsername = username || (req as any).jwtPayload?.username || "";
    console.info(`[profile] upsert success: tg_user_id=${sub}, username=${logUsername}, ip=${req.ip}`);

    // Rotate token
    const payload = {
      telegramUserId: sub,
      username: logUsername,
    };
    const token = jwt.sign(payload, jwtSecret, { expiresIn: "30m", subject: sub });

    res.json({ ok: true, token });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/v1/address/default", ...readLimiters, requireAuth, (req, res) => {
  const sub = (req as any).telegramUserId;
  try {
    const result = resolveUserDetail(sub);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    if (WALLET_API_DEBUG_AUTH === "1") {
      const masked = result.address && result.address.length > 12 ? `${result.address.slice(0, 6)}...${result.address.slice(-6)}` : result.address;
      console.info(`[address] GET default: tg_user_id=${sub}, status=${result.status}, address=${masked}`);
    }
    if (result.status === "ok") {
      return res.json({ ok: true, address: result.address });
    }
    return res.status(404).json({ ok: false, error: result.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/v1/address/default", ...readLimiters, requireAuth, (req, res) => {
  const sub = (req as any).telegramUserId;
  const { address, label } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try {
    addrSchema.parse(address);
    const validation = validatePepepowAddress(address);
    if (!validation.ok) return res.status(400).json({ error: validation.error || "address invalid" });
    setDefaultAddress(sub, address, label);
    const masked = address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
    console.info(`[address] set default success: tg_user_id=${sub}, address=${masked}, is_default=1, ip=${req.ip}`);
    res.json({ ok: true, address });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/v1/resolve", resolveLimiter, requireAuth, (req, res) => {
  const { toTgUserId, username } = req.query;
  const sub = (req as any).telegramUserId;
  if (!toTgUserId && !username) return res.status(400).json({ error: "toTgUserId or username required" });
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    const result = resolveUserDetail(toTgUserId as string, username as string);
    const outcome = result.status === "ok" ? "resolved" : result.status;
    console.info(`[resolve] request: sub=${sub}, query=${JSON.stringify(req.query)}, outcome=${outcome}`);

    if (result.status === "ok") {
      const validation = validatePepepowAddress(result.address);
      if (!validation.ok) {
        return res.json({ ok: true, resolved: false, reason: "invalid_default_address" });
      }
      return res.json({ ok: true, resolved: true, address: result.address });
    }
    return res.json({ ok: true, resolved: false, reason: result.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/v1/requests", ...readLimiters, requireAuth, (req, res) => {
  const sub = (req as any).telegramUserId;
  const { toTgUserId, toUsername, amountSats, memo } = req.body;
  if (!toTgUserId) return res.status(400).json({ error: "toTgUserId required" });
  try {
    const ttl = parseEnvNumber(process.env.PAYREQ_TTL_SEC, 86400);
    const { id, expiresAt } = createPaymentRequest(sub, toTgUserId, toUsername, amountSats, memo, ttl);
    res.json({ ok: true, requestId: id, expiresAt });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/v1/requests/:id/claim", ...readLimiters, requireAuth, (req, res) => {
  const sub = (req as any).telegramUserId;
  const { id } = req.params;
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try {
    addrSchema.parse(address);
    const validation = validatePepepowAddress(address);
    if (!validation.ok) return res.status(400).json({ error: validation.error || "address invalid" });
    claimPaymentRequest(id, sub, address);
    res.json({ ok: true });
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 400;
    res.status(status).json({ error: e.message });
  }
});

app.get("/v1/requests/:id", ...readLimiters, requireAuth, (req, res) => {
  const { id } = req.params;
  try {
    const request = getPaymentRequest(id);
    if (!request) return res.status(404).json({ error: "request not found" });
    res.json({
      ok: true,
      status: request.status,
      claimedAddress: request.claimed_address,
      expiresAt: request.expires_at,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/wallet/balance", ...readLimiters, async (req, res) => {
  const address = req.query.address as string;
  try { addrSchema.parse(address); } catch (e: any) { return res.status(400).json({ error: "address invalid" }); }
  const base = getPepewApiBaseV1();
  if (!base) return res.status(503).json({ error: "PEPEW_API_BASE not set" });
  const url = `${base}/addr/${address}/balance`;
  try {
    const { res: r, data } = await fetchJson(url, { method: "GET" }, 8000);
    if (!r.ok) {
      return res.status(502).json({ error: data?.error || `upstream ${r.status}` });
    }
    if (!data) return res.status(502).json({ error: "upstream parse error" });
    return res.json(data);
  } catch (err: any) {
    return res.status(502).json({ error: classifyFetchError(err, url) });
  }
});

app.get("/wallet/utxos", ...readLimiters, async (req, res) => {
  const address = req.query.address as string;
  try { addrSchema.parse(address); } catch (e: any) { return res.status(400).json({ error: "address invalid" }); }
  const base = getPepewApiBaseV1();
  if (!base) return res.status(503).json({ error: "PEPEW_API_BASE not set" });
  const url = `${base}/addr/${address}/utxos`;
  try {
    const { res: r, data } = await fetchJson(url, { method: "GET" }, 8000);
    if (!r.ok) {
      return res.status(502).json({ error: data?.error || `upstream ${r.status}` });
    }
    if (!data) return res.status(502).json({ error: "upstream parse error" });

    // Enrich with scriptPubKey if missing (for P2PKH)
    const utxos = Array.isArray(data) ? data : (data.utxos || []);
    const enriched = utxos.map((u: any) => {
      if (u.scriptPubKey) return u;
      try {
        const decoded = bs58check.decode(address);
        const hash = decoded.slice(1);
        return { ...u, scriptPubKey: `76a914${hash.toString("hex")}88ac` };
      } catch {
        return u;
      }
    });

    return res.json(enriched);
  } catch (err: any) {
    return res.status(502).json({ error: classifyFetchError(err, url) });
  }
});

function normalizeHistoryPayload(data: any) {
  if (Array.isArray(data)) return { txs: data };
  if (data && typeof data === "object") {
    const txs = Array.isArray(data.txs)
      ? data.txs
      : Array.isArray((data as any).transactions)
        ? (data as any).transactions
        : [];
    return { ...data, txs };
  }
  return { txs: [] };
}

app.get("/wallet/history", ...readLimiters, async (req, res) => {
  const address = req.query.address as string;
  try { addrSchema.parse(address); } catch (e: any) { return res.status(400).json({ error: "address invalid" }); }
  const base = getPepewApiBaseV1();
  if (!base) return res.status(503).json({ error: "PEPEW_API_BASE not set" });
  const url = `${base}/addr/${address}/txs`;
  try {
    const { res: r, data } = await fetchJson(url, { method: "GET" }, 8000);
    if (r.ok) {
      const payload = normalizeHistoryPayload(data);
      return res.json({ ...payload, ok: true });
    }
    if (r.status === 404) {
      return res.json({ ok: true, txs: [] });
    }
    return res.status(502).json({ error: data?.error || `upstream ${r.status}` });
  } catch (err: any) {
    return res.status(502).json({ error: classifyFetchError(err, url) });
  }
});

app.post("/v1/history", ...readLimiters, async (req, res) => {
  const body = req.body as { addresses?: string[]; limit?: number };
  const addresses = Array.isArray(body?.addresses) ? body.addresses.filter(Boolean) : [];
  if (!addresses.length) return res.json({ ok: true, txs: [] });
  const base = getPepewApiBaseV1();
  if (!base) return res.status(503).json({ error: "PEPEW_API_BASE not set" });
  const url = `${base}/history`;
  try {
    const { res: r, data } = await fetchJson(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses, limit: body?.limit }),
      },
      12_000
    );
    if (r.ok) {
      const payload = normalizeHistoryPayload(data);
      return res.json({ ...payload, ok: true });
    }
    if (r.status === 404) {
      return res.json({ ok: true, txs: [] });
    }
    return res.status(502).json({ error: data?.error || `upstream ${r.status}` });
  } catch (err: any) {
    return res.status(502).json({ error: classifyFetchError(err, url) });
  }
});

function validFeeRate(rate: any) {
  return typeof rate === "number" && isFinite(rate) && rate > 0;
}

app.get("/wallet/fee/estimate", ...readLimiters, async (_req, res) => {
  const target = Number(process.env.FEE_ESTIMATE_TARGET || "6");
  const fallback = Number(process.env.FEE_ESTIMATE_FALLBACK || "0.0001");
  const { url, headers } = getCoreRpcRequestConfig();
  try {
    const { res: rpcRes, data } = await fetchJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: "fee",
          method: "estimatesmartfee",
          params: [Number.isFinite(target) ? target : 6],
        }),
      },
      5000
    );
    if (!rpcRes.ok || data?.error) {
      return res.json({ feerate: fallback, source: "fallback" });
    }
    const rate = data?.result?.feerate ?? data?.result?.feeRate;
    return res.json({
      feerate: validFeeRate(rate) ? rate : fallback,
      source: validFeeRate(rate) ? "estimatesmartfee" : "fallback",
    });
  } catch {
    return res.json({ feerate: fallback, source: "fallback" });
  }
});

function extractRawTx(body: any) {
  if (typeof body?.rawTx === "string") return body.rawTx;
  if (typeof body?.hex === "string") return body.hex;
  return "";
}

function isDebugRawTxEnabled() {
  return process.env.WALLET_API_DEBUG_RAWTX === "1";
}

function computeTxidFromRawTx(rawTx: string) {
  try {
    const bytes = Buffer.from(rawTx, "hex");
    const hash1 = crypto.createHash("sha256").update(bytes).digest();
    const hash2 = crypto.createHash("sha256").update(hash1).digest();
    return Buffer.from(hash2).reverse().toString("hex");
  } catch {
    return null;
  }
}

async function debugDecodeRawTx(rawTx: string, url: string, headers: Record<string, string>) {
  const tmpPath = "/tmp/rawtx.hex";
  const allowDebugFile = process.env.WALLET_API_DEBUG_RAWTX_FILE === "1";
  if (allowDebugFile) {
    try {
      await fs.writeFile(tmpPath, rawTx, { mode: 0o600 });
      const stat = await fs.stat(tmpPath);
      console.info(`[broadcast] rawTx debug file written path=${tmpPath} bytes=${stat.size}`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`[broadcast] rawTx debug file write failed: ${msg}`);
    }
  }

  try {
    const timeoutMs = Number(process.env.CORE_RPC_TIMEOUT_MS || process.env.CORE_RPC_TIMEOUT || "10000");
    const { res: rpcRes, data } = await fetchJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: "decode",
          method: "decoderawtransaction",
          params: [rawTx],
        }),
      },
      Number.isFinite(timeoutMs) ? timeoutMs : 10000
    );
    if (!data) {
      console.warn(`[broadcast] decoderawtransaction parse failed (status=${rpcRes.status})`);
      return;
    }
    if (!rpcRes.ok) {
      console.warn(`[broadcast] decoderawtransaction HTTP ${rpcRes.status}`);
    }
    if (data?.error) {
      const code = typeof data.error.code === "number" ? data.error.code : undefined;
      const message = typeof data.error.message === "string"
        ? data.error.message
        : typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error);
      console.warn(`[broadcast] decoderawtransaction error ${code ?? "unknown"}: ${message}`);
      return;
    }
    const result = data?.result || {};
    const txid = typeof result.txid === "string" ? result.txid : "n/a";
    const vsize = typeof result.vsize === "number"
      ? result.vsize
      : typeof result.size === "number"
        ? result.size
        : "n/a";
    const vinCount = Array.isArray(result.vin) ? result.vin.length : 0;
    const voutCount = Array.isArray(result.vout) ? result.vout.length : 0;
    console.info(`[broadcast] decoderawtransaction ok txid=${txid} vsize=${vsize} vin=${vinCount} vout=${voutCount}`);
  } catch (err: any) {
    const detail = classifyFetchError(err, url);
    console.warn(`[broadcast] decoderawtransaction request failed: ${detail}`);
  } finally {
    if (allowDebugFile) {
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function handleBroadcast(req: express.Request, res: express.Response) {
  const rawTx = extractRawTx(req.body);
  const minHexLen = 10;
  const rawTxLen = rawTx.length;
  const rawTxHex = /^[0-9a-fA-F]+$/.test(rawTx);
  const rawTxEvenLen = rawTxLen % 2 === 0;
  const rawTxStartsWith0x = rawTx.startsWith("0x") || rawTx.startsWith("0X");
  const rawTxHasNewline = /[\r\n]/.test(rawTx);
  const rawTxHash16 = rawTxHex && rawTxEvenLen && rawTxLen >= minHexLen
    ? crypto.createHash("sha256").update(rawTx, "hex").digest("hex").slice(0, 16)
    : "n/a";
  console.info(
    `[broadcast] RPC request method=sendrawtransaction params=[string] rawTxLen=${rawTxLen} rawTxHex=${rawTxHex} rawTxEvenLen=${rawTxEvenLen} rawTxStartsWith0x=${rawTxStartsWith0x} rawTxHasNewline=${rawTxHasNewline} rawTxHash16=${rawTxHash16}`
  );
  if (!rawTx || !rawTxHex || !rawTxEvenLen || rawTxLen < minHexLen) {
    return res.status(400).json({ error: "invalid rawTx" });
  }
  const { url, headers } = getCoreRpcRequestConfig();
  if (isDebugRawTxEnabled()) {
    await debugDecodeRawTx(rawTx, url, headers);
  }
  try {
    const timeoutMs = Number(process.env.CORE_RPC_TIMEOUT_MS || process.env.CORE_RPC_TIMEOUT || "10000");
    const { res: rpcRes, data } = await fetchJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: "send",
          method: "sendrawtransaction",
          params: [rawTx],
        }),
      },
      Number.isFinite(timeoutMs) ? timeoutMs : 10000
    );
    if (!data) {
      console.error(`[broadcast] RPC response parse failed (status=${rpcRes.status})`);
      return res.status(502).json({ error: "rpc unavailable" });
    }
    if (data?.error) {
      const code = typeof data.error.code === "number" ? data.error.code : undefined;
      const message = typeof data.error.message === "string"
        ? data.error.message
        : typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error);
      console.warn(`[broadcast] RPC error ${code ?? "unknown"}: ${message}`);
      if (code === -22) {
        return res.status(400).json({ error: "invalid rawTx", code, message });
      }
      if (code === -26) {
        if (message.toLowerCase().includes("txn-mempool-conflict")) {
          const txid = computeTxidFromRawTx(rawTx);
          if (txid) {
            console.info(`[broadcast] mempool-conflict treated as ok txid=${txid}`);
            return res.json({ ok: true, txid, note: "already in mempool" });
          }
          console.warn("[broadcast] mempool-conflict but txid compute failed");
          return res.json({ ok: true, note: "already in mempool" });
        }
        return res.status(422).json({ error: "tx rejected", code, message });
      }
      return res.status(502).json({ error: "rpc error", code, message });
    }
    if (!rpcRes.ok) {
      console.error(`[broadcast] RPC HTTP ${rpcRes.status}`);
      return res.status(502).json({ error: "rpc unavailable" });
    }
    const txid = data?.result;
    if (!txid) {
      console.error("[broadcast] RPC missing txid");
      return res.status(502).json({ error: "rpc unavailable" });
    }
    return res.json({ ok: true, txid });
  } catch (err: any) {
    const detail = classifyFetchError(err, url);
    console.error(`[broadcast] RPC request failed: ${detail}`);
    return res.status(502).json({ error: "rpc unavailable" });
  }
}

app.post("/wallet/tx/broadcast", ...txLimiters, handleBroadcast);
app.post("/wallet/tx/send", ...txLimiters, handleBroadcast);
app.post("/api/tx/send", ...txLimiters, handleBroadcast);

// --- Bot Helper Functions ---
function createBotJWT(telegramUserId: string, username?: string): string {
  const payload = {
    telegramUserId,
    username: username || undefined,
  };
  return jwt.sign(payload, jwtSecret, { expiresIn: "30m", subject: telegramUserId });
}

function maskAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function truncateTxid(txid: string): string {
  if (txid.length <= 16) return txid;
  return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
}

function formatSats(sats: number): string {
  return sats.toLocaleString("en-US");
}

function getExplorerUrl(addressOrTxid: string, type: "address" | "tx"): string {
  const base = "https://explorer.pepepow.net";
  if (type === "address") return `${base}/address/${addressOrTxid}`;
  return `${base}/tx/${addressOrTxid}`;
}

async function botFetchJson(url: string, options: any = {}, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json();
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

function getHelpMessage(): string {
  return `**Non-custodial Wallet**
Your keys stay on your device only. We will never ask for your mnemonic or private keys.

**Commands**
/start - Open wallet and see options
/help - Show this help message
/balance - Check your wallet balance
/deposit - Get your deposit address
/send - Send PEPEW (via Mini App)
/history - View recent transactions

**Security**
• Never share your mnemonic phrase
• Always verify addresses before sending
• Keep your device secure`;
}

let bot: Bot | null = null;
if (process.env.BOT_TOKEN) {
  bot = new Bot(process.env.BOT_TOKEN);

  // --- /start Command ---
  bot.command("start", async (ctx) => {
    const webAppUrl = "https://wallet.pepepow.net/mini";
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    const username = typeof ctx.from?.username === "string" ? ctx.from.username : undefined;

    console.info(`[telegram] /start chat=${ctx.chat?.id ?? "unknown"} from=${fromId} username=${username || "none"}`);

    // Upsert user profile
    if (fromId) {
      try {
        upsertUser(fromId, username);
        console.info(`[telegram] /start profile_upsert success tg_user_id=${fromId}`);
      } catch (err: any) {
        console.warn(`[telegram] /start profile_upsert failed tg_user_id=${fromId} error=${err.message}`);
      }
    }

    const keyboard = new InlineKeyboard()
      .webApp("Open Wallet", webAppUrl)
      .row()
      .text("Help & Commands", "help");

    await ctx.reply("Welcome to PEPEPOW Mini Wallet! Use the buttons below to open your wallet or send coins.", {
      reply_markup: keyboard
    });
    console.info(`[telegram] /start command=success tg_user_id=${fromId}`);
  });

  // --- /help Command ---
  bot.command("help", async (ctx) => {
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    console.info(`[telegram] /help from=${fromId}`);

    const webAppUrl = "https://wallet.pepepow.net/mini";
    const keyboard = new InlineKeyboard()
      .webApp("Open Wallet", webAppUrl);

    await ctx.reply(getHelpMessage(), {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
    console.info(`[telegram] /help command=success tg_user_id=${fromId}`);
  });

  // --- /balance Command ---
  bot.command("balance", async (ctx) => {
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    const username = typeof ctx.from?.username === "string" ? ctx.from.username : undefined;
    console.info(`[telegram] /balance from=${fromId}`);

    if (!fromId) {
      await ctx.reply("Unable to identify your Telegram account.");
      return;
    }

    try {
      // Get default address
      const token = createBotJWT(fromId, username);
      const addrRes = await botFetchJson(
        "http://127.0.0.1:9194/v1/address/default",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (!addrRes.res.ok || !addrRes.data?.address) {
        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard().webApp("Set Default Address", webAppUrl);
        await ctx.reply("You haven't set a default address yet. Please open the Mini App and set your default address first.", {
          reply_markup: keyboard
        });
        console.info(`[telegram] /balance command=no_address tg_user_id=${fromId}`);
        return;
      }

      const address = addrRes.data.address;
      const masked = maskAddress(address);

      // Get balance
      const balRes = await botFetchJson(`http://127.0.0.1:9194/wallet/balance?address=${address}`);
      if (!balRes.res.ok) {
        await ctx.reply("Unable to fetch balance. Please try again later.");
        console.warn(`[telegram] /balance command=balance_error tg_user_id=${fromId} status=${balRes.res.status}`);
        return;
      }

      const balData = balRes.data;
      const confirmed = balData.confirmed ?? balData.balance ?? 0;
      const unconfirmed = balData.unconfirmed ?? 0;
      const total = confirmed + unconfirmed;

      const webAppUrl = "https://wallet.pepepow.net/mini";
      const keyboard = new InlineKeyboard()
        .webApp("Open Wallet", webAppUrl)
        .text("Deposit", "deposit")
        .row()
        .text("History", "history");

      await ctx.reply(
        `**Your Balance**\n\nAddress: \`${masked}\`\nConfirmed: ${formatSats(confirmed)} PEPEW\nUnconfirmed: ${formatSats(unconfirmed)} PEPEW\nTotal: ${formatSats(total)} PEPEW`,
        {
          reply_markup: keyboard,
          parse_mode: "Markdown"
        }
      );
      console.info(`[telegram] /balance command=success tg_user_id=${fromId} total=${total}`);
    } catch (err: any) {
      await ctx.reply("An error occurred. Please try again later.");
      console.error(`[telegram] /balance command=error tg_user_id=${fromId} error=${err.message}`);
    }
  });

  // --- /deposit Command ---
  bot.command("deposit", async (ctx) => {
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    const username = typeof ctx.from?.username === "string" ? ctx.from.username : undefined;
    console.info(`[telegram] /deposit from=${fromId}`);

    if (!fromId) {
      await ctx.reply("Unable to identify your Telegram account.");
      return;
    }

    try {
      // Get default address
      const token = createBotJWT(fromId, username);
      const addrRes = await botFetchJson(
        "http://127.0.0.1:9194/v1/address/default",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (!addrRes.res.ok || !addrRes.data?.address) {
        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard().webApp("Set Default Address", webAppUrl);
        await ctx.reply("You haven't set a default address yet. Please open the Mini App and set your default address first.", {
          reply_markup: keyboard
        });
        console.info(`[telegram] /deposit command=no_address tg_user_id=${fromId}`);
        return;
      }

      const address = addrRes.data.address;
      const explorerUrl = getExplorerUrl(address, "address");

      const webAppUrl = "https://wallet.pepepow.net/mini";
      const keyboard = new InlineKeyboard()
        .webApp("Open Wallet", webAppUrl)
        .url("View in Explorer", explorerUrl);

      await ctx.reply(
        `**Deposit Address**\n\nSend PEPEW to this address:\n\`${address}\`\n\nTap to copy, or use the explorer button below.`,
        {
          reply_markup: keyboard,
          parse_mode: "Markdown"
        }
      );
      console.info(`[telegram] /deposit command=success tg_user_id=${fromId}`);
    } catch (err: any) {
      await ctx.reply("An error occurred. Please try again later.");
      console.error(`[telegram] /deposit command=error tg_user_id=${fromId} error=${err.message}`);
    }
  });

  // --- /send Command ---
  bot.command("send", async (ctx) => {
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    console.info(`[telegram] /send from=${fromId}`);

    const webAppUrl = "https://wallet.pepepow.net/mini?tab=send";
    const keyboard = new InlineKeyboard().webApp("Open Send Page", webAppUrl);

    await ctx.reply(
      "Please use the Mini App to send PEPEW. Click the button below to open the Send page.",
      { reply_markup: keyboard }
    );
    console.info(`[telegram] /send command=success tg_user_id=${fromId}`);
  });

  // --- /history Command ---
  bot.command("history", async (ctx) => {
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    const username = typeof ctx.from?.username === "string" ? ctx.from.username : undefined;
    console.info(`[telegram] /history from=${fromId}`);

    if (!fromId) {
      await ctx.reply("Unable to identify your Telegram account.");
      return;
    }

    try {
      // Get default address
      const token = createBotJWT(fromId, username);
      const addrRes = await botFetchJson(
        "http://127.0.0.1:9194/v1/address/default",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (!addrRes.res.ok || !addrRes.data?.address) {
        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard().webApp("Set Default Address", webAppUrl);
        await ctx.reply("You haven't set a default address yet. Please open the Mini App and set your default address first.", {
          reply_markup: keyboard
        });
        console.info(`[telegram] /history command=no_address tg_user_id=${fromId}`);
        return;
      }

      const address = addrRes.data.address;

      // Get history
      const histRes = await botFetchJson(`http://127.0.0.1:9194/wallet/history?address=${address}`);
      if (!histRes.res.ok) {
        await ctx.reply("Unable to fetch transaction history. Please try again later.");
        console.warn(`[telegram] /history command=history_error tg_user_id=${fromId} status=${histRes.res.status}`);
        return;
      }

      const histData = histRes.data;
      const txs = Array.isArray(histData.txs) ? histData.txs : [];

      if (txs.length === 0) {
        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard()
          .webApp("Open Wallet", webAppUrl)
          .text("Balance", "balance");

        await ctx.reply("No transaction history yet.", { reply_markup: keyboard });
        console.info(`[telegram] /history command=no_txs tg_user_id=${fromId}`);
        return;
      }

      // Display last 10 transactions
      const recent = txs.slice(0, 10);
      const lines = recent.map((tx: any, idx: number) => {
        const txid = tx.txid || tx.hash || "unknown";
        const truncated = truncateTxid(txid);
        const amount = typeof tx.value === "number" ? `${tx.value > 0 ? "+" : ""}${formatSats(tx.value)} PEPEW` : "";
        const time = tx.time ? new Date(tx.time * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
        return `${idx + 1}. \`${truncated}\`${amount ? ` ${amount}` : ""}${time ? `\n   ${time}` : ""}`;
      });

      const webAppUrl = "https://wallet.pepepow.net/mini";
      const keyboard = new InlineKeyboard()
        .webApp("Open Wallet", webAppUrl)
        .text("Balance", "balance");

      await ctx.reply(
        `**Recent Transactions**\n\n${lines.join("\n\n")}`,
        {
          reply_markup: keyboard,
          parse_mode: "Markdown"
        }
      );
      console.info(`[telegram] /history command=success tg_user_id=${fromId} txs=${recent.length}`);
    } catch (err: any) {
      await ctx.reply("An error occurred. Please try again later.");
      console.error(`[telegram] /history command=error tg_user_id=${fromId} error=${err.message}`);
    }
  });

  // --- Keep existing /tip and /senduser commands ---
  bot.command(["tip", "senduser"], async (ctx) => {
    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/);
    // /tip @user 1.23 "memo"
    const to = parts[1]; // @username
    const amount = parts[2]; // 1.23
    const memo = parts.slice(3).join(" ");

    if (!to) {
      return ctx.reply("Usage: /tip @username [amount] [memo]");
    }

    const params = new URLSearchParams();
    params.append("to", to);
    if (amount) params.append("amount", amount);
    if (memo) params.append("memo", memo);

    const url = `https://wallet.pepepow.net/send?${params.toString()}`;

    console.info(`[telegram] /tip chat=${ctx.chat?.id ?? "unknown"} from=${ctx.from?.id ?? "unknown"} url=${url}`);
    const keyboard = new InlineKeyboard().webApp("Send Now", url);

    await ctx.reply(`Ready to send to ${to}? Click the button below to complete the payment in the Mini App.`, {
      reply_markup: keyboard
    });
  });

  // --- Callback Query Handler ---
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const fromId = ctx.from?.id ? String(ctx.from.id) : "";
    const username = typeof ctx.from?.username === "string" ? ctx.from.username : undefined;

    console.info(`[telegram] callback_query from=${fromId} data=${data}`);

    if (data === "help") {
      const webAppUrl = "https://wallet.pepepow.net/mini";
      const keyboard = new InlineKeyboard().webApp("Open Wallet", webAppUrl);

      await ctx.editMessageText(getHelpMessage(), {
        reply_markup: keyboard,
        parse_mode: "Markdown"
      });
      await ctx.answerCallbackQuery();
      console.info(`[telegram] callback_query callback=help result=success tg_user_id=${fromId}`);
      return;
    }

    if (data === "balance") {
      if (!fromId) {
        await ctx.answerCallbackQuery({ text: "Unable to identify your account" });
        return;
      }

      try {
        const token = createBotJWT(fromId, username);
        const addrRes = await botFetchJson(
          "http://127.0.0.1:9194/v1/address/default",
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (!addrRes.res.ok || !addrRes.data?.address) {
          const webAppUrl = "https://wallet.pepepow.net/mini";
          const keyboard = new InlineKeyboard().webApp("Set Default Address", webAppUrl);
          await ctx.editMessageText("You haven't set a default address yet. Please open the Mini App and set your default address first.", {
            reply_markup: keyboard
          });
          await ctx.answerCallbackQuery();
          console.info(`[telegram] callback_query callback=balance result=no_address tg_user_id=${fromId}`);
          return;
        }

        const address = addrRes.data.address;
        const masked = maskAddress(address);

        const balRes = await botFetchJson(`http://127.0.0.1:9194/wallet/balance?address=${address}`);
        if (!balRes.res.ok) {
          await ctx.answerCallbackQuery({ text: "Unable to fetch balance" });
          console.warn(`[telegram] callback_query callback=balance result=error tg_user_id=${fromId}`);
          return;
        }

        const balData = balRes.data;
        const confirmed = balData.confirmed ?? balData.balance ?? 0;
        const unconfirmed = balData.unconfirmed ?? 0;
        const total = confirmed + unconfirmed;

        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard()
          .webApp("Open Wallet", webAppUrl)
          .text("Deposit", "deposit")
          .row()
          .text("History", "history");

        await ctx.editMessageText(
          `**Your Balance**\n\nAddress: \`${masked}\`\nConfirmed: ${formatSats(confirmed)} PEPEW\nUnconfirmed: ${formatSats(unconfirmed)} PEPEW\nTotal: ${formatSats(total)} PEPEW`,
          {
            reply_markup: keyboard,
            parse_mode: "Markdown"
          }
        );
        await ctx.answerCallbackQuery();
        console.info(`[telegram] callback_query callback=balance result=success tg_user_id=${fromId}`);
      } catch (err: any) {
        await ctx.answerCallbackQuery({ text: "An error occurred" });
        console.error(`[telegram] callback_query callback=balance result=error tg_user_id=${fromId} error=${err.message}`);
      }
      return;
    }

    if (data === "deposit") {
      if (!fromId) {
        await ctx.answerCallbackQuery({ text: "Unable to identify your account" });
        return;
      }

      try {
        const token = createBotJWT(fromId, username);
        const addrRes = await botFetchJson(
          "http://127.0.0.1:9194/v1/address/default",
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (!addrRes.res.ok || !addrRes.data?.address) {
          const webAppUrl = "https://wallet.pepepow.net/mini";
          const keyboard = new InlineKeyboard().webApp("Set Default Address", webAppUrl);
          await ctx.editMessageText("You haven't set a default address yet. Please open the Mini App and set your default address first.", {
            reply_markup: keyboard
          });
          await ctx.answerCallbackQuery();
          console.info(`[telegram] callback_query callback=deposit result=no_address tg_user_id=${fromId}`);
          return;
        }

        const address = addrRes.data.address;
        const explorerUrl = getExplorerUrl(address, "address");

        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard()
          .webApp("Open Wallet", webAppUrl)
          .url("View in Explorer", explorerUrl);

        await ctx.editMessageText(
          `**Deposit Address**\n\nSend PEPEW to this address:\n\`${address}\`\n\nTap to copy, or use the explorer button below.`,
          {
            reply_markup: keyboard,
            parse_mode: "Markdown"
          }
        );
        await ctx.answerCallbackQuery();
        console.info(`[telegram] callback_query callback=deposit result=success tg_user_id=${fromId}`);
      } catch (err: any) {
        await ctx.answerCallbackQuery({ text: "An error occurred" });
        console.error(`[telegram] callback_query callback=deposit result=error tg_user_id=${fromId} error=${err.message}`);
      }
      return;
    }

    if (data === "history") {
      if (!fromId) {
        await ctx.answerCallbackQuery({ text: "Unable to identify your account" });
        return;
      }

      try {
        const token = createBotJWT(fromId, username);
        const addrRes = await botFetchJson(
          "http://127.0.0.1:9194/v1/address/default",
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (!addrRes.res.ok || !addrRes.data?.address) {
          const webAppUrl = "https://wallet.pepepow.net/mini";
          const keyboard = new InlineKeyboard().webApp("Set Default Address", webAppUrl);
          await ctx.editMessageText("You haven't set a default address yet. Please open the Mini App and set your default address first.", {
            reply_markup: keyboard
          });
          await ctx.answerCallbackQuery();
          console.info(`[telegram] callback_query callback=history result=no_address tg_user_id=${fromId}`);
          return;
        }

        const address = addrRes.data.address;

        const histRes = await botFetchJson(`http://127.0.0.1:9194/wallet/history?address=${address}`);
        if (!histRes.res.ok) {
          await ctx.answerCallbackQuery({ text: "Unable to fetch history" });
          console.warn(`[telegram] callback_query callback=history result=error tg_user_id=${fromId}`);
          return;
        }

        const histData = histRes.data;
        const txs = Array.isArray(histData.txs) ? histData.txs : [];

        if (txs.length === 0) {
          const webAppUrl = "https://wallet.pepepow.net/mini";
          const keyboard = new InlineKeyboard()
            .webApp("Open Wallet", webAppUrl)
            .text("Balance", "balance");

          await ctx.editMessageText("No transaction history yet.", { reply_markup: keyboard });
          await ctx.answerCallbackQuery();
          console.info(`[telegram] callback_query callback=history result=no_txs tg_user_id=${fromId}`);
          return;
        }

        const recent = txs.slice(0, 10);
        const lines = recent.map((tx: any, idx: number) => {
          const txid = tx.txid || tx.hash || "unknown";
          const truncated = truncateTxid(txid);
          const amount = typeof tx.value === "number" ? `${tx.value > 0 ? "+" : ""}${formatSats(tx.value)} PEPEW` : "";
          const time = tx.time ? new Date(tx.time * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
          return `${idx + 1}. \`${truncated}\`${amount ? ` ${amount}` : ""}${time ? `\n   ${time}` : ""}`;
        });

        const webAppUrl = "https://wallet.pepepow.net/mini";
        const keyboard = new InlineKeyboard()
          .webApp("Open Wallet", webAppUrl)
          .text("Balance", "balance");

        await ctx.editMessageText(
          `**Recent Transactions**\n\n${lines.join("\n\n")}`,
          {
            reply_markup: keyboard,
            parse_mode: "Markdown"
          }
        );
        await ctx.answerCallbackQuery();
        console.info(`[telegram] callback_query callback=history result=success tg_user_id=${fromId}`);
      } catch (err: any) {
        await ctx.answerCallbackQuery({ text: "An error occurred" });
        console.error(`[telegram] callback_query callback=history result=error tg_user_id=${fromId} error=${err.message}`);
      }
      return;
    }

    // Unknown callback
    await ctx.answerCallbackQuery({ text: "Unknown action" });
  });

  const webhookSecret = (process.env.BOT_SECRET_TOKEN || "").trim();
  const tgWebhook = webhookSecret
    ? webhookCallback(bot!, "express", { secretToken: webhookSecret })
    : webhookCallback(bot!, "express");
  app.post("/tg/webhook", (req, res, next) => {
    const secretHeader = req.get("x-telegram-bot-api-secret-token");
    const providedSecret = typeof secretHeader === "string" ? secretHeader.trim() : "";
    if (webhookSecret && providedSecret !== webhookSecret) {
      return res.sendStatus(403);
    }
    const update = req.body || {};
    const updateId = update?.update_id;
    const messageText = update?.message?.text || update?.edited_message?.text || "";
    const callbackData = update?.callback_query?.data || "";
    const fromId = update?.message?.from?.id
      ?? update?.callback_query?.from?.id
      ?? update?.edited_message?.from?.id
      ?? update?.inline_query?.from?.id
      ?? update?.chosen_inline_result?.from?.id
      ?? "unknown";
    const sanitize = (value: string) => value.replace(/\s+/g, " ").slice(0, 200);
    const payload = messageText
      ? `message="${sanitize(messageText)}"`
      : callbackData
        ? `callback="${sanitize(callbackData)}"`
        : "no_message";
    if (updateId !== undefined) {
      console.info(`[telegram] update_id=${updateId} from=${fromId} ${payload}`);
    }
    return Promise.resolve(tgWebhook(req, res)).catch(next);
  });
}


// --- Price (CoinMarketCap) ---
async function handlePrice(req: express.Request, res: express.Response) {
  const { symbol, convert } = req.query;

  // Allowlist check
  if (symbol && symbol !== "PEPEW") {
    return res.status(400).json({ error: "Invalid symbol. Only PEPEW is supported." });
  }
  if (convert && convert !== "USD") {
    return res.status(400).json({ error: "Invalid convert. Only USD is supported." });
  }

  const payload = await getCmcPriceCached();
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.json(payload);
}

app.get("/v1/price", handlePrice);
app.get("/wallet/price", handlePrice);
app.get("/api/price", handlePrice);

const port = Number(process.env.PORT || 9194);
app.listen(port, () => {
  console.log(`Wallet API running on :${port}`);
  void (async () => {
    // Initial price fetch
    void fetchCmcPrice();
    // Background refresh every 10 minutes
    setInterval(() => {
      void fetchCmcPrice();
    }, 10 * 60 * 1000);

    const status = await checkDependencies(true);
    if (status.ok) {
      console.log("[startup] Dependency checks ok");
    } else {
      const errors = summarizeDependencyErrors(status.deps);
      console.error(`[startup] Dependency checks failed: ${errors.join("; ")}`);
    }
  })();
});

// --- Payment Link (JWT-signed, stateless) ---
app.post("/api/paylink/create", (req, res) => {
  const { address, amount, memo } = req.body || {};
  if (!address) return res.status(400).json({ error: "address required" });
  const payload = { address, amount: Number(amount || 0), memo: String(memo || "") };
  const token = jwt.sign(payload, (process.env.JWT_SECRET || "changeme"), { expiresIn: "7d" });
  const urlBase = process.env.WALLET_BASE_URL || "https://wallet.pepepow.net";
  return res.json({ token, url: `${urlBase}/pay/${encodeURIComponent(token)}` });
});

app.get("/api/paylink/verify", (req, res) => {
  const token = String(req.query.token || "");
  try {
    const payload = jwt.verify(token, (process.env.JWT_SECRET || "changeme"));
    res.json(payload);
  } catch {
    res.status(400).json({ error: "invalid token" });
  }
});


function isValidTxid(txid: string) {
  return /^[0-9a-fA-F]{64}$/.test(txid);
}

function wantsJson(req: express.Request) {
  const accept = String(req.headers.accept || "");
  return accept.includes("application/json");
}

async function handleRawTx(req: express.Request, res: express.Response) {
  const txid = String(req.query.txid || req.params.txid || "");
  if (!isValidTxid(txid)) return res.status(400).json({ error: "txid invalid" });

  const base = getPepewApiBaseV1();
  const url = base ? `${base}/tx/${txid}` : "";
  let lastError = "";
  const startAt = Date.now();

  // 1) Try upstream pepew-api
  if (url) {
    try {
      const { res: apiRes, data } = await fetchJson(url, { method: "GET" }, 15000);
      const elapsed = Date.now() - startAt;
      if (apiRes.ok && data) {
        const hex = typeof data?.hex === "string"
          ? data.hex
          : typeof data?.result?.hex === "string"
            ? data.result.hex
            : null;
        if (hex) {
          console.info(`[rawtx] indexer ok timing=${elapsed}ms txid=${txid}`);
          if (wantsJson(req)) return res.json({ txid, hex });
          return res.type("text/plain").send(hex);
        }
      }
      if (apiRes.status !== 404) {
        lastError = `upstream ${apiRes.status}`;
      }
    } catch (err: any) {
      lastError = classifyFetchError(err, url);
      console.warn(`[rawtx] indexer failed timing=${Date.now() - startAt}ms txid=${txid} err=${lastError}`);
    }
  }

  // 2) Fallback to direct Node RPC
  const rpcStartAt = Date.now();
  try {
    const { url: rpcUrl, headers } = getCoreRpcRequestConfig();
    const { res: rpcRes, data } = await fetchJson(
      rpcUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: "rawtx",
          method: "getrawtransaction",
          params: [txid, 0], // use integer 0 instead of boolean false
        }),
      },
      15000
    );

    const elapsed = Date.now() - rpcStartAt;
    if (rpcRes.ok && data?.result) {
      const hex = data.result;
      console.info(`[rawtx] rpc ok timing=${elapsed}ms txid=${txid}`);
      if (wantsJson(req)) return res.json({ txid, hex });
      return res.type("text/plain").send(hex);
    }

    if (data?.error) {
      const detail = data.error.message || JSON.stringify(data.error);
      if (rpcRes.status === 404 || /not found/i.test(detail)) {
        return res.status(404).json({ error: "tx not found" });
      }
      lastError = lastError ? `${lastError}; RPC: ${detail}` : `RPC: ${detail}`;
    } else if (!rpcRes.ok) {
      lastError = lastError ? `${lastError}; RPC HTTP ${rpcRes.status}` : `RPC HTTP ${rpcRes.status}`;
    }
  } catch (err: any) {
    const rpcErr = classifyFetchError(err, "rpc");
    const elapsed = Date.now() - rpcStartAt;
    console.warn(`[rawtx] rpc failed timing=${elapsed}ms txid=${txid} err=${rpcErr}`);
    if (err.name === "AbortError" || rpcErr.includes("timeout")) {
      return res.status(504).json({ error: "rpc_timeout", txid, hint: "Node RPC is busy, please try later." });
    }
    lastError = lastError ? `${lastError}; RPC: ${rpcErr}` : rpcErr;
  }

  return res.status(502).json({ error: lastError || "failed to fetch raw tx" });
}

app.get("/wallet/tx/raw", ...readLimiters, handleRawTx);
app.get("/api/tx/raw", ...readLimiters, handleRawTx);
app.get("/v1/tx/:txid", ...readLimiters, handleRawTx);
app.get("/wallet/tx/:txid", ...readLimiters, handleRawTx);
