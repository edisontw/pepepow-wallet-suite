import express from "express";
import crypto from "crypto";
import { promises as fs } from "fs";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { webhookCallback, Bot } from "grammy";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";

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
} = process.env as Record<string,string>;

const corsOrigins = (CORS_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
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
  symbol: string;
  convert: string;
  price: number | null;
  source: "coinmarketcap";
  updatedAt: string;
  error: string | null;
};

const priceCache: { value: PriceResponse | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

async function getCmcPriceCached(): Promise<PriceResponse> {
  const now = Date.now();
  if (priceCache.value && priceCache.expiresAt > now) return priceCache.value;

  const apiKey = process.env.CMC_API_KEY;
  const symbol = process.env.CMC_SYMBOL || "PEPEW";
  const convert = process.env.CMC_CONVERT || "USD";
  const updatedAt = new Date().toISOString();
  const base: PriceResponse = {
    symbol,
    convert,
    price: null,
    source: "coinmarketcap",
    updatedAt,
    error: null,
  };

  if (!apiKey) {
    const payload = { ...base, error: "CMC_API_KEY not set" };
    priceCache.value = payload;
    priceCache.expiresAt = now + 60_000;
    return payload;
  }

  const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(symbol)}&convert=${encodeURIComponent(convert)}`;
  console.info(`[cmc] request URL: ${url}`);

  try {
    const { res: r, data } = await fetchJson<any>(
      url,
      {
        method: "GET",
        headers: {
          "Accepts": "application/json",
          "X-CMC_PRO_API_KEY": apiKey,
        },
      },
      8000
    );
    if (!r.ok) {
      const detail = data?.status?.error_message || data?.error || data?.status?.error_code || r.statusText;
      const detailText = typeof detail === "string"
        ? detail
        : typeof detail === "number"
          ? String(detail)
          : detail
            ? JSON.stringify(detail)
            : "";
      const payload = { ...base, error: `HTTP ${r.status}${detailText ? ` ${detailText}` : ""}` };
      priceCache.value = payload;
      priceCache.expiresAt = now + 60_000;
      return payload;
    }

    const price = data?.data?.[symbol]?.quote?.[convert]?.price;
    if (typeof price !== "number") {
      const payload = { ...base, error: "CMC missing price" };
      priceCache.value = payload;
      priceCache.expiresAt = now + 60_000;
      return payload;
    }

    const payload = { ...base, price };
    priceCache.value = payload;
    priceCache.expiresAt = now + 60_000;
    return payload;
  } catch (err: any) {
    const payload = { ...base, error: classifyFetchError(err, url) };
    priceCache.value = payload;
    priceCache.expiresAt = now + 60_000;
    return payload;
  }
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

async function fetchJson<T = any>(url: string, options: any = {}, timeoutMs = 5000) {
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
      5000
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

const addrSchema = z.string().min(26).max(64).regex(/^P[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/,"address format invalid");

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

app.get("/wallet/balance", ...readLimiters, async (req, res) => {
  const address = req.query.address as string;
  try { addrSchema.parse(address); } catch (e:any) { return res.status(400).json({ error: "address invalid" }); }
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
  try { addrSchema.parse(address); } catch (e:any) { return res.status(400).json({ error: "address invalid" }); }
  const base = getPepewApiBaseV1();
  if (!base) return res.status(503).json({ error: "PEPEW_API_BASE not set" });
  const url = `${base}/addr/${address}/utxos`;
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
  try { addrSchema.parse(address); } catch (e:any) { return res.status(400).json({ error: "address invalid" }); }
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

async function debugDecodeRawTx(rawTx: string, url: string, headers: Record<string, string>) {
  const tmpPath = "/tmp/rawtx.hex";
  try {
    await fs.writeFile(tmpPath, rawTx, { mode: 0o600 });
    const stat = await fs.stat(tmpPath);
    console.info(`[broadcast] rawTx debug file written path=${tmpPath} bytes=${stat.size}`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn(`[broadcast] rawTx debug file write failed: ${msg}`);
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
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
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

let bot: Bot | null = null;
if (process.env.BOT_TOKEN) {
  bot = new Bot(process.env.BOT_TOKEN);
  bot.command("start", async (ctx) => {
    await ctx.reply("Welcome to PEPEPOW Mini Wallet! Use the WebApp button.", {
      reply_markup: {
        inline_keyboard: [[{ text: "Open Wallet", web_app: { url: "https://wallet.pepepow.net/mini" } }]]
      }
    });
  });
  const tgWebhook = webhookCallback(bot!, "express");
  app.post("/tg/webhook", (req, res, next) => {
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (process.env.BOT_SECRET_TOKEN && secret !== process.env.BOT_SECRET_TOKEN) {
      return res.sendStatus(403);
    }
    return Promise.resolve(tgWebhook(req, res)).catch(next);
  });
}


async function handlePrice(req: express.Request, res: express.Response) {
  const payload = await getCmcPriceCached();
  return res.json(payload);
}

// --- Price (CoinMarketCap) ---
app.get("/wallet/price", handlePrice);
app.get("/api/price", handlePrice);

const port = Number(process.env.PORT || 9194);
app.listen(port, () => {
  console.log(`Wallet API running on :${port}`);
  void (async () => {
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
  const payload = { address, amount: Number(amount||0), memo: String(memo||"") };
  const token = jwt.sign(payload, (process.env.JWT_SECRET || "changeme"), { expiresIn: "7d" });
  const urlBase = process.env.WALLET_BASE_URL || "https://wallet.pepepow.net";
  return res.json({ token, url: `${urlBase}/pay/${encodeURIComponent(token)}` });
});

app.get("/api/paylink/verify", (req, res) => {
  const token = String(req.query.token||"");
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
  if (!base) return res.status(503).json({ error: "PEPEW_API_BASE not set" });
  const url = `${base}/tx/${txid}`;
  try {
    const { res: apiRes, data } = await fetchJson(url, { method: "GET" }, 8000);
    if (!apiRes.ok) {
      const detail = typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
          ? data.message
          : "";
      if (apiRes.status === 404 || /no such mempool or blockchain transaction|not found/i.test(detail)) {
        return res.status(404).json({ error: "tx not found" });
      }
      return res.status(502).json({ error: detail || `upstream ${apiRes.status}` });
    }
    if (!data) {
      return res.status(502).json({ error: "upstream parse error" });
    }
    const hex = typeof data?.hex === "string"
      ? data.hex
      : typeof data?.result?.hex === "string"
        ? data.result.hex
        : null;
    if (!hex) {
      return res.status(502).json({ error: "upstream missing hex" });
    }
    if (wantsJson(req)) {
      return res.json({ txid, hex });
    }
    return res.type("text/plain").send(hex);
  } catch (err: any) {
    const detail = classifyFetchError(err, url);
    console.error(`[rawtx] upstream request failed: ${detail}`);
    return res.status(502).json({ error: detail });
  }
}

app.get("/wallet/tx/raw", ...readLimiters, handleRawTx);
app.get("/api/tx/raw", ...readLimiters, handleRawTx);
app.get("/wallet/tx/:txid", ...readLimiters, handleRawTx);
