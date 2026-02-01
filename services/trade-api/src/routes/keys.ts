import { Router } from "express";
import { z } from "zod";
import { encryptKeyPair, isCryptoConfigured, getCryptoError } from "../crypto.js";
import { upsertExchangeKey, listExchangeKeys, clearExchangeKey, getExchangeKey } from "../db.js";
import { checkNestExToken } from "../exchanges/nestex.js";
import crypto from "crypto";

const router = Router();

const ExchangeEnum = z.enum(["nonkyc", "dextrade", "nestex"]);

const SetKeysSchema = z.object({
    tgUserId: z.string().min(1),
    exchange: ExchangeEnum,
    apiKey: z.string().min(1),
    apiSecret: z.string().min(1),
    validate: z.boolean().optional(),
});

const ClearKeysSchema = z.object({
    tgUserId: z.string().min(1),
    exchange: ExchangeEnum,
});

// Hash user ID for logging (privacy)
function hashUserId(userId: string): string {
    return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

// POST /v1/keys/set
router.post("/v1/keys/set", async (req, res) => {
    const userIdHash = hashUserId(req.body?.tgUserId || "unknown");
    const exchange = req.body?.exchange || "unknown";

    try {
        // Check if crypto is configured before attempting encryption
        if (!isCryptoConfigured()) {
            const errMsg = getCryptoError() || "Encryption key not configured";
            console.error(`[keys] set error: MISSING_KEYS_ENC_KEY user=${userIdHash} exchange=${exchange} reason=${errMsg}`);
            return res.status(500).json({
                ok: false,
                error: "MISSING_KEYS_ENC_KEY",
                message: "Key storage is not configured"
            });
        }

        const parsed = SetKeysSchema.parse(req.body);
        const enc = encryptKeyPair(parsed.apiKey, parsed.apiSecret);

        const record = upsertExchangeKey(
            parsed.tgUserId,
            parsed.exchange,
            enc.keyCipher,
            enc.secretCipher,
            enc.iv,
            enc.tag
        );

        console.log(`[keys] set success: user=${userIdHash} exchange=${parsed.exchange}`);

        let validation: { ok: boolean; error?: string } | undefined;
        if (parsed.exchange === "nestex" && parsed.validate) {
            const rateLimitKey = `${parsed.tgUserId}:nestex`;
            const validationResult = await checkNestExToken(parsed.apiKey, parsed.apiSecret, rateLimitKey);
            validation = validationResult.ok
                ? { ok: true }
                : { ok: false, error: validationResult.error || "Check token failed" };
        }

        res.json({
            ok: true,
            exchange: record.exchange,
            updatedAt: record.updated_at,
            validation,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            console.error(`[keys] set error: VALIDATION_ERROR user=${userIdHash} exchange=${exchange} issues=${JSON.stringify(err.issues)}`);
            return res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid input" });
        }

        // Check for SQLite errors
        const isSqliteError = err?.code?.startsWith?.("SQLITE_") || err?.message?.includes?.("SQLITE");
        if (isSqliteError) {
            console.error(`[keys] set error: SQLITE_ERROR user=${userIdHash} exchange=${exchange} code=${err.code || "n/a"} msg=${err.message}`);
            return res.status(500).json({ ok: false, error: "SQLITE_ERROR", message: "Database error" });
        }

        // Generic crypto or other error
        console.error(`[keys] set error: CRYPTO_ERROR user=${userIdHash} exchange=${exchange} msg=${err?.message || err}`);
        res.status(500).json({ ok: false, error: "CRYPTO_ERROR", message: "Failed to save keys" });
    }
});

// GET /v1/keys/status
router.get("/v1/keys/status", (req, res) => {
    try {
        const tgUserId = req.query.tgUserId as string;
        if (!tgUserId) {
            return res.status(400).json({ ok: false, error: "tgUserId query param required" });
        }

        const exchange = req.query.exchange as string | undefined;
        if (exchange) {
            const parsedExchange = ExchangeEnum.parse(exchange);
            const record = getExchangeKey(tgUserId, parsedExchange);
            return res.json({
                ok: true,
                keys: [record ? {
                    exchange: record.exchange,
                    updatedAt: record.updated_at,
                    createdAt: record.created_at,
                } : {
                    exchange: parsedExchange,
                    updatedAt: null,
                    createdAt: null,
                }],
            });
        }

        const records = listExchangeKeys(tgUserId);
        res.json({
            ok: true,
            keys: records.map((record) => ({
                exchange: record.exchange,
                updatedAt: record.updated_at,
                createdAt: record.created_at,
            })),
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid exchange" });
        }
        console.error(`[keys] status error: ${err?.message || err}`);
        res.status(500).json({ ok: false, error: "Failed to fetch keys" });
    }
});

// POST /v1/keys/clear
router.post("/v1/keys/clear", (req, res) => {
    try {
        const parsed = ClearKeysSchema.parse(req.body);
        const cleared = clearExchangeKey(parsed.tgUserId, parsed.exchange);
        res.json({ ok: true, cleared });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input" });
        }
        console.error(`[keys] clear error: ${err?.message || err}`);
        res.status(500).json({ ok: false, error: "Failed to clear keys" });
    }
});

export default router;
