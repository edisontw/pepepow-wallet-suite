import { Router } from "express";
import { getPriceOverview } from "../lib/price/aggregator.js";
import { fetchNonKycTicker } from "../lib/price/sources/nonkyc.js";
import { fetchDexTradeTicker } from "../lib/price/sources/dextrade.js";
import { fetchNestExTicker } from "../lib/price/sources/nestex.js";

const router = Router();

// GET /v1/price
router.get("/v1/price", async (req, res) => {
    const includeDebug = req.query.debug === "1" || req.query.debug === "true";
    const includeSources = includeDebug;

    try {
        const overview = await getPriceOverview({ includeSources, includeDebug });
        res.json(overview);
    } catch (err: any) {
        console.error(`[price] aggregator error: ${err?.message || err}`);
        res.status(500).json({ ok: false, error: "Price aggregation failed" });
    }
});

// Export fetch functions for scheduler/order compatibility
export { fetchNonKycTicker, fetchDexTradeTicker, fetchNestExTicker };

export default router;
