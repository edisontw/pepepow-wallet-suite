#!/usr/bin/env node
/**
 * Exchange API Self-Test Script
 * 
 * Tests connectivity and authentication for NonKYC, Dex-Trade, and NestEx exchanges.
 * Run with environment variables for API credentials.
 * 
 * Usage:
 *   NONKYC_API_KEY=xxx NONKYC_API_SECRET=yyy node dist/scripts/selftest-exchanges.js --exchange=nonkyc
 *   DEXTRADE_LOGIN_TOKEN=xxx DEXTRADE_SECRET=yyy node dist/scripts/selftest-exchanges.js --exchange=dextrade
 *   NESTEX_API_KEY=xxx NESTEX_API_SECRET=yyy node dist/scripts/selftest-exchanges.js --exchange=nestex
 *   
 * Add --debug to enable verbose output (equivalent to setting *_DEBUG=1)
 */

import { getNonkycBalances, generateNonkycCurl } from "../exchanges/nonkyc.js";
import { getDexTradeBalances } from "../exchanges/dextrade.js";
import { checkNestExToken, getNestExBalances } from "../exchanges/nestex.js";

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const exchangeArg = args.find((a) => a.startsWith("--exchange="))?.split("=")[1];
const debugArg = args.includes("--debug");
const allArg = args.includes("--all");

if (debugArg) {
    process.env.NONKYC_DEBUG = "1";
    process.env.DEXTRADE_DEBUG = "1";
    process.env.NESTEX_DEBUG = "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function printResult(exchangeName: string, testName: string, result: { ok: boolean; status?: number; error?: string; data?: any }) {
    const icon = result.ok ? "✓" : "✗";
    const color = result.ok ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    console.log(`${color}${icon}${reset} [${exchangeName}] ${testName}: ${result.ok ? "SUCCESS" : "FAILED"}`);

    if (!result.ok) {
        console.log(`  Status: ${result.status}`);
        console.log(`  Error: ${result.error}`);
    }

    if (debugArg && result.data) {
        console.log(`  Data: ${JSON.stringify(result.data, null, 2).slice(0, 500)}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NonKYC Tests
// ─────────────────────────────────────────────────────────────────────────────

async function testNonkyc() {
    const apiKey = process.env.NONKYC_API_KEY;
    const apiSecret = process.env.NONKYC_API_SECRET;

    console.log("\n━━━ NonKYC Exchange ━━━");

    if (!apiKey || !apiSecret) {
        console.log("⚠ Skipping: NONKYC_API_KEY and NONKYC_API_SECRET not set");
        console.log("  Set these environment variables and run again.");
        return false;
    }

    console.log(`Using API key: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);

    // Test 1: Fetch balances (private endpoint)
    const balanceResult = await getNonkycBalances(apiKey, apiSecret);
    printResult("NonKYC", "Fetch Balances", balanceResult);

    if (!balanceResult.ok) {
        // Print curl command for debugging
        console.log("\n  Debug curl command (secrets masked):");
        const curl = generateNonkycCurl({
            method: "GET",
            endpoint: "/balances",
            apiKey,
            apiSecret,
        });
        console.log(`  ${curl.split("\n").join("\n  ")}`);
    }

    return balanceResult.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dex-Trade Tests
// ─────────────────────────────────────────────────────────────────────────────

async function testDextrade() {
    const loginToken = process.env.DEXTRADE_LOGIN_TOKEN;
    const secret = process.env.DEXTRADE_SECRET;

    console.log("\n━━━ Dex-Trade Exchange ━━━");

    if (!loginToken || !secret) {
        console.log("⚠ Skipping: DEXTRADE_LOGIN_TOKEN and DEXTRADE_SECRET not set");
        console.log("  Set these environment variables and run again.");
        return false;
    }

    console.log(`Using token: ${loginToken.slice(0, 4)}...${loginToken.slice(-4)}`);

    // Test 1: Fetch balances (private endpoint)
    const balanceResult = await getDexTradeBalances(loginToken, secret);
    printResult("Dex-Trade", "Fetch Balances", balanceResult);

    return balanceResult.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// NestEx Tests
// ─────────────────────────────────────────────────────────────────────────────

async function testNestex() {
    const apiKey = process.env.NESTEX_API_KEY;
    const apiSecret = process.env.NESTEX_API_SECRET;

    console.log("\n━━━ NestEx Exchange ━━━");

    if (!apiKey || !apiSecret) {
        console.log("⚠ Skipping: NESTEX_API_KEY and NESTEX_API_SECRET not set");
        console.log("  Set these environment variables and run again.");
        return false;
    }

    console.log(`Using API key: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);

    const rateLimitKey = "selftest";

    // Test 1: Check token validity
    const tokenResult = await checkNestExToken(apiKey, apiSecret, rateLimitKey);
    printResult("NestEx", "Check Token", tokenResult);

    if (!tokenResult.ok) {
        return false;
    }

    // Test 2: Fetch balances
    const balanceResult = await getNestExBalances(apiKey, apiSecret, rateLimitKey);
    printResult("NestEx", "Fetch Balances", balanceResult);

    return balanceResult.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  Exchange API Self-Test");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Debug mode: ${debugArg ? "ON" : "OFF"}`);
    console.log(`  Exchange filter: ${exchangeArg || "all"}`);

    const results: Record<string, boolean | undefined> = {};

    if (!exchangeArg || exchangeArg === "nonkyc" || allArg) {
        results.nonkyc = await testNonkyc();
    }

    if (!exchangeArg || exchangeArg === "dextrade" || allArg) {
        results.dextrade = await testDextrade();
    }

    if (!exchangeArg || exchangeArg === "nestex" || allArg) {
        results.nestex = await testNestex();
    }

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════════");

    let hasFailures = false;
    let hasTests = false;
    for (const [exchange, passed] of Object.entries(results)) {
        if (passed === undefined) {
            console.log(`  ${exchange}: SKIPPED (no credentials)`);
        } else if (passed) {
            console.log(`  ${exchange}: \x1b[32mPASSED\x1b[0m`);
            hasTests = true;
        } else {
            console.log(`  ${exchange}: \x1b[31mFAILED\x1b[0m`);
            hasFailures = true;
            hasTests = true;
        }
    }

    if (!hasTests) {
        console.log("\n⚠ No tests ran. Set API credentials for at least one exchange.");
    }

    console.log("");
    process.exit(hasFailures ? 1 : 0);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
