import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "wallet.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id TEXT UNIQUE NOT NULL,
    tg_username TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    address TEXT NOT NULL UNIQUE,
    label TEXT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_address_user_id ON user_address(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_address_is_default ON user_address(is_default);

  CREATE TABLE IF NOT EXISTS payment_request (
    id TEXT PRIMARY KEY,
    from_user_id INTEGER NOT NULL REFERENCES user(id),
    to_tg_user_id TEXT NOT NULL,
    to_username TEXT NULL,
    amount_sats INTEGER NULL,
    memo TEXT NULL,
    status TEXT NOT NULL, -- pending|claimed|expired|canceled
    claimed_address TEXT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_payment_request_to_tg_user_id ON payment_request(to_tg_user_id);
  CREATE INDEX IF NOT EXISTS idx_payment_request_status ON payment_request(status);
`);

export interface User {
    id: number;
    tg_user_id: string;
    tg_username?: string;
    created_at: string;
    updated_at: string;
}

export interface UserAddress {
    id: number;
    user_id: number;
    address: string;
    label?: string;
    is_default: number;
    created_at: string;
    last_seen_at?: string;
}

export interface PaymentRequest {
    id: string;
    from_user_id: number;
    to_tg_user_id: string;
    to_username?: string;
    amount_sats?: number;
    memo?: string;
    status: string;
    claimed_address?: string;
    created_at: string;
    expires_at: string;
}

export function upsertUser(tgUserId: string, username?: string): User {
    const now = new Date().toISOString();
    const row = db.prepare("SELECT * FROM user WHERE tg_user_id = ?").get(tgUserId) as User | undefined;

    if (row) {
        if (row.tg_username !== username) {
            db.prepare("UPDATE user SET tg_username = ?, updated_at = ? WHERE id = ?")
                .run(username, now, row.id);
            return { ...row, tg_username: username, updated_at: now };
        }
        return row;
    }

    const result = db.prepare(
        "INSERT INTO user (tg_user_id, tg_username, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(tgUserId, username, now, now);

    return {
        id: result.lastInsertRowid as number,
        tg_user_id: tgUserId,
        tg_username: username,
        created_at: now,
        updated_at: now,
    };
}

export function setDefaultAddress(tgUserId: string, address: string, label?: string) {
    const user = upsertUser(tgUserId);
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
        // Reset other defaults
        db.prepare("UPDATE user_address SET is_default = 0 WHERE user_id = ?").run(user.id);

        // Upsert address
        const existing = db.prepare("SELECT * FROM user_address WHERE address = ?").get(address) as UserAddress | undefined;
        if (existing) {
            db.prepare("UPDATE user_address SET user_id = ?, label = ?, is_default = 1, last_seen_at = ? WHERE id = ?")
                .run(user.id, label || existing.label, now, existing.id);
        } else {
            db.prepare(
                "INSERT INTO user_address (user_id, address, label, is_default, created_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)"
            ).run(user.id, address, label || null, now, now);
        }
    });

    tx();
}

export type ResolveStatus = "ok" | "user_not_found" | "no_default_address";

export function resolveUserDetail(toTgUserId?: string, username?: string) {
    if (toTgUserId) {
        const user = db.prepare("SELECT * FROM user WHERE tg_user_id = ?").get(toTgUserId) as User | undefined;
        if (!user) return { status: "user_not_found" as const };
        const row = db.prepare("SELECT address FROM user_address WHERE user_id = ? AND is_default = 1")
            .get(user.id) as { address: string } | undefined;
        if (!row?.address) return { status: "no_default_address" as const };
        return { status: "ok" as const, address: row.address };
    }
    if (username) {
        const cleanUsername = username.startsWith("@") ? username.substring(1) : username;
        const user = db.prepare("SELECT * FROM user WHERE tg_username = ?").get(cleanUsername) as User | undefined;
        if (!user) return { status: "user_not_found" as const };
        const row = db.prepare("SELECT address FROM user_address WHERE user_id = ? AND is_default = 1")
            .get(user.id) as { address: string } | undefined;
        if (!row?.address) return { status: "no_default_address" as const };
        return { status: "ok" as const, address: row.address };
    }
    return { status: "user_not_found" as const };
}

export function createPaymentRequest(
    fromTgUserId: string,
    toTgUserId: string,
    toUsername?: string,
    amountSats?: number,
    memo?: string,
    ttlSec = 86400
) {
    const user = upsertUser(fromTgUserId);
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSec * 1000).toISOString();
    const createdAt = now.toISOString();

    db.prepare(`
    INSERT INTO payment_request (id, from_user_id, to_tg_user_id, to_username, amount_sats, memo, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, user.id, toTgUserId, toUsername || null, amountSats || null, memo || null, createdAt, expiresAt);

    return { id, expiresAt };
}

export function claimPaymentRequest(requestId: string, toTgUserId: string, address: string) {
    const now = new Date().toISOString();
    const req = db.prepare("SELECT * FROM payment_request WHERE id = ?").get(requestId) as PaymentRequest | undefined;

    if (!req) {
        const err = new Error("Payment request not found");
        (err as any).status = 404;
        throw err;
    }
    if (req.to_tg_user_id !== toTgUserId) {
        const err = new Error("Unauthorized to claim this request");
        (err as any).status = 403;
        throw err;
    }
    if (req.status !== "pending") throw new Error(`Request is already ${req.status}`);
    if (new Date(req.expires_at) < new Date()) {
        db.prepare("UPDATE payment_request SET status = 'expired' WHERE id = ?").run(requestId);
        throw new Error("Request has expired");
    }

    const tx = db.transaction(() => {
        db.prepare("UPDATE payment_request SET status = 'claimed', claimed_address = ? WHERE id = ?")
            .run(address, requestId);

        // Also set as default address for this user
        setDefaultAddress(toTgUserId, address);
    });

    tx();
}

export function getPaymentRequest(requestId: string): PaymentRequest | null {
    const req = db.prepare("SELECT * FROM payment_request WHERE id = ?").get(requestId) as PaymentRequest | undefined;
    if (!req) return null;

    // Auto-expire if needed
    if (req.status === "pending" && new Date(req.expires_at) < new Date()) {
        db.prepare("UPDATE payment_request SET status = 'expired' WHERE id = ?").run(requestId);
        req.status = "expired";
    }

    return req;
}

export default db;
