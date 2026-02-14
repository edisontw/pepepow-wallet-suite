import Database from "better-sqlite3";
import path from "path";
import { normalizePairSymbol } from "./lib/markets.js";
import { tradeAuditLog } from "./lib/tradeLogger.js";

const dbPath = process.env.TRADE_DB_PATH || path.join(process.cwd(), "trade.db");

const db = new Database(dbPath);

// SQLite safety settings for shared access
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

// Create trade-specific tables (idempotent)
db.exec(`
  CREATE TABLE IF NOT EXISTS grid_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    side TEXT NOT NULL,
    price_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_grid_order_config ON grid_order(config_id, status);
  CREATE INDEX IF NOT EXISTS idx_grid_order_lookup ON grid_order(config_id, side, price_key, status);
`+ `
  CREATE TABLE IF NOT EXISTS trade_dca_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    symbol TEXT NOT NULL,
    trade_mode TEXT NOT NULL,
    strategy TEXT NOT NULL DEFAULT 'DCA',
    quote_ccy TEXT NOT NULL,
    budget REAL NOT NULL,
    interval_sec INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_dca_unique
  ON trade_dca_config(tg_user_id, exchange, pair, trade_mode);

  CREATE TABLE IF NOT EXISTS trade_order_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quote_amount REAL NOT NULL,
    price REAL,
    status TEXT NOT NULL,
    trade_mode TEXT NOT NULL,
    strategy TEXT NOT NULL DEFAULT 'DCA',
    raw_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_order_user_time
  ON trade_order_log(tg_user_id, created_at);

  CREATE TABLE IF NOT EXISTS trade_strategy_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    trade_mode TEXT NOT NULL,
    strategy TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    params_json TEXT NOT NULL,
    notes TEXT,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_strategy_unique
  ON trade_strategy_config(tg_user_id, exchange, pair, trade_mode, strategy);

  CREATE INDEX IF NOT EXISTS idx_trade_strategy_user_time
  ON trade_strategy_config(tg_user_id, updated_at);

  CREATE TABLE IF NOT EXISTS trade_strategy_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER NOT NULL,
    tg_user_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    strategy TEXT NOT NULL,
    trade_mode TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL,
    qty REAL,
    quote_qty REAL,
    status TEXT NOT NULL,
    exchange_order_id TEXT,
    client_order_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_strategy_order_config
  ON trade_strategy_order(config_id, status);

  CREATE INDEX IF NOT EXISTS idx_trade_strategy_order_user_time
  ON trade_strategy_order(tg_user_id, created_at);

  CREATE TABLE IF NOT EXISTS trade_strategy_fill (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    config_id INTEGER NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    fee REAL,
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_strategy_fill_config
  ON trade_strategy_fill(config_id, ts);

  CREATE TABLE IF NOT EXISTS trade_strategy_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    level TEXT,
    message TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_strategy_event_config
  ON trade_strategy_event(config_id, ts);

  CREATE TABLE IF NOT EXISTS trade_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    action TEXT NOT NULL,
    side TEXT,
    price REAL,
    qty REAL,
    order_id TEXT,
    reason TEXT,
    latency_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_trade_audit_ts
  ON trade_audit(ts);

  CREATE INDEX IF NOT EXISTS idx_trade_audit_strategy_ts
  ON trade_audit(strategy_id, ts);

  CREATE INDEX IF NOT EXISTS idx_trade_audit_action_ts
  ON trade_audit(action, ts);

  CREATE TABLE IF NOT EXISTS exchange_key (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    key_cipher TEXT NOT NULL,
    secret_cipher TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_key_unique
  ON exchange_key(tg_user_id, exchange);

  CREATE TABLE IF NOT EXISTS strategy_failure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    last_http_status INTEGER,
    last_exchange_code TEXT,
    UNIQUE(config_id, category, message)
  );

  CREATE INDEX IF NOT EXISTS idx_strategy_failure_config
  ON strategy_failure(config_id, last_seen_at);

  CREATE TABLE IF NOT EXISTS strategy_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    pair TEXT NOT NULL,
    order_id TEXT NOT NULL,
    client_order_id TEXT,
    side TEXT NOT NULL,
    price TEXT,
    qty TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(exchange, order_id)
  );

  CREATE INDEX IF NOT EXISTS idx_strategy_order_strategy_status ON strategy_order(strategy_id, status);
  CREATE INDEX IF NOT EXISTS idx_strategy_order_lookup ON strategy_order(exchange, pair);
`);

// DevMM (Dev Fee Market Making) tables
db.exec(`
  CREATE TABLE IF NOT EXISTS devmm_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    tg_user_id TEXT,
    symbol TEXT NOT NULL DEFAULT 'PEPEW/USDT',
    min_notional_usdt REAL NOT NULL,
    order_quote_usdt REAL NOT NULL,
    buy_offset_pct REAL NOT NULL DEFAULT 0.02,
    sell_offset_pct REAL NOT NULL DEFAULT 0.01,
    refresh_seconds INTEGER NOT NULL DEFAULT 45,
    refresh_jitter_seconds INTEGER NOT NULL DEFAULT 15,
    cooldown_minutes INTEGER NOT NULL DEFAULT 15,
    cap_ratio REAL NOT NULL DEFAULT 0.10,
    cap_day_min_usdt REAL NOT NULL DEFAULT 10,
    inventory_target_usdt_share REAL NOT NULL DEFAULT 0.20,
    inventory_min_usdt_share REAL NOT NULL DEFAULT 0.10,
    inventory_resume_usdt_share REAL NOT NULL DEFAULT 0.15,
    inventory_max_usdt_share REAL NOT NULL DEFAULT 0.30,
    trend_guard_pct REAL NOT NULL DEFAULT 0.08,
    trend_pause_minutes INTEGER NOT NULL DEFAULT 60,
    spread_min_pct REAL NOT NULL DEFAULT 0.002,
    spread_max_pct REAL NOT NULL DEFAULT 0.03,
    is_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(exchange, symbol)
  );

  CREATE TABLE IF NOT EXISTS devmm_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'PEPEW/USDT',
    status TEXT NOT NULL DEFAULT 'STOPPED',
    pause_reason TEXT,
    last_action TEXT,
    last_action_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    used_turnover_today_usdt REAL NOT NULL DEFAULT 0,
    used_turnover_hour_usdt REAL NOT NULL DEFAULT 0,
    hour_bucket TEXT,
    day_bucket TEXT,
    last_bid REAL,
    last_ask REAL,
    last_mid REAL,
    last_ref REAL,
    usdt_balance REAL,
    pepew_balance REAL,
    usdt_share REAL,
    open_buy_order_id TEXT,
    open_sell_order_id TEXT,
    cooldown_until INTEGER,
    vol24h_usdt REAL,
    vol24h_updated_at INTEGER,
    ref_samples TEXT,
    last_tick_at INTEGER,
    last_decision TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(exchange, symbol)
  );

  CREATE TABLE IF NOT EXISTS devmm_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    qty_pepew REAL NOT NULL,
    quote_usdt REAL NOT NULL,
    fee_usdt REAL,
    order_id TEXT,
    trade_id TEXT,
    day_bucket TEXT NOT NULL,
    week_bucket TEXT NOT NULL,
    month_bucket TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_devmm_fills_day ON devmm_fills(exchange, day_bucket);
  CREATE INDEX IF NOT EXISTS idx_devmm_fills_week ON devmm_fills(exchange, week_bucket);
  CREATE INDEX IF NOT EXISTS idx_devmm_fills_month ON devmm_fills(exchange, month_bucket);
  CREATE INDEX IF NOT EXISTS idx_devmm_fills_ts ON devmm_fills(exchange, ts);
`);

// Migration: add tg_user_id column to devmm_config if it doesn't exist
try {
    const columns = db.prepare("PRAGMA table_info(devmm_config)").all() as { name: string }[];
    const hasTgUserId = columns.some(col => col.name === "tg_user_id");
    if (!hasTgUserId) {
        db.exec("ALTER TABLE devmm_config ADD COLUMN tg_user_id TEXT");
        console.log("[db] Migration: added tg_user_id column to devmm_config");
    }
} catch (e) {
    console.warn("[db] Migration check for devmm_config tg_user_id failed:", e);
}

// Migration: add symbol to devmm_state if it doesn't exist (previously it might have been missing or just exchange was unique)
try {
    const columns = db.prepare("PRAGMA table_info(devmm_state)").all() as { name: string }[];
    const hasSymbol = columns.some(col => col.name === "symbol");
    if (!hasSymbol) {
        db.exec("ALTER TABLE devmm_state ADD COLUMN symbol TEXT NOT NULL DEFAULT 'PEPEW/USDT'");
        console.log("[db] Migration: added symbol column to devmm_state");
    }
} catch (e) {
    console.warn("[db] Migration check for devmm_state symbol failed:", e);
}

