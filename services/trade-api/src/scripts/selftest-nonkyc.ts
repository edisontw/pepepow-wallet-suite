/**
 * NonKYC private API self-test (masked output).
 *
 * Usage:
 *   NONKYC_API_KEY=xxx NONKYC_API_SECRET=yyy node dist/scripts/selftest-nonkyc.js
 *   TG_USER_ID=123456 node dist/scripts/selftest-nonkyc.js
 */

import { getNonkycBalances } from "../exchanges/nonkyc.js";
import { getExchangeKey } from "../db.js";
import { decryptKeyPair } from "../crypto.js";

function maskValue(value: string): string {
    if (!value || value.length < 8) return "***";
    return value.slice(0, 4) + "..." + value.slice(-4);
}

async function loadKeys(): Promise<{ apiKey: string; apiSecret: string } | null> {
    const envKey = process.env.NONKYC_API_KEY || "";
    const envSecret = process.env.NONKYC_API_SECRET || "";
    if (envKey && envSecret) {
        return { apiKey: envKey, apiSecret: envSecret };
    }

    const tgUserId = process.env.TG_USER_ID;
    if (tgUserId) {
        const record = getExchangeKey(String(tgUserId), "nonkyc");
        if (!record) return null;
        const decrypted = decryptKeyPair({
            keyCipher: record.key_cipher,
            secretCipher: record.secret_cipher,
            iv: record.iv,
            tag: record.tag,
        });
        return { apiKey: decrypted.apiKey, apiSecret: decrypted.apiSecret };
    }

    return null;
}

async function run(): Promise<void> {
    const keys = await loadKeys();
    if (!keys) {
        console.error("Missing keys. Provide NONKYC_API_KEY/NONKYC_API_SECRET or TG_USER_ID.");
        process.exit(1);
    }

    console.log(`[selftest] NonKYC key=${maskValue(keys.apiKey)} secret=${maskValue(keys.apiSecret)}`);
    const result = await getNonkycBalances(keys.apiKey, keys.apiSecret);
    console.log("[selftest] result:", JSON.stringify(result, null, 2));
}

run().catch((err) => {
    console.error("[selftest] error:", err?.message || err);
    process.exit(1);
});
