import Database from "better-sqlite3";
import path from "path";
import { normalizePairSymbol } from "./lib/markets.js";

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

    return {
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
}

export function updateStrategyOrderStatus(orderId: number, status: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE trade_strategy_order SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, now, orderId);
}

export function cancelOpenStrategyOrders(configId: number): number {
    const now = Date.now();
    const result = db.prepare(
        "UPDATE trade_strategy_order SET status = 'CANCELED', updated_at = ? WHERE config_id = ? AND status = 'OPEN'"
    ).run(now, configId);
    return result.changes;
}

export function cancelOpenGridOrders(configId: number): number {
    const now = Date.now();
    const result = db.prepare(
        "UPDATE grid_order SET status = 'CANCELLED', updated_at = ? WHERE config_id = ? AND status = 'OPEN'"
    ).run(now, configId);
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

    return {
        id: result.lastInsertRowid as number,
        order_id: params.orderId,
        config_id: params.configId,
        price: params.price,
        qty: params.qty,
        fee: params.fee ?? null,
        ts,
    };
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
    db.prepare(
        "UPDATE grid_order SET status = ?, updated_at = ? WHERE order_id = ?"
    ).run(status, now, orderId);
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

export default db;