// Migration: Ensure UNIQUE(exchange, symbol) index exists for devmm_config and devmm_state
try {
    // We check if the unique constraint/index on just 'exchange' exists and try to replace it or just add the new one.
    // In SQLite, adding a new unique index is safer than trying to drop the old one if it was part of CREATE TABLE.
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_devmm_config_exchange_symbol ON devmm_config(exchange, symbol);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_devmm_state_exchange_symbol ON devmm_state(exchange, symbol);
    `);
    console.log("[db] Migration: Ensure unique indexes (exchange, symbol) exist for DevMM");
} catch (e) {
    console.warn("[db] Migration: failed to create unique indexes for DevMM:", e);
}

// Migration: add last_tick_at and last_decision to devmm_state if they don't exist
try {
    const columns = db.prepare("PRAGMA table_info(devmm_state)").all() as { name: string }[];
    const hasLastTickAt = columns.some(col => col.name === "last_tick_at");
    if (!hasLastTickAt) {
        db.exec("ALTER TABLE devmm_state ADD COLUMN last_tick_at INTEGER");
        db.exec("ALTER TABLE devmm_state ADD COLUMN last_decision TEXT");
        console.log("[db] Migration: added last_tick_at and last_decision columns to devmm_state");
    }
} catch (e) {
    console.warn("[db] Migration check for devmm_state tick info failed:", e);
}

console.log(`[db] Opened database at ${dbPath}`);

function migrateLegacyDcaConfigs(): void {
    const legacyRows = db.prepare("SELECT * FROM trade_dca_config").all() as LegacyTradeDcaConfig[];
    if (!legacyRows.length) return;

    const insert = db.prepare(`
        INSERT OR IGNORE INTO trade_strategy_config
        (tg_user_id, exchange, pair, trade_mode, strategy, enabled, params_json, notes, last_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `);

    let migrated = 0;
    for (const row of legacyRows) {
        const paramsJson = JSON.stringify({
            budget: row.budget,
            intervalSec: row.interval_sec,
            quoteCcy: row.quote_ccy,
            symbol: row.symbol,
        });
        const result = insert.run(
            row.tg_user_id,
            row.exchange,
            row.pair,
            row.trade_mode,
            row.strategy || "DCA",
            row.enabled ?? 0,
            paramsJson,
            row.last_run_at,
            row.created_at,
            row.updated_at
        );
        if (result.changes > 0) migrated += 1;
    }

    if (migrated > 0) {
        console.log(`[db] Migrated ${migrated} legacy DCA config(s) to trade_strategy_config`);
    }
}

migrateLegacyDcaConfigs();

function migrateStrategyConfigSchema(): void {
    const columns = db.prepare("PRAGMA table_info(trade_strategy_config)").all() as any[];
    const hasNextAllowedAt = columns.some((c) => c.name === "next_allowed_at");

    if (!hasNextAllowedAt) {
        db.exec(`
            ALTER TABLE trade_strategy_config ADD COLUMN next_allowed_at INTEGER;
            ALTER TABLE trade_strategy_config ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
            ALTER TABLE trade_strategy_config ADD COLUMN disabled_reason TEXT;
        `);
        console.log("[db] Added backoff/failure columns to trade_strategy_config");
    }
}

migrateStrategyConfigSchema();

function migrateStrategyFailureSchema(): void {
    const columns = db.prepare("PRAGMA table_info(strategy_failure)").all() as any[];
    const hasDetails = columns.some((c) => c.name === "details_json");
    if (!hasDetails) {
        db.exec("ALTER TABLE strategy_failure ADD COLUMN details_json TEXT");
        console.log("[db] Added details_json to strategy_failure");
    }
}

migrateStrategyFailureSchema();

function migrateStrategyOrderSchema(): void {
    const columns = db.prepare("PRAGMA table_info(trade_strategy_order)").all() as any[];
    const hasExchangeOrderId = columns.some((c) => c.name === "exchange_order_id");
    const hasClientOrderId = columns.some((c) => c.name === "client_order_id");

    if (!hasExchangeOrderId) {
        db.exec("ALTER TABLE trade_strategy_order ADD COLUMN exchange_order_id TEXT");
        console.log("[db] Added exchange_order_id to trade_strategy_order");
    }
    if (!hasClientOrderId) {
        db.exec("ALTER TABLE trade_strategy_order ADD COLUMN client_order_id TEXT");
        console.log("[db] Added client_order_id to trade_strategy_order");
    }
}

migrateStrategyOrderSchema();

function migratePaperToReal(): void {
    const tables = [
        "trade_dca_config",
        "trade_order_log",
        "trade_strategy_config",
        "trade_strategy_order"
    ];

    for (const table of tables) {
        try {
            const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
            if (!tableExists) continue;

            const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE trade_mode = 'PAPER'`).get() as { count: number };
            if (countResult.count > 0) {
                const result = db.prepare(`UPDATE ${table} SET trade_mode = 'REAL' WHERE trade_mode = 'PAPER'`).run();
                console.log(`[db] Migrated ${result.changes} records from PAPER to REAL in table ${table}`);
            }
        } catch (err) {
            console.error(`[db] Failed to migrate table ${table}:`, err);
        }
    }
}

migratePaperToReal();

export function getDbPath(): string {
    return dbPath;
}

// Types
export interface TradeDcaConfig {
    id: number;
    tg_user_id: string;
    exchange: string;
    pair: string;
    symbol: string;
    trade_mode: string;
    strategy: string;
    quote_ccy: string;
    budget: number;
    interval_sec: number;
    enabled: number;
    last_run_at: number | null;
    created_at: number;
    updated_at: number;
    max_total_spend?: number | null;
    ends_at?: number | null;
}

export interface TradeOrderLog {
    id: number;
    tg_user_id: string;
    exchange: string;
    pair: string;
    symbol: string;
    side: string;
    quote_amount: number;
    price: number | null;
    status: string;
    trade_mode: string;
    strategy: string;
    raw_json: string | null;
    created_at: number;
}

export interface StrategyConfig {
    id: number;
    tg_user_id: string;
    exchange: string;
    pair: string;
    trade_mode: string;
    strategy: string;
    enabled: number;
    params_json: string;
    notes: string | null;
    last_run_at: number | null;
    created_at: number;
    updated_at: number;
    next_allowed_at?: number | null;
    consecutive_failures?: number;
    disabled_reason?: string | null;
}

export interface StrategyOrder {
    id: number;
    config_id: number;
    tg_user_id: string;
    exchange: string;
    pair: string;
    strategy: string;
    trade_mode: string;
    side: string;
    price: number | null;
    qty: number | null;
    quote_qty: number | null;
    status: string;
    exchange_order_id?: string | null;
    client_order_id?: string | null;
    created_at: number;
    updated_at: number;
}

export interface StrategyFill {
    id: number;
    order_id: number;
    config_id: number;
    price: number;
    qty: number;
    fee: number | null;
    ts: number;
}

export interface StrategyEvent {
    id: number;
    config_id: number;
    ts: number;
    level: string | null;
    message: string;
}

export type TradeAuditAction = "place" | "cancel" | "fill" | "skip" | "error";

export interface TradeAuditRecord {
    id: number;
    ts: number;
    strategy_id: string;
    strategy_type: string;
    exchange: string;
    pair: string;
    action: TradeAuditAction;
    side: string | null;
    price: number | null;
    qty: number | null;
    order_id: string | null;
    reason: string | null;
    latency_ms: number | null;
}

export interface StrategyFailure {
    id: number;
    config_id: number;
    first_seen_at: number;
    last_seen_at: number;
    category: string;
    message: string;
    details_json?: string | null;
    count: number;
    last_http_status?: number | null;
    last_exchange_code?: string | null;
}

export interface StrategyOrderRegistry {
    id: number;
    strategy_id: string;
    exchange: string;
    pair: string;
    order_id: string;
    client_order_id: string | null;
    side: string;
    price: string | null;
    qty: string | null;
    status: string;
    created_at: number;
    updated_at: number;
}

export interface ExchangeKeyRecord {
    id: number;
    tg_user_id: string;
    exchange: string;
    key_cipher: string;
    secret_cipher: string;
    iv: string;
    tag: string;
    created_at: number;
    updated_at: number;
}

export interface GridOrder {
    id: number;
    config_id: number;
    exchange: string;
    pair: string;
    side: string;
    price_key: string;
    order_id: string;
    status: string;
    created_at: number;
    updated_at: number;
}

type DcaParams = {
    budget?: number;
    intervalSec?: number;
    quoteCcy?: string;
    symbol?: string;
    maxTotalSpend?: number | null;
    endsAt?: number | null;
};

