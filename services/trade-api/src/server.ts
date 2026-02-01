import express from "express";
import fs from "fs";
import priceRoutes from "./routes/price.js";
import dcaRoutes from "./routes/dca.js";
import strategyRoutes from "./routes/strategy.js";
import keysRoutes from "./routes/keys.js";
import orderRoutes from "./routes/order.js";
import { startScheduler } from "./scheduler.js";
import { cleanupOldFailures, getDbPath } from "./db.js";

const app = express();
app.use(express.json({ limit: "512kb" }));

const PORT = parseInt(process.env.PORT || "9195", 10);
const DONATE_ADDRESS =
    process.env.DONATE_ADDRESS ||
    process.env.TRADE_DONATE_ADDRESS ||
    "PDep1ZNhCyqyRwjnQif8K6tPGsE7TvhyT6";
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

// Mount routes
app.use(priceRoutes);
app.use(dcaRoutes);
app.use(strategyRoutes);
app.use(keysRoutes);
app.use(orderRoutes);

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[error] ${err.message}`);
    res.status(500).json({ ok: false, error: err.message || "Internal server error" });
});

// Start server
app.listen(PORT, () => {
    const dbExists = fs.existsSync(DB_PATH);
    console.log(`[trade-api] Starting on port ${PORT}`);
    console.log(`[trade-api] using db: ${DB_PATH}`);
    console.log(`[trade-api] TRADE_DB_PATH exists: ${dbExists}`);
    console.log(`[trade-api] Donate address: ${DONATE_ADDRESS}`);

    // Start DCA scheduler
    startScheduler();

    // Cleanup old failures
    try {
        const deleted = cleanupOldFailures(30); // 30 days retention
        console.log(`[trade-api] Cleaned up ${deleted} old strategy failure(s)`);
    } catch (err: any) {
        console.error(`[trade-api] Cleanup error: ${err.message}`);
    }
});
