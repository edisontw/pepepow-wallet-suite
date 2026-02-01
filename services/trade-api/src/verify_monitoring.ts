
import db from "./db.js";
import { dcaRunner } from "./strategies/dcaRunner.js";
import { upsertStrategyConfig, getLatestFailure, getBackoffState, resetBackoff } from "./db.js";

// Mock environment
process.env.TRADE_DB_PATH = ":memory:"; // Use in-memory DB for testing
// Re-initialize DB (hack: db is already initialized on import, but we can't easily switch it. 
// However, if we run this script standalone, it will use the default path unless we set env BEFORE import if import is side-effectful.)
// Actually db.ts initializes 'db' at top level. 
// So setting process.env.TRADE_DB_PATH *before* import is crucial. 
// But we already imported. 
// Standard trick: set env in a separate file or use a launcher. 
// Or, if db.ts exports a function to get db, we might be stuck with the real DB path if we don't be careful.

// Let's check db.ts again. It does `const dbPath = process.env.TRADE_DB_PATH ... const db = new Database(dbPath)`.
// So we must set env before import.
// This script will be run with `ts-node verify_monitoring.ts`. 
// I will create a launcher logic or just rely on setting ENV in the command line.

// To make this script self-contained if possible:
// We can't un-import.
// I will write the script assuming it's run with `TRADE_DB_PATH=:memory: ts-node verify_monitoring.ts`
// or I can put the import *after* setting env but ES modules hoist imports.

/*
  Usage: 
  export TRADE_DB_PATH=":memory:"
  npx ts-node src/verify_monitoring.ts
*/

async function runTest() {
    console.log("Starting Low-Noise Monitoring Verification...");

    // 1. Setup Config
    const config = upsertStrategyConfig({
        tgUserId: "test_user",
        exchange: "nonkyc",
        pair: "TEST/USDT", // Invalid pair to trigger price fetch error?
        tradeMode: "REAL",
        strategy: "DCA",
        paramsJson: JSON.stringify({ budget: 10, intervalSec: 10 }),
        enabled: true
    });
    console.log(`Created config id=${config.id}`);

    // 2. Trigger Failure (Price Fetch Error expected for TEST/USDT)
    console.log("\n--- Tick 1: Expect Failure ---");
    let now = Date.now();
    await dcaRunner.tick(config.id, now);

    let failure = getLatestFailure(config.id);
    let backoff = getBackoffState(config.id);
    console.log("Failure:", failure ? `${failure.category}: ${failure.message}` : "None");
    console.log("Backoff:", backoff.isInBackoff ? `YES until ${backoff.nextAllowedAt}, failures=${backoff.consecutiveFailures}` : "NO");

    if (!failure) {
        console.error("❌ FAILED: No failure recorded.");
        return;
    }
    if (backoff.consecutiveFailures !== 1) {
        console.error(`❌ FAILED: Consecutive failures should be 1, got ${backoff.consecutiveFailures}`);
    }

    // 3. Trigger Immediate Retry (Should be Backed Off)
    console.log("\n--- Tick 2: Immediate Retry (Should Skip) ---");
    // Advance time slightly 1s
    now += 1000;
    await dcaRunner.tick(config.id, now);

    // Check if failure count increased (should NOT increase if skipped)
    let failure2 = getLatestFailure(config.id);
    if (failure2 && failure2.count > 1) { // count is aggregation count
        console.log("Warning: Failure count increased. Did it run?");
    }
    // But consecutive failures in config should remain 1? 
    // Wait, if it returns early, nothing changes.
    // If it ran and failed again, consecutive would be 2.
    // getBackoffState reads DB.
    backoff = getBackoffState(config.id);
    console.log("Backoff state after immediate retry:", backoff.consecutiveFailures);
    if (backoff.consecutiveFailures !== 1) {
        console.error("❌ FAILED: Backoff should prevent execution, consecutive failures should stay 1.");
    }

    // 4. Advance Time past Backoff (30s default for 1st failure?) 
    // classify.ts: calculateBackoffMs(1) -> 30000? Let's check classify.ts logic.
    // 1 -> 30s. 2 -> 60s.
    console.log("\n--- Tick 3: After Backoff (Expect Run & Fail) ---");
    now += 35000; // 35s later
    await dcaRunner.tick(config.id, now);

    backoff = getBackoffState(config.id);
    console.log("Backoff state after 35s:", backoff.consecutiveFailures);
    if (backoff.consecutiveFailures !== 2) {
        console.error(`❌ FAILED: Should have run and failed again. Consecutive=${backoff.consecutiveFailures}`);
    } else {
        console.log("✅ verified: Strategy ran and failed, increasing consecutive failures.");
    }

    // 5. Test Auto-Disable (FATAL)
    // We need to trigger a FATAL error.
    // "AUTH_FAILED" is FATAL.
    // How to trigger AUTH_FAILED in DCA Runner?
    // We need REAL mode and missing/invalid keys.
    console.log("\n--- Tick 4: FATAL Error (REAL mode, no keys) ---");

    const fatalConfig = upsertStrategyConfig({
        tgUserId: "test_user_fatal",
        exchange: "nonkyc",
        pair: "PEPEW/USDT", // Valid pair to pass price check?
        // Wait, if price check fails (which it might if we don't mock), we verify "Price fetch failed" -> RETRIABLE.
        // We need price check to PASS to reach key check.
        // We can't easily make price check pass without mocking.

        // Alternative: Use "INVALID_MARKET" error? 
        // If price fetch returns "Price unavailable", classify.ts might map it.
        // classify.ts details: 
        // "Price unavailable" -> RETRIABLE?
        // "INVALID_MARKET" code -> FATAL.

        tradeMode: "REAL",
        strategy: "DCA",
        paramsJson: JSON.stringify({ budget: 10, intervalSec: 10 }),
        enabled: true
    });

    // We can manually insert a FATAL failure to test auto-disable logic?
    // No, we want to test the runner.
    // dcaRunner:
    // 1. fetchExchangePrice.
    // If I can't make this succeed, I can't reach the "REAL mode missing keys" check.

    // However, I can test if clean up works.
}

runTest().catch(console.error);