function safeParseJson<T>(value: string): T | null {
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function parseDcaParams(paramsJson: string): Required<DcaParams> {
    const parsed = safeParseJson<DcaParams>(paramsJson);
    return {
        budget: parsed?.budget ?? 0,
        intervalSec: parsed?.intervalSec ?? 0,
        quoteCcy: parsed?.quoteCcy ?? "",
        symbol: parsed?.symbol ?? "",
        maxTotalSpend: parsed?.maxTotalSpend ?? null,
        endsAt: parsed?.endsAt ?? null,
    };
}

function mapStrategyToDcaConfig(config: StrategyConfig): TradeDcaConfig {
    const params = parseDcaParams(config.params_json);
    const normalizedSymbol = normalizePairSymbol(config.exchange as any, config.pair) || config.pair;
    return {
        id: config.id,
        tg_user_id: config.tg_user_id,
        exchange: config.exchange,
        pair: config.pair,
        symbol: params.symbol || normalizedSymbol,
        trade_mode: config.trade_mode,
        strategy: config.strategy,
        quote_ccy: params.quoteCcy || "",
        budget: params.budget || 0,
        interval_sec: params.intervalSec || 0,
        enabled: config.enabled,
        last_run_at: config.last_run_at,
        created_at: config.created_at,
        updated_at: config.updated_at,
        max_total_spend: params.maxTotalSpend,
        ends_at: params.endsAt,
    };
}

export function upsertStrategyConfig(params: {
    tgUserId: string;
    exchange: string;
    pair: string;
    tradeMode: string;
    strategy: string;
    paramsJson: string;
    enabled?: boolean;
    notes?: string | null;
}): StrategyConfig {
    const now = Date.now();
    const existing = db.prepare(
        "SELECT * FROM trade_strategy_config WHERE tg_user_id = ? AND exchange = ? AND pair = ? AND trade_mode = ? AND strategy = ?"
    ).get(params.tgUserId, params.exchange, params.pair, params.tradeMode, params.strategy) as StrategyConfig | undefined;

    if (existing) {
        const enabled = params.enabled === undefined ? existing.enabled : params.enabled ? 1 : 0;
        if (enabled === 1) {
            db.prepare(`
                UPDATE trade_strategy_config
                SET params_json = ?, enabled = ?, notes = ?, disabled_reason = NULL, next_allowed_at = NULL, consecutive_failures = 0, updated_at = ?
                WHERE id = ?
            `).run(params.paramsJson, enabled, params.notes ?? existing.notes, now, existing.id);
        } else {
            db.prepare(`
                UPDATE trade_strategy_config
                SET params_json = ?, enabled = ?, notes = ?, updated_at = ?
                WHERE id = ?
            `).run(params.paramsJson, enabled, params.notes ?? existing.notes, now, existing.id);
        }

        return {
            ...existing,
            params_json: params.paramsJson,
            enabled,
            notes: params.notes ?? existing.notes,
            updated_at: now,
        };
    }

    const enabled = params.enabled ? 1 : 0;
    const result = db.prepare(`
        INSERT INTO trade_strategy_config
        (tg_user_id, exchange, pair, trade_mode, strategy, enabled, params_json, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        params.tgUserId,
        params.exchange,
        params.pair,
        params.tradeMode,
        params.strategy,
        enabled,
        params.paramsJson,
        params.notes ?? null,
        now,
        now
    );

    return {
        id: result.lastInsertRowid as number,
        tg_user_id: params.tgUserId,
        exchange: params.exchange,
        pair: params.pair,
        trade_mode: params.tradeMode,
        strategy: params.strategy,
        enabled,
        params_json: params.paramsJson,
        notes: params.notes ?? null,
        last_run_at: null,
        created_at: now,
        updated_at: now,
    };
}

export function getStrategyConfigById(configId: number): StrategyConfig | null {
    const row = db.prepare(
        "SELECT * FROM trade_strategy_config WHERE id = ?"
    ).get(configId) as StrategyConfig | undefined;
    return row || null;
}

export function getStrategyConfigByKey(
    tgUserId: string,
    exchange: string,
    pair: string,
    tradeMode: string,
    strategy: string
): StrategyConfig | null {
    const row = db.prepare(
        "SELECT * FROM trade_strategy_config WHERE tg_user_id = ? AND exchange = ? AND pair = ? AND trade_mode = ? AND strategy = ?"
    ).get(tgUserId, exchange, pair, tradeMode, strategy) as StrategyConfig | undefined;
    return row || null;
}

export function getStrategyConfigsByUser(tgUserId: string, strategy?: string): StrategyConfig[] {
    if (strategy) {
        return db.prepare(
            "SELECT * FROM trade_strategy_config WHERE tg_user_id = ? AND strategy = ? ORDER BY updated_at DESC"
        ).all(tgUserId, strategy) as StrategyConfig[];
    }
    return db.prepare(
        "SELECT * FROM trade_strategy_config WHERE tg_user_id = ? ORDER BY updated_at DESC"
    ).all(tgUserId) as StrategyConfig[];
}

export function getEnabledStrategyConfigs(): StrategyConfig[] {
    return db.prepare(
        "SELECT * FROM trade_strategy_config WHERE enabled = 1"
    ).all() as StrategyConfig[];
}

export function setStrategyEnabledById(configId: number, tgUserId: string, enabled: boolean): boolean {
    const now = Date.now();
    const result = enabled
        ? db.prepare(
            "UPDATE trade_strategy_config SET enabled = 1, disabled_reason = NULL, next_allowed_at = NULL, consecutive_failures = 0, updated_at = ? WHERE id = ? AND tg_user_id = ?"
        ).run(now, configId, tgUserId)
        : db.prepare(
            "UPDATE trade_strategy_config SET enabled = 0, updated_at = ? WHERE id = ? AND tg_user_id = ?"
        ).run(now, configId, tgUserId);
    return result.changes > 0;
}

export function setStrategyDisabledWithReason(configId: number, tgUserId: string, reason: string): boolean {
    const now = Date.now();
    const result = db.prepare(
        "UPDATE trade_strategy_config SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ? AND tg_user_id = ?"
    ).run(reason, now, configId, tgUserId);
    return result.changes > 0;
}

export function setStrategyEnabledByKey(
    tgUserId: string,
    exchange: string,
    pair: string,
    tradeMode: string,
    strategy: string,
    enabled: boolean
): boolean {
    const now = Date.now();
    const result = db.prepare(
        "UPDATE trade_strategy_config SET enabled = ?, updated_at = ? WHERE tg_user_id = ? AND exchange = ? AND pair = ? AND trade_mode = ? AND strategy = ?"
    ).run(enabled ? 1 : 0, now, tgUserId, exchange, pair, tradeMode, strategy);
    return result.changes > 0;
}

export function disableAllStrategyConfigs(tgUserId: string, strategy?: string): boolean {
    const now = Date.now();
    if (strategy) {
        const result = db.prepare(
            "UPDATE trade_strategy_config SET enabled = 0, updated_at = ? WHERE tg_user_id = ? AND strategy = ?"
        ).run(now, tgUserId, strategy);
        return result.changes > 0;
    }
    const result = db.prepare(
        "UPDATE trade_strategy_config SET enabled = 0, updated_at = ? WHERE tg_user_id = ?"
    ).run(now, tgUserId);
    return result.changes > 0;
}

export function disableAllStrategyConfigsGlobal(strategy?: string): number {
    const now = Date.now();
    if (strategy) {
        const result = db.prepare(
            "UPDATE trade_strategy_config SET enabled = 0, updated_at = ? WHERE enabled = 1 AND strategy = ?"
        ).run(now, strategy);
        return result.changes;
    }
    const result = db.prepare(
        "UPDATE trade_strategy_config SET enabled = 0, updated_at = ? WHERE enabled = 1"
    ).run(now);
    return result.changes;
}

export function updateStrategyLastRunAt(configId: number, now = Date.now()): void {
    db.prepare(
        "UPDATE trade_strategy_config SET last_run_at = ?, updated_at = ? WHERE id = ?"
    ).run(now, now, configId);
}

export function updateStrategyParams(configId: number, paramsJson: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE trade_strategy_config SET params_json = ?, updated_at = ? WHERE id = ?"
    ).run(paramsJson, now, configId);
}

function normalizeAuditAction(action: string): TradeAuditAction {
    const normalized = String(action || "").trim().toLowerCase();
    if (normalized === "place" || normalized === "cancel" || normalized === "fill" || normalized === "skip" || normalized === "error") {
        return normalized;
    }
    return "error";
}

function normalizeAuditReason(reason?: string | null): string | null {
    if (reason === null || reason === undefined) return null;
    const text = String(reason).trim();
    if (!text) return null;
    return text.slice(0, 160);
}

export function getTradeAuditRetentionDays(): number {
    const parsed = Number(process.env.TRADE_AUDIT_RETENTION_DAYS || 60);
    if (!Number.isFinite(parsed) || parsed <= 0) return 60;
    return Math.floor(parsed);
}

export function insertTradeAudit(params: {
    ts?: number;
    strategyId: string | number;
    strategyType: string;
    exchange: string;
    pair: string;
    action: TradeAuditAction | string;
    side?: string | null;
    price?: number | null;
    qty?: number | null;
    orderId?: string | null;
    reason?: string | null;
    latencyMs?: number | null;
}): TradeAuditRecord {
    const ts = Number.isFinite(params.ts as number) ? Number(params.ts) : Date.now();
    const action = normalizeAuditAction(params.action);
    const result = db.prepare(`
        INSERT INTO trade_audit
        (ts, strategy_id, strategy_type, exchange, pair, action, side, price, qty, order_id, reason, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        ts,
        String(params.strategyId),
        String(params.strategyType || "UNKNOWN").toUpperCase(),
        String(params.exchange || "unknown"),
        String(params.pair || "unknown"),
        action,
        params.side ? String(params.side).toUpperCase() : null,
        Number.isFinite(params.price as number) ? Number(params.price) : null,
        Number.isFinite(params.qty as number) ? Number(params.qty) : null,
        params.orderId ? String(params.orderId) : null,
        normalizeAuditReason(params.reason),
        Number.isFinite(params.latencyMs as number) ? Number(params.latencyMs) : null
    );

    const record: TradeAuditRecord = {
        id: result.lastInsertRowid as number,
        ts,
        strategy_id: String(params.strategyId),
        strategy_type: String(params.strategyType || "UNKNOWN").toUpperCase(),
        exchange: String(params.exchange || "unknown"),
        pair: String(params.pair || "unknown"),
        action,
        side: params.side ? String(params.side).toUpperCase() : null,
        price: Number.isFinite(params.price as number) ? Number(params.price) : null,
        qty: Number.isFinite(params.qty as number) ? Number(params.qty) : null,
        order_id: params.orderId ? String(params.orderId) : null,
        reason: normalizeAuditReason(params.reason),
        latency_ms: Number.isFinite(params.latencyMs as number) ? Number(params.latencyMs) : null,
    };

    tradeAuditLog({
        scope: "trade-audit",
        strategyId: record.strategy_id,
        exchange: record.exchange,
        message: `action=${record.action} strategyType=${record.strategy_type} pair=${record.pair} side=${record.side || "n/a"} price=${record.price ?? "n/a"} qty=${record.qty ?? "n/a"} orderId=${record.order_id || "n/a"} reason=${record.reason || "n/a"}`,
    });

    return record;
}

export function cleanupTradeAudit(olderThanDays = getTradeAuditRetentionDays()): number {
    const days = Number.isFinite(olderThanDays) && olderThanDays > 0 ? Math.floor(olderThanDays) : getTradeAuditRetentionDays();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = db.prepare("DELETE FROM trade_audit WHERE ts < ?").run(cutoff);
    return result.changes;
}

export function checkpointWal(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE"): {
    busy: number;
    log: number;
    checkpointed: number;
} {
    const normalizedMode = String(mode || "TRUNCATE").toUpperCase() as "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
    const row = db.prepare(`PRAGMA wal_checkpoint(${normalizedMode})`).get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | undefined;
    return {
        busy: Number(row?.busy || 0),
        log: Number(row?.log || 0),
        checkpointed: Number(row?.checkpointed || 0),
    };
}

export function insertStrategyOrder(params: {
    configId: number;
    tgUserId: string;
    exchange: string;
    pair: string;
    strategy: string;
    tradeMode: string;
    side: string;
    price: number | null;
    qty: number | null;
    quoteQty: number | null;
    status: string;
    exchangeOrderId?: string | null;
    clientOrderId?: string | null;
}): StrategyOrder {
    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO trade_strategy_order
        (config_id, tg_user_id, exchange, pair, strategy, trade_mode, side, price, qty, quote_qty, status, exchange_order_id, client_order_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        params.configId,
        params.tgUserId,
        params.exchange,
        params.pair,
        params.strategy,
        params.tradeMode,
        params.side,
        params.price,
        params.qty,
        params.quoteQty,
        params.status,
        params.exchangeOrderId ?? null,
        params.clientOrderId ?? null,
        now,
        now
    );

    const created: StrategyOrder = {
        id: result.lastInsertRowid as number,
        config_id: params.configId,
        tg_user_id: params.tgUserId,
        exchange: params.exchange,
        pair: params.pair,
        strategy: params.strategy,
        trade_mode: params.tradeMode,
        side: params.side,
        price: params.price,
        qty: params.qty,
        quote_qty: params.quoteQty,
        status: params.status,
        exchange_order_id: params.exchangeOrderId ?? null,
        client_order_id: params.clientOrderId ?? null,
        created_at: now,
        updated_at: now,
    };

    insertTradeAudit({
        ts: now,
        strategyId: params.configId,
        strategyType: params.strategy,
        exchange: params.exchange,
        pair: params.pair,
        action: "place",
        side: params.side,
        price: params.price,
        qty: params.qty,
        orderId: params.exchangeOrderId ?? params.clientOrderId ?? String(created.id),
        reason: params.status || "OPEN",
    });

    return created;
}

export function updateStrategyOrderStatus(orderId: number, status: string): void {
    const now = Date.now();
    const existing = db.prepare(
        "SELECT * FROM trade_strategy_order WHERE id = ?"
    ).get(orderId) as StrategyOrder | undefined;

    db.prepare(
        "UPDATE trade_strategy_order SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, now, orderId);

    if (!existing) return;

    const normalized = String(status || "").toUpperCase();
    if (normalized.includes("CANCEL")) {
        insertTradeAudit({
            ts: now,
            strategyId: existing.config_id,
            strategyType: existing.strategy,
            exchange: existing.exchange,
            pair: existing.pair,
            action: "cancel",
            side: existing.side,
            price: existing.price,
            qty: existing.qty,
            orderId: existing.exchange_order_id ?? existing.client_order_id ?? String(orderId),
            reason: normalized,
        });
    } else if (normalized === "FILLED") {
        insertTradeAudit({
            ts: now,
            strategyId: existing.config_id,
            strategyType: existing.strategy,
            exchange: existing.exchange,
            pair: existing.pair,
            action: "fill",
            side: existing.side,
            price: existing.price,
            qty: existing.qty,
            orderId: existing.exchange_order_id ?? existing.client_order_id ?? String(orderId),
            reason: normalized,
        });
    }
}

export function cancelOpenStrategyOrders(configId: number): number {
    const now = Date.now();
    const openOrders = db.prepare(
        "SELECT * FROM trade_strategy_order WHERE config_id = ? AND status = 'OPEN'"
    ).all(configId) as StrategyOrder[];

    const result = db.prepare(
        "UPDATE trade_strategy_order SET status = 'CANCELED', updated_at = ? WHERE config_id = ? AND status = 'OPEN'"
    ).run(now, configId);

    for (const order of openOrders) {
        insertTradeAudit({
            ts: now,
            strategyId: order.config_id,
            strategyType: order.strategy,
            exchange: order.exchange,
            pair: order.pair,
            action: "cancel",
            side: order.side,
            price: order.price,
            qty: order.qty,
            orderId: order.exchange_order_id ?? order.client_order_id ?? String(order.id),
            reason: "CANCELED",
        });
    }

    return result.changes;
}

export function cancelOpenGridOrders(configId: number): number {
    const now = Date.now();
    const openOrders = db.prepare(
        "SELECT * FROM grid_order WHERE config_id = ? AND status = 'OPEN'"
    ).all(configId) as GridOrder[];

    const result = db.prepare(
        "UPDATE grid_order SET status = 'CANCELLED', updated_at = ? WHERE config_id = ? AND status = 'OPEN'"
    ).run(now, configId);

    for (const order of openOrders) {
        insertTradeAudit({
            ts: now,
            strategyId: order.config_id,
            strategyType: "GRID",
            exchange: order.exchange,
            pair: order.pair,
            action: "cancel",
            side: order.side,
            orderId: order.order_id,
            reason: "CANCELLED",
        });
    }

    return result.changes;
}

export function getOpenStrategyOrders(configId: number): StrategyOrder[] {
    return db.prepare(
        "SELECT * FROM trade_strategy_order WHERE config_id = ? AND status = 'OPEN' ORDER BY created_at ASC"
    ).all(configId) as StrategyOrder[];
}

export function getStrategyTotalSpend(configId: number): number {
    const result = db.prepare(
        "SELECT COALESCE(SUM(price * qty), 0) as total FROM trade_strategy_fill WHERE config_id = ?"
    ).get(configId) as { total: number };
    return result?.total ?? 0;
}

export function insertStrategyFill(params: {
    orderId: number;
    configId: number;
    price: number;
    qty: number;
    fee?: number | null;
    ts?: number;
}): StrategyFill {
    const ts = params.ts ?? Date.now();
    const result = db.prepare(`
        INSERT INTO trade_strategy_fill
        (order_id, config_id, price, qty, fee, ts)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.orderId, params.configId, params.price, params.qty, params.fee ?? null, ts);

    const fill = {
        id: result.lastInsertRowid as number,
        order_id: params.orderId,
        config_id: params.configId,
        price: params.price,
        qty: params.qty,
        fee: params.fee ?? null,
        ts,
    };

    const order = db.prepare(
        "SELECT * FROM trade_strategy_order WHERE id = ?"
    ).get(params.orderId) as StrategyOrder | undefined;

    if (order) {
        insertTradeAudit({
            ts,
            strategyId: order.config_id,
            strategyType: order.strategy,
            exchange: order.exchange,
            pair: order.pair,
            action: "fill",
            side: order.side,
            price: params.price,
            qty: params.qty,
            orderId: order.exchange_order_id ?? order.client_order_id ?? String(order.id),
            reason: "FILL",
        });
    }

    return fill;
}

export function insertStrategyEvent(params: {
    configId: number;
    level?: string;
    message: string;
    ts?: number;
}): StrategyEvent {
    const ts = params.ts ?? Date.now();
    const result = db.prepare(`
        INSERT INTO trade_strategy_event
        (config_id, ts, level, message)
        VALUES (?, ?, ?, ?)
    `).run(params.configId, ts, params.level ?? null, params.message);

    return {
        id: result.lastInsertRowid as number,
        config_id: params.configId,
        ts,
        level: params.level ?? null,
        message: params.message,
    };
}

export function insertGridOrder(params: {
    configId: number;
    exchange: string;
    pair: string;
    side: string;
    priceKey: string;
    orderId: string;
    status: string;
}): GridOrder {
    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO grid_order
        (config_id, exchange, pair, side, price_key, order_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        params.configId,
        params.exchange,
        params.pair,
        params.side,
        params.priceKey,
        params.orderId,
        params.status,
        now,
        now
    );

    return {
        id: result.lastInsertRowid as number,
        config_id: params.configId,
        exchange: params.exchange,
        pair: params.pair,
        side: params.side,
        price_key: params.priceKey,
        order_id: params.orderId,
        status: params.status,
        created_at: now,
        updated_at: now,
    };
}

export function updateGridOrderStatus(orderId: string, status: string): void {
    const now = Date.now();
    const existing = db.prepare(
        "SELECT * FROM grid_order WHERE order_id = ? LIMIT 1"
    ).get(orderId) as GridOrder | undefined;

    db.prepare(
        "UPDATE grid_order SET status = ?, updated_at = ? WHERE order_id = ?"
    ).run(status, now, orderId);

    if (!existing) return;

    const normalized = String(status || "").toUpperCase();
    if (normalized === "FILLED") {
        insertTradeAudit({
            ts: now,
            strategyId: existing.config_id,
            strategyType: "GRID",
            exchange: existing.exchange,
            pair: existing.pair,
            action: "fill",
            side: existing.side,
            orderId,
            reason: "FILLED",
        });
    } else if (normalized.includes("CANCEL")) {
        insertTradeAudit({
            ts: now,
            strategyId: existing.config_id,
            strategyType: "GRID",
            exchange: existing.exchange,
            pair: existing.pair,
            action: "cancel",
            side: existing.side,
            orderId,
            reason: normalized,
        });
    }
}

export function getOpenGridOrders(configId: number): GridOrder[] {
    return db.prepare(
        "SELECT * FROM grid_order WHERE config_id = ? AND status = 'OPEN'"
    ).all(configId) as GridOrder[];
}

// --- Strategy Order Registry (Unified) ---

export function insertStrategyOrderRegistry(order: Omit<StrategyOrderRegistry, "id" | "created_at" | "updated_at">): void {
    const now = Date.now();
    db.prepare(`
        INSERT INTO strategy_order
        (strategy_id, exchange, pair, order_id, client_order_id, side, price, qty, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        order.strategy_id,
        order.exchange,
        order.pair,
        order.order_id,
        order.client_order_id,
        order.side,
        order.price,
        order.qty,
        order.status,
        now,
        now
    );
}

export function updateStrategyOrderStatusRegistry(exchange: string, orderId: string, status: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE strategy_order SET status = ?, updated_at = ? WHERE exchange = ? AND order_id = ?"
    ).run(status, now, exchange, orderId);
}

export function getOpenStrategyOrdersRegistry(strategyId: string): StrategyOrderRegistry[] {
    return db.prepare(
        "SELECT * FROM strategy_order WHERE strategy_id = ? AND status = 'OPEN'"
    ).all(strategyId) as StrategyOrderRegistry[];
}

export function closeMissingStrategyOrdersRegistry(
    strategyId: string,
    exchange: string,
    pair: string,
    liveOrderIds: string[],
    status: string = "CLOSED"
): number {
    const now = Date.now();
    const ids = Array.from(new Set((liveOrderIds || []).map((v) => String(v || "").trim()).filter(Boolean)));

    if (ids.length === 0) {
        const result = db.prepare(
            "UPDATE strategy_order SET status = ?, updated_at = ? WHERE strategy_id = ? AND exchange = ? AND pair = ? AND status = 'OPEN'"
        ).run(status, now, strategyId, exchange, pair);
        return result.changes;
    }

    const placeholders = ids.map(() => "?").join(", ");
    const sql = `
        UPDATE strategy_order
        SET status = ?, updated_at = ?
        WHERE strategy_id = ?
          AND exchange = ?
          AND pair = ?
          AND status = 'OPEN'
          AND order_id NOT IN (${placeholders})
    `;
    const result = db.prepare(sql).run(status, now, strategyId, exchange, pair, ...ids);
    return result.changes;
}

export function cancelLocalStrategyOrdersRegistry(strategyId: string): number {
    const now = Date.now();
    const result = db.prepare(
        "UPDATE strategy_order SET status = 'CANCELLED', updated_at = ? WHERE strategy_id = ? AND status = 'OPEN'"
    ).run(now, strategyId);
    return result.changes;
}

export function getGridOrderByLevel(configId: number, side: string, priceKey: string): GridOrder | null {
    const row = db.prepare(
        "SELECT * FROM grid_order WHERE config_id = ? AND side = ? AND price_key = ? AND status = 'OPEN' LIMIT 1"
    ).get(configId, side, priceKey) as GridOrder | undefined;
    return row || null;
}

export function getRecentStrategyOrders(tgUserId: string, limit = 10): StrategyOrder[] {
    return db.prepare(
        "SELECT * FROM trade_strategy_order WHERE tg_user_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(tgUserId, limit) as StrategyOrder[];
}

export function getLatestStrategyEvent(configId: number): StrategyEvent | null {
    const row = db.prepare(
        "SELECT * FROM trade_strategy_event WHERE config_id = ? ORDER BY ts DESC LIMIT 1"
    ).get(configId) as StrategyEvent | undefined;
    return row || null;
}

export function getRecentStrategyFills(tgUserId: string, limit = 10): Array<{
    id: number;
    order_id: number;
    config_id: number;
    price: number;
    qty: number;
    fee: number | null;
    ts: number;
    side: string;
    exchange: string;
    pair: string;
    strategy: string;
    trade_mode: string;
}> {
    return db.prepare(
        `
        SELECT f.id, f.order_id, f.config_id, f.price, f.qty, f.fee, f.ts,
               o.side, o.exchange, o.pair, o.strategy, o.trade_mode
        FROM trade_strategy_fill f
        JOIN trade_strategy_order o ON o.id = f.order_id
        WHERE o.tg_user_id = ?
        ORDER BY f.ts DESC
        LIMIT ?
        `
    ).all(tgUserId, limit) as Array<{
        id: number;
        order_id: number;
        config_id: number;
        price: number;
        qty: number;
        fee: number | null;
        ts: number;
        side: string;
        exchange: string;
        pair: string;
        strategy: string;
        trade_mode: string;
    }>;
}

type LegacyTradeDcaConfig = {
    id: number;
    tg_user_id: string;
    exchange: string;
    pair: string;
    symbol: string;
    trade_mode: string;
    strategy: string;
    quote_ccy: string;
    budget: number;
    interval_sec: number;
    enabled: number;
    last_run_at: number | null;
    created_at: number;
    updated_at: number;
};

// DCA Config functions
export function upsertDcaConfig(
    tgUserId: string,
    exchange: string,
    pair: string,
    symbol: string,
    tradeMode: string,
    strategy: string,
    quoteCcy: string,
    budget: number,
    intervalSec: number,
    maxTotalSpend?: number | null,
    endsAt?: number | null,
): TradeDcaConfig {
    const paramsJson = JSON.stringify({
        budget,
        intervalSec,
        quoteCcy,
        symbol,
        maxTotalSpend: maxTotalSpend ?? null,
        endsAt: endsAt ?? null,
    });
    const config = upsertStrategyConfig({
        tgUserId,
        exchange,
        pair,
        tradeMode,
        strategy,
        paramsJson,
        enabled: true,
    });
    return mapStrategyToDcaConfig(config);
}

export function getLatestDcaConfig(tgUserId: string): TradeDcaConfig | null {
    const row = db.prepare(
        "SELECT * FROM trade_strategy_config WHERE tg_user_id = ? AND strategy = 'DCA' ORDER BY updated_at DESC LIMIT 1"
    ).get(tgUserId) as StrategyConfig | undefined;
    return row ? mapStrategyToDcaConfig(row) : null;
}

// Get all configs for status display
export function getAllDcaConfigs(tgUserId: string): TradeDcaConfig[] {
    return getStrategyConfigsByUser(tgUserId, "DCA").map(mapStrategyToDcaConfig);
}

export function getDcaConfigById(tgUserId: string, configId: number): TradeDcaConfig | null {
    const row = db.prepare(
        "SELECT * FROM trade_strategy_config WHERE id = ? AND tg_user_id = ? AND strategy = 'DCA'"
    ).get(configId, tgUserId) as StrategyConfig | undefined;
    return row ? mapStrategyToDcaConfig(row) : null;
}

export function getDcaConfigByKey(
    tgUserId: string,
    exchange: string,
    pair: string,
    tradeMode: string
): TradeDcaConfig | null {
    const row = getStrategyConfigByKey(tgUserId, exchange, pair, tradeMode, "DCA");
    return row ? mapStrategyToDcaConfig(row) : null;
}

// Enable or disable a specific config
export function setDcaEnabledById(configId: number, tgUserId: string, enabled: boolean): boolean {
    return setStrategyEnabledById(configId, tgUserId, enabled);
}

export function setDcaEnabledByKey(
    tgUserId: string,
    exchange: string,
    pair: string,
    tradeMode: string,
    enabled: boolean
): boolean {
    return setStrategyEnabledByKey(tgUserId, exchange, pair, tradeMode, "DCA", enabled);
}

export function disableAllDcaConfigs(tgUserId: string): boolean {
    return disableAllStrategyConfigs(tgUserId, "DCA");
}

export function disableAllDcaConfigsGlobal(): number {
    return disableAllStrategyConfigsGlobal("DCA");
}

export function getEnabledDcaConfigs(): TradeDcaConfig[] {
    const rows = db.prepare(
        "SELECT * FROM trade_strategy_config WHERE enabled = 1 AND strategy = 'DCA'"
    ).all() as StrategyConfig[];
    return rows.map(mapStrategyToDcaConfig);
}

export function updateLastRunAt(configId: number): void {
    updateStrategyLastRunAt(configId);
}

// Order Log functions
export function insertOrderLog(
    tgUserId: string,
    exchange: string,
    pair: string,
    symbol: string,
    side: string,
    quoteAmount: number,
    price: number | null,
    status: string,
    tradeMode: string,
    strategy: string,
    rawJson?: string
): TradeOrderLog {
    const now = Date.now();
    const result = db.prepare(`
    INSERT INTO trade_order_log 
    (tg_user_id, exchange, pair, symbol, side, quote_amount, price, status, trade_mode, strategy, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tgUserId, exchange, pair, symbol, side, quoteAmount, price, status, tradeMode, strategy, rawJson || null, now);

    return {
        id: result.lastInsertRowid as number,
        tg_user_id: tgUserId,
        exchange,
        pair,
        symbol,
        side,
        quote_amount: quoteAmount,
        price,
        status,
        trade_mode: tradeMode,
        strategy,
        raw_json: rawJson || null,
        created_at: now,
    };
}

export function getRecentOrderLogs(tgUserId: string, limit = 10): TradeOrderLog[] {
    return db.prepare(
        "SELECT * FROM trade_order_log WHERE tg_user_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(tgUserId, limit) as TradeOrderLog[];
}

export function getRecentOrderLogsForConfig(
    tgUserId: string,
    exchange: string,
    pair: string,
    tradeMode: string,
    limit = 10
): TradeOrderLog[] {
    const mode = tradeMode.toUpperCase();
    if (mode === "REAL") {
        return db.prepare(
            "SELECT * FROM trade_order_log WHERE tg_user_id = ? AND exchange = ? AND pair = ? AND status IN ('REAL','FAILED') ORDER BY created_at DESC LIMIT ?"
        ).all(tgUserId, exchange, pair, limit) as TradeOrderLog[];
    }

    return db.prepare(
        "SELECT * FROM trade_order_log WHERE tg_user_id = ? AND exchange = ? AND pair = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
    ).all(tgUserId, exchange, pair, mode, limit) as TradeOrderLog[];
}

export function upsertExchangeKey(
    tgUserId: string,
    exchange: string,
    keyCipher: string,
    secretCipher: string,
    iv: string,
    tag: string
): ExchangeKeyRecord {
    const now = Date.now();
    const existing = db.prepare(
        "SELECT * FROM exchange_key WHERE tg_user_id = ? AND exchange = ?"
    ).get(tgUserId, exchange) as ExchangeKeyRecord | undefined;

    if (existing) {
        db.prepare(`
      UPDATE exchange_key 
      SET key_cipher = ?, secret_cipher = ?, iv = ?, tag = ?, updated_at = ?
      WHERE id = ?
    `).run(keyCipher, secretCipher, iv, tag, now, existing.id);
        return {
            ...existing,
            key_cipher: keyCipher,
            secret_cipher: secretCipher,
            iv,
            tag,
            updated_at: now,
        };
    }

    const result = db.prepare(`
    INSERT INTO exchange_key 
    (tg_user_id, exchange, key_cipher, secret_cipher, iv, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tgUserId, exchange, keyCipher, secretCipher, iv, tag, now, now);

    return {
        id: result.lastInsertRowid as number,
        tg_user_id: tgUserId,
        exchange,
        key_cipher: keyCipher,
        secret_cipher: secretCipher,
        iv,
        tag,
        created_at: now,
        updated_at: now,
    };
}

export function getExchangeKey(tgUserId: string, exchange: string): ExchangeKeyRecord | null {
    const row = db.prepare(
        "SELECT * FROM exchange_key WHERE tg_user_id = ? AND exchange = ?"
    ).get(tgUserId, exchange) as ExchangeKeyRecord | undefined;
    return row || null;
}

export function listExchangeKeys(tgUserId: string): ExchangeKeyRecord[] {
    return db.prepare(
        "SELECT * FROM exchange_key WHERE tg_user_id = ? ORDER BY updated_at DESC"
    ).all(tgUserId) as ExchangeKeyRecord[];
}

export function clearExchangeKey(tgUserId: string, exchange: string): boolean {
    const result = db.prepare(
        "DELETE FROM exchange_key WHERE tg_user_id = ? AND exchange = ?"
    ).run(tgUserId, exchange);
    return result.changes > 0;
}

// ============= REAL Mode Safety: Rate Limiting =============

/**
 * Count REAL orders placed by a config in the last hour
 */
export function countOrdersLastHour(configId: number): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const result = db.prepare(
        `SELECT COUNT(*) as cnt FROM trade_strategy_order 
         WHERE config_id = ? AND created_at >= ? AND status != 'CANCELED'`
    ).get(configId, oneHourAgo) as { cnt: number };
    return result?.cnt ?? 0;
}

/**
 * Get total quote spent by a config today (resets at midnight UTC)
 */
export function getQuoteSpentToday(configId: number): number {
    const now = new Date();
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const result = db.prepare(
        `SELECT COALESCE(SUM(quote_qty), 0) as total FROM trade_strategy_order 
         WHERE config_id = ? AND created_at >= ? AND status NOT IN ('CANCELED', 'FAILED')`
    ).get(configId, startOfDay) as { total: number };
    return result?.total ?? 0;
}

/**
 * Check if placing an order is allowed based on rate limits
 */
export function canPlaceOrder(
    configId: number,
    maxOrdersPerHour: number,
    maxQuotePerDay: number,
    pendingQuote: number
): { allowed: boolean; reason?: string } {
    const ordersLastHour = countOrdersLastHour(configId);
    if (ordersLastHour >= maxOrdersPerHour) {
        return {
            allowed: false,
            reason: `RATE_LIMIT: ${ordersLastHour} orders in last hour (max ${maxOrdersPerHour})`,
        };
    }

    const quoteSpentToday = getQuoteSpentToday(configId);
    if (quoteSpentToday + pendingQuote > maxQuotePerDay) {
        return {
            allowed: false,
            reason: `DAILY_LIMIT: ${quoteSpentToday.toFixed(4)} spent today + ${pendingQuote.toFixed(4)} pending > max ${maxQuotePerDay}`,
        };
    }

    return { allowed: true };
}

/**
 * Record that an order was placed (for rate limiting tracking)
 * This is called implicitly via insertStrategyOrder
 */
export function recordOrderPlaced(configId: number, quoteAmount: number): void {
    // Strategy orders automatically track this via insertStrategyOrder
    // This is a placeholder for future expansion (Redis-based rate limiting, etc.)
    console.log(`[rateLimit] order recorded: configId=${configId} quote=${quoteAmount}`);
}

// ============= Strategy Failure / Backoff Functions =============

/**
 * Upsert or update a failure record (for aggregation)
 */
export function upsertStrategyFailure(params: {
    configId: number;
    category: string;
    message: string;
    httpStatus?: number;
    exchangeCode?: string | number;
    detailsJson?: string | null;
}): void {
    const now = Date.now();
    // Truncate message for safety (max 200 chars) in DB
    const safeMessage = params.message.slice(0, 200);
    const detailsJson = params.detailsJson ?? null;

    const result = db.prepare(`
        INSERT INTO strategy_failure 
        (config_id, category, message, details_json, first_seen_at, last_seen_at, count, last_http_status, last_exchange_code)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(config_id, category, message) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        count = count + 1,
        last_http_status = excluded.last_http_status,
        last_exchange_code = excluded.last_exchange_code,
        details_json = excluded.details_json
    `).run(
        params.configId,
        params.category,
        safeMessage,
        detailsJson,
        now,
        now,
        params.httpStatus || null,
        params.exchangeCode ? String(params.exchangeCode) : null
    );
}

/**
 * Get the latest failure for display status
 */
export function getLatestFailure(configId: number): StrategyFailure | null {
    const row = db.prepare(
        "SELECT * FROM strategy_failure WHERE config_id = ? ORDER BY last_seen_at DESC LIMIT 1"
    ).get(configId) as StrategyFailure | undefined;
    return row || null;
}

/**
 * Clear all failure records for a config (called on success/recovery)
 */
export function clearStrategyFailures(configId: number): number {
    const result = db.prepare(
        "DELETE FROM strategy_failure WHERE config_id = ?"
    ).run(configId);
    return result.changes;
}

/**
 * Get backoff state for a config
 */
export function getBackoffState(configId: number): {
    isInBackoff: boolean;
    remainingSec: number;
    consecutiveFailures: number;
    nextAllowedAt: number;
} {
    const row = db.prepare(
        "SELECT next_allowed_at, consecutive_failures FROM trade_strategy_config WHERE id = ?"
    ).get(configId) as { next_allowed_at: number | null; consecutive_failures: number | null } | undefined;

    if (!row) {
        return { isInBackoff: false, remainingSec: 0, consecutiveFailures: 0, nextAllowedAt: 0 };
    }

    const nextAllowedAt = row.next_allowed_at || 0;
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((nextAllowedAt - now) / 1000));

    return {
        isInBackoff: remaining > 0,
        remainingSec: remaining,
        consecutiveFailures: row.consecutive_failures || 0,
        nextAllowedAt,
    };
}

/**
 * Update backoff state on error
 */
export function setBackoffUntil(params: {
    configId: number;
    nextAllowedAt: number;
    consecutiveFailures: number;
}): void {
    const now = Date.now();
    db.prepare(
        "UPDATE trade_strategy_config SET next_allowed_at = ?, consecutive_failures = ?, updated_at = ? WHERE id = ?"
    ).run(params.nextAllowedAt, params.consecutiveFailures, now, params.configId);
}

/**
 * Reset backoff state on success
 */
export function resetBackoff(configId: number): void {
    const now = Date.now();
    db.prepare(
        "UPDATE trade_strategy_config SET next_allowed_at = NULL, consecutive_failures = 0, updated_at = ? WHERE id = ?"
    ).run(now, configId);
}

/**
 * Auto-disable a config with a reason
 */
export function autoDisableConfig(configId: number, reason: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE trade_strategy_config SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ?"
    ).run(reason, now, configId);
}

/**
 * Cleanup old failure records (e.g., > 30 days)
 */
export function cleanupOldFailures(olderThanDays = 30): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const result = db.prepare(
        "DELETE FROM strategy_failure WHERE last_seen_at < ?"
    ).run(cutoff);
    return result.changes;
}

// ============= DevMM Types =============

export type DevmmExchange = "nonkyc" | "dextrade" | "nestex";
export type DevmmStatus = "ACTIVE" | "DEGRADED" | "PAUSED" | "STOPPED";

export interface DevmmConfig {
    id: number;
    exchange: DevmmExchange;
    symbol: string;
    min_notional_usdt: number;
    order_quote_usdt: number;
    buy_offset_pct: number;
    sell_offset_pct: number;
    refresh_seconds: number;
    refresh_jitter_seconds: number;
    cooldown_minutes: number;
    cap_ratio: number;
    cap_day_min_usdt: number;
    inventory_target_usdt_share: number;
    inventory_min_usdt_share: number;
    inventory_resume_usdt_share: number;
    inventory_max_usdt_share: number;
    trend_guard_pct: number;
    trend_pause_minutes: number;
    spread_min_pct: number;
    spread_max_pct: number;
    is_enabled: number;
    tg_user_id: string | null;
    created_at: number;
    updated_at: number;
}

export interface DevmmState {
    id: number;
    exchange: DevmmExchange;
    status: DevmmStatus;
    pause_reason: string | null;
    last_action: string | null;
    last_action_at: number | null;
    last_error: string | null;
    last_error_at: number | null;
    used_turnover_today_usdt: number;
    used_turnover_hour_usdt: number;
    hour_bucket: string | null;
    day_bucket: string | null;
    last_bid: number | null;
    last_ask: number | null;
    last_mid: number | null;
    last_ref: number | null;
    usdt_balance: number | null;
    pepew_balance: number | null;
    usdt_share: number | null;
    open_buy_order_id: string | null;
    open_sell_order_id: string | null;
    cooldown_until: number | null;
    vol24h_usdt: number | null;
    vol24h_updated_at: number | null;
    ref_samples: string | null;
    last_tick_at: number | null;
    last_decision: string | null;
    updated_at: number;
}

export interface DevmmFill {
    id: number;
    ts: number;
    exchange: DevmmExchange;
    symbol: string;
    side: "BUY" | "SELL";
    price: number;
    qty_pepew: number;
    quote_usdt: number;
    fee_usdt: number | null;
    order_id: string | null;
    trade_id: string | null;
    day_bucket: string;
    week_bucket: string;
    month_bucket: string;
}

// Default minNotional by exchange
export const DEVMM_MIN_NOTIONAL: Record<DevmmExchange, number> = {
    nonkyc: 1,
    dextrade: 5,
    nestex: 0.0015,
};

const DEVMM_DEFAULT_INVENTORY_MIN_SHARE = Number(process.env.DEVMM_INVENTORY_MIN_USDT_SHARE || 0.1);
const DEVMM_DEFAULT_INVENTORY_MAX_SHARE = Number(process.env.DEVMM_INVENTORY_MAX_USDT_SHARE || 0.9);

// ============= DevMM Config Functions =============

export function getDevmmConfig(exchange: DevmmExchange, symbol = "PEPEW/USDT"): DevmmConfig | null {
    const row = db.prepare(
        "SELECT * FROM devmm_config WHERE exchange = ? AND symbol = ?"
    ).get(exchange, symbol) as DevmmConfig | undefined;
    return row || null;
}

export function getDevmmConfigById(id: number): DevmmConfig | null {
    const row = db.prepare(
        "SELECT * FROM devmm_config WHERE id = ?"
    ).get(id) as DevmmConfig | undefined;
    return row || null;
}

export function upsertDevmmConfig(params: {
    exchange: DevmmExchange;
    symbol?: string;
    tgUserId?: string;
    orderQuoteUsdt?: number;
    buyOffsetPct?: number;
    sellOffsetPct?: number;
    refreshSeconds?: number;
    inventoryMinUsdtShare?: number;
    inventoryMaxUsdtShare?: number;
}): DevmmConfig {
    const now = Date.now();
    const symbol = params.symbol || "PEPEW/USDT";
    const minNotional = DEVMM_MIN_NOTIONAL[params.exchange];
    const defaultOrderQuote = minNotional * 1.05;
    const orderQuote = params.orderQuoteUsdt ?? defaultOrderQuote;
    const buyOffset = params.buyOffsetPct ?? 0.02;
    const sellOffset = params.sellOffsetPct ?? 0.01;
    const refreshSec = params.refreshSeconds ?? 45;
    const tgUserId = params.tgUserId ?? null;
    const invMinRaw = params.inventoryMinUsdtShare ?? DEVMM_DEFAULT_INVENTORY_MIN_SHARE;
    const invMaxRaw = params.inventoryMaxUsdtShare ?? DEVMM_DEFAULT_INVENTORY_MAX_SHARE;
    const invMin = Math.min(Math.max(invMinRaw, 0), 0.99);
    const invMax = Math.min(Math.max(invMaxRaw, invMin + 0.01), 1);

    db.prepare(`
        INSERT INTO devmm_config
        (exchange, symbol, tg_user_id, min_notional_usdt, order_quote_usdt, buy_offset_pct, sell_offset_pct, refresh_seconds, inventory_min_usdt_share, inventory_max_usdt_share, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(exchange, symbol) DO UPDATE SET
            tg_user_id = COALESCE(?, tg_user_id),
            order_quote_usdt = ?,
            buy_offset_pct = ?,
            sell_offset_pct = ?,
            refresh_seconds = ?,
            inventory_min_usdt_share = ?,
            inventory_max_usdt_share = ?,
            is_enabled = 1,
            updated_at = ?
    `).run(
        params.exchange, symbol, tgUserId, minNotional, orderQuote > 0 ? orderQuote : defaultOrderQuote, buyOffset, sellOffset, refreshSec, invMin, invMax, now, now,
        tgUserId, orderQuote > 0 ? orderQuote : defaultOrderQuote, buyOffset, sellOffset, refreshSec, invMin, invMax, now
    );

    return getDevmmConfig(params.exchange, symbol)!;
}

export function disableDevmmConfig(exchange: DevmmExchange, symbol = "PEPEW/USDT"): boolean {
    const now = Date.now();
    const result = db.prepare(
        "UPDATE devmm_config SET is_enabled = 0, updated_at = ? WHERE exchange = ? AND symbol = ?"
    ).run(now, exchange, symbol);
    return result.changes > 0;
}

export function getEnabledDevmmConfigs(): DevmmConfig[] {
    return db.prepare(
        "SELECT * FROM devmm_config WHERE is_enabled = 1"
    ).all() as DevmmConfig[];
}

// ============= DevMM State Functions =============

export function getDevmmState(exchange: DevmmExchange, symbol = "PEPEW/USDT"): DevmmState | null {
    const row = db.prepare(
        "SELECT * FROM devmm_state WHERE exchange = ? AND symbol = ?"
    ).get(exchange, symbol) as DevmmState | undefined;
    return row || null;
}


export function upsertDevmmState(exchange: DevmmExchange, symbol: string, updates: Partial<Omit<DevmmState, "id" | "exchange" | "symbol">>): DevmmState {
    const now = Date.now();
    const existing = getDevmmState(exchange, symbol);

    if (!existing) {
        db.prepare(`
            INSERT INTO devmm_state (exchange, symbol, status, updated_at)
            VALUES (?, ?, 'STOPPED', ?)
        `).run(exchange, symbol, now);
    }

    const fields: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
        if (key === "id" || key === "exchange" || key === "symbol") continue;
        fields.push(`${key} = ?`);
        values.push(value);
    }

    if (fields.length > 0) {
        fields.push("updated_at = ?");
        values.push(now);
        values.push(exchange);
        values.push(symbol);
        db.prepare(`UPDATE devmm_state SET ${fields.join(", ")} WHERE exchange = ? AND symbol = ?`).run(...values);
    }

    return getDevmmState(exchange, symbol)!;
}

