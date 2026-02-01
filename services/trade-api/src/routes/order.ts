import { Router } from "express";
import { z } from "zod";
import { getExchangeKey } from "../db.js";
import { decryptKeyPair } from "../crypto.js";
import { createDexTradeOrder } from "../exchanges/dextrade.js";
import { createNonKycOrder } from "../exchanges/nonkyc.js";
import { fetchDexTradeTicker } from "./price.js";
import { supportsReal } from "../lib/exchanges.js";

const router = Router();

const OrderSchema = z.object({
    tgUserId: z.string().min(1),
    symbol: z.string().min(1),
    side: z.enum(["BUY", "SELL"]).default("BUY"),
    quoteAmount: z.number().positive(),
    price: z.number().positive().optional(),
    tradeType: z.enum(["MARKET", "LIMIT"]).optional(),
});

function fallbackPrice(last: number | null, bid: number | null, ask: number | null): number | null {
    if (last !== null && last > 0) return last;
    if (bid !== null && ask !== null && bid > 0 && ask > 0) return (bid + ask) / 2;
    if (bid !== null && bid > 0) return bid;
    if (ask !== null && ask > 0) return ask;
    return null;
}

// POST /v1/exchange/:exchange/order
router.post("/v1/exchange/:exchange/order", async (req, res) => {
    const exchange = req.params.exchange;

    if (!supportsReal(exchange)) {
        console.log(`[order] REAL rejected: exchange=${exchange} supportsReal=false`);
        return res.status(400).json({ ok: false, error: "REAL mode not supported for this exchange yet" });
    }

    try {
        const parsed = OrderSchema.parse(req.body);

        const keyRecord = getExchangeKey(parsed.tgUserId, exchange);
        if (!keyRecord) {
            return res.status(400).json({ ok: false, error: "API keys not set for this exchange" });
        }

        const decrypted = decryptKeyPair({
            keyCipher: keyRecord.key_cipher,
            secretCipher: keyRecord.secret_cipher,
            iv: keyRecord.iv,
            tag: keyRecord.tag,
        });

        let price = parsed.price ?? null;
        if (!price) {
            const ticker = await fetchDexTradeTicker();
            price = fallbackPrice(ticker.ticker.last, ticker.ticker.bid, ticker.ticker.ask);
        }

        if (!price || !Number.isFinite(price) || price <= 0) {
            return res.status(400).json({ ok: false, error: "Unable to determine price" });
        }

        const volumeBase = parsed.quoteAmount / price;
        if (!Number.isFinite(volumeBase) || volumeBase <= 0) {
            return res.status(400).json({ ok: false, error: "Invalid volume" });
        }

        const orderResult = await createDexTradeOrder({
            loginToken: decrypted.apiKey,
            secret: decrypted.apiSecret,
            pair: parsed.symbol,
            side: parsed.side,
            tradeType: parsed.tradeType || "MARKET",
            volume: volumeBase,
            rate: parsed.price,
        });

        if (!orderResult.ok) {
            return res.status(502).json({
                ok: false,
                error: orderResult.error || "Order failed",
                exchangeStatus: orderResult.status,
                exchangeCode: orderResult.code ?? null,
            });
        }

        res.json({
            ok: true,
            exchangeStatus: orderResult.status,
            data: orderResult.data,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ ok: false, error: "Invalid input" });
        }
        console.error(`[order] error exchange=${exchange} message=${err?.message || err}`);
        res.status(500).json({ ok: false, error: "Order failed" });
    }
});

export default router;
