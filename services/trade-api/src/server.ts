import express from "express";
import fs from "fs";
import priceRoutes from "./routes/price.js";
import dcaRoutes from "./routes/dca.js";
import strategyRoutes from "./routes/strategy.js";
import keysRoutes from "./routes/keys.js";
import orderRoutes from "./routes/order.js";
import devmmRoutes from "./routes/devmm.js";
import { startScheduler } from "./scheduler.js";
import {
    checkpointWal,
    cleanupOldFailures,
    cleanupTradeAudit,
    getDbPath,
    getTradeAuditRetentionDays,
} from "./db.js";
import { tradeLog } from "./lib/tradeLogger.js";

const app = express();
app.use(express.json({ limit: "512kb" }));

const PORT = parseInt(process.env.PORT || "9195", 10);
const TRADE_AUDIT_RETENTION_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.TRADE_AUDIT_RETENTION_INTERVAL_MS || 24 * 60 * 60 * 1000)
);
const TRADE_WAL_CHECKPOINT_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.TRADE_WAL_CHECKPOINT_INTERVAL_MS || 10 * 60 * 1000)
);
const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PL8s5WjXUGhHVSo743dwEXGtsifV5YpdcD";
const DB_PATH = getDbPath();

// Health check
app.get("/healthz", (_req, res) => {
    res.json({
        ok: true,
        service: "trade-api",
        uptimeSec: Math.round(process.uptime()),
        donateAddress: DONATE_ADDRESS,
    });
});

// Readiness check
app.get("/readyz", (_req, res) => {
    const dbExists = fs.existsSync(DB_PATH);
    if (!dbExists) {
        return res.status(500).json({ ok: false, service: "trade-api", error: "DB not found" });
    }
    res.json({ ok: true, service: "trade-api", db: "ready" });
});

// Mount routes
app.use(priceRoutes);
app.use(dcaRoutes);
app.use(strategyRoutes);
app.use(keysRoutes);
app.use(orderRoutes);
app.use(devmmRoutes);

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    tradeLog({
        scope: "trade-api",
        level: "error",
        message: `[error] ${err.message}`,
    });
    res.status(500).json({ ok: false, error: err.message || "Internal server error" });
});

function runTradeAuditRetention(reason: string): void {
    try {
        const days = getTradeAuditRetentionDays();
        const deleted = cleanupTradeAudit(days);
        tradeLog({
            scope: "trade-api",
            level: "info",
            message: `trade_audit retention reason=${reason} days=${days} deleted=${deleted}`,
            throttleKey: `trade-api:retention:${reason}`,
            throttleSec: 30,
        });
    } catch (err: any) {
        tradeLog({
            scope: "trade-api",
            level: "error",
            message: `trade_audit retention failed reason=${reason} err=${err?.message || err}`,
            throttleKey: "trade-api:retention:error",
            throttleSec: 60,
        });
    }
}

function runWalCheckpoint(reason: string): void {
    try {
        const status = checkpointWal("TRUNCATE");
        tradeLog({
            scope: "trade-api",
            level: "info",
            message: `wal checkpoint reason=${reason} busy=${status.busy} log=${status.log} checkpointed=${status.checkpointed}`,
            throttleKey: `trade-api:wal:${reason}`,
            throttleSec: 30,
        });
    } catch (err: any) {
        tradeLog({
            scope: "trade-api",
            level: "error",
            message: `wal checkpoint failed reason=${reason} err=${err?.message || err}`,
            throttleKey: "trade-api:wal:error",
            throttleSec: 60,
        });
    }
}

// Start server
app.listen(PORT, () => {
    const dbExists = fs.existsSync(DB_PATH);
    tradeLog({ scope: "trade-api", level: "info", message: `Starting on port ${PORT}` });
    tradeLog({ scope: "trade-api", level: "info", message: `using db: ${DB_PATH}` });
    tradeLog({ scope: "trade-api", level: "info", message: `TRADE_DB_PATH exists: ${dbExists}` });
    tradeLog({ scope: "trade-api", level: "info", message: `Donate address: ${DONATE_ADDRESS}` });

    // Start DCA scheduler
    startScheduler();

    // Cleanup old failures
    try {
        const deleted = cleanupOldFailures(30); // 30 days retention
        tradeLog({ scope: "trade-api", level: "info", message: `Cleaned up ${deleted} old strategy failure(s)` });
    } catch (err: any) {
        tradeLog({ scope: "trade-api", level: "error", message: `Cleanup error: ${err.message}` });
    }

    runTradeAuditRetention("startup");
    runWalCheckpoint("startup");

    const retentionTimer = setInterval(() => runTradeAuditRetention("daily"), TRADE_AUDIT_RETENTION_INTERVAL_MS);
    retentionTimer.unref();

    const walTimer = setInterval(() => runWalCheckpoint("interval"), TRADE_WAL_CHECKPOINT_INTERVAL_MS);
    walTimer.unref();
});