export function setDevmmStatus(exchange: DevmmExchange, symbol: string, status: DevmmStatus, pauseReason?: string | null): void {
    const now = Date.now();
    db.prepare(`
        UPDATE devmm_state SET status = ?, pause_reason = ?, updated_at = ?
        WHERE exchange = ? AND symbol = ?
    `).run(status, pauseReason ?? null, now, exchange, symbol);
}

export function updateDevmmAction(exchange: DevmmExchange, symbol: string, action: string): void {
    const now = Date.now();
    db.prepare(`
        UPDATE devmm_state SET last_action = ?, last_action_at = ?, updated_at = ?
        WHERE exchange = ? AND symbol = ?
    `).run(action, now, now, exchange, symbol);
}

export function updateDevmmError(exchange: DevmmExchange, symbol: string, error: string): void {
    const now = Date.now();
    db.prepare(`
        UPDATE devmm_state SET last_error = ?, last_error_at = ?, updated_at = ?
        WHERE exchange = ? AND symbol = ?
    `).run(error, now, now, exchange, symbol);
}

export function resetDevmmTurnover(exchange: DevmmExchange, symbol: string, dayBucket: string, hourBucket: string): void {
    const now = Date.now();
    db.prepare(`
        UPDATE devmm_state SET
            used_turnover_today_usdt = 0,
            used_turnover_hour_usdt = 0,
            day_bucket = ?,
            hour_bucket = ?,
            updated_at = ?
        WHERE exchange = ? AND symbol = ?
    `).run(dayBucket, hourBucket, now, exchange, symbol);
}

export function incrementDevmmTurnover(exchange: DevmmExchange, symbol: string, addUsdt: number): void {
    const now = Date.now();
    db.prepare(`
        UPDATE devmm_state SET
            used_turnover_today_usdt = used_turnover_today_usdt + ?,
            used_turnover_hour_usdt = used_turnover_hour_usdt + ?,
            updated_at = ?
        WHERE exchange = ? AND symbol = ?
    `).run(addUsdt, addUsdt, now, exchange, symbol);
}

// ============= DevMM Fills Functions =============

function normalizeDevmmExchangeKey(exchange: string): DevmmExchange {
    const normalized = String(exchange || "").trim().toLowerCase();
    if (normalized === "nonkyc") return "nonkyc";
    if (normalized === "dextrade" || normalized === "dex-trade") return "dextrade";
    if (normalized === "nestex") return "nestex";
    return normalized as DevmmExchange;
}

function normalizeDevmmSymbolKey(symbol: string): string {
    return String(symbol || "").trim().toUpperCase().replace(/_/g, "/");
}

export function insertDevmmFill(params: {
    exchange: DevmmExchange;
    symbol: string;
    side: "BUY" | "SELL";
    price: number;
    qtyPepew: number;
    quoteUsdt: number;
    feeUsdt?: number | null;
    orderId?: string | null;
    tradeId?: string | null;
}): DevmmFill {
    const now = Date.now();
    const exchangeKey = normalizeDevmmExchangeKey(params.exchange);
    const symbolKey = normalizeDevmmSymbolKey(params.symbol);
    // Use Asia/Taipei timezone (UTC+8) for day bucketing
    const d = new Date(now + 8 * 60 * 60 * 1000);
    const dayBucket = d.toISOString().slice(0, 10);
    const year = d.getUTCFullYear();
    const weekNum = getISOWeek(d);
    const weekBucket = `${year}-W${String(weekNum).padStart(2, "0")}`;
    const monthBucket = d.toISOString().slice(0, 7);

    const result = db.prepare(`
        INSERT INTO devmm_fills
        (ts, exchange, symbol, side, price, qty_pepew, quote_usdt, fee_usdt, order_id, trade_id, day_bucket, week_bucket, month_bucket)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        now,
        exchangeKey,
        symbolKey,
        params.side,
        params.price,
        params.qtyPepew,
        params.quoteUsdt,
        params.feeUsdt ?? null,
        params.orderId ?? null,
        params.tradeId ?? null,
        dayBucket,
        weekBucket,
        monthBucket
    );

    return {
        id: result.lastInsertRowid as number,
        ts: now,
        exchange: exchangeKey,
        symbol: symbolKey,
        side: params.side,
        price: params.price,
        qty_pepew: params.qtyPepew,
        quote_usdt: params.quoteUsdt,
        fee_usdt: params.feeUsdt ?? null,
        order_id: params.orderId ?? null,
        trade_id: params.tradeId ?? null,
        day_bucket: dayBucket,
        week_bucket: weekBucket,
        month_bucket: monthBucket,
    };
}

function getISOWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export interface DevmmReport {
    period: string;
    exchange: DevmmExchange;
    buyTurnoverUsdt: number;
    sellTurnoverUsdt: number;
    totalTurnoverUsdt: number;
    buyQtyPepew: number;
    sellQtyPepew: number;
    buyVwap: number | null;
    sellVwap: number | null;
    overallVwap: number | null;
    totalFeeUsdt: number | null;
    netUsdtChange: number;
    netPepewChange: number;
    fillCount: number;
    buyFillCount: number;
    sellFillCount: number;
}

export function getDevmmReport(exchange: DevmmExchange, periodType: "daily" | "weekly" | "monthly", bucket?: string): DevmmReport | null {
    const bucketColumn = periodType === "daily" ? "day_bucket" : periodType === "weekly" ? "week_bucket" : "month_bucket";

    let targetBucket = bucket;
    if (!targetBucket) {
        const now = Date.now();
        const d = new Date(now + 8 * 60 * 60 * 1000);
        if (periodType === "daily") {
            targetBucket = d.toISOString().slice(0, 10);
        } else if (periodType === "weekly") {
            const weekNum = getISOWeek(d);
            targetBucket = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
        } else {
            targetBucket = d.toISOString().slice(0, 7);
        }
    }
    const exchangeKey = normalizeDevmmExchangeKey(exchange);

    const rows = db.prepare(`
        SELECT
            UPPER(TRIM(side)) as side,
            SUM(
                CASE
                    WHEN price IS NOT NULL AND price > 0 AND qty_pepew IS NOT NULL AND qty_pepew > 0
                    THEN (price * qty_pepew)
                    ELSE quote_usdt
                END
            ) as total_quote,
            SUM(qty_pepew) as total_qty,
            SUM(fee_usdt) as total_fee,
            COUNT(*) as cnt
        FROM devmm_fills
        WHERE LOWER(TRIM(exchange)) = ? AND ${bucketColumn} = ? AND COALESCE(trade_id, '') != 'ASSUMED_VISIBILITY_TIMEOUT'
        GROUP BY UPPER(TRIM(side))
    `).all(exchangeKey, targetBucket) as Array<{ side: string; total_quote: number; total_qty: number; total_fee: number | null; cnt: number }>;

    if (rows.length === 0) {
        return null;
    }

    let buyTurnover = 0, sellTurnover = 0, buyQty = 0, sellQty = 0, totalFee = 0, fillCount = 0;
    let buyFillCount = 0, sellFillCount = 0;
    for (const row of rows) {
        fillCount += row.cnt;
        if (row.side === "BUY") {
            buyTurnover = row.total_quote;
            buyQty = row.total_qty;
            buyFillCount = row.cnt;
        } else {
            sellTurnover = row.total_quote;
            sellQty = row.total_qty;
            sellFillCount = row.cnt;
        }
        if (row.total_fee) totalFee += row.total_fee;
    }

    return {
        period: targetBucket,
        exchange: exchangeKey,
        buyTurnoverUsdt: buyTurnover,
        sellTurnoverUsdt: sellTurnover,
        totalTurnoverUsdt: buyTurnover + sellTurnover,
        buyQtyPepew: buyQty,
        sellQtyPepew: sellQty,
        buyVwap: buyQty > 0 ? buyTurnover / buyQty : null,
        sellVwap: sellQty > 0 ? sellTurnover / sellQty : null,
        overallVwap: (buyQty + sellQty) > 0 ? (buyTurnover + sellTurnover) / (buyQty + sellQty) : null,
        totalFeeUsdt: totalFee || null,
        netUsdtChange: sellTurnover - buyTurnover,
        netPepewChange: buyQty - sellQty,
        fillCount,
        buyFillCount,
        sellFillCount,
    };
}

export function getDevmmPauseStats(exchange: DevmmExchange, dayBucket: string): Record<string, number> {
    // This would track pause reasons but for simplicity we'll return empty for now
    // Could be enhanced to track in a separate table
    return {};
}

export default db;
