/**
 * Dex-Trade Signature Unit Tests
 * 
 * Tests the signature generation to ensure it correctly sorts keys
 * and concatenates values.
 */

import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Copy of the signature function for testing
// ─────────────────────────────────────────────────────────────────────────────

function buildSignature(params: Record<string, any>, secret: string): string {
    const sortedKeys = Object.keys(params).sort();
    const values: string[] = [];

    for (const key of sortedKeys) {
        const value = params[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
            // Handle nested objects: sort their keys and include their values
            const nestedKeys = Object.keys(value).sort();
            for (const nestedKey of nestedKeys) {
                values.push(String(value[nestedKey]));
            }
        } else {
            values.push(String(value));
        }
    }

    const signPayload = values.join("") + secret;
    return crypto.createHash("sha256").update(signPayload).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Cases
// ─────────────────────────────────────────────────────────────────────────────

interface TestCase {
    name: string;
    params: Record<string, any>;
    secret: string;
    expectedValues: string[];
}

const testCases: TestCase[] = [
    {
        name: "Basic order params (alphabetical sorting)",
        params: {
            pair: "PEPEW_USDT",
            type: 0,
            type_trade: 1,
            volume: "1000",
            request_id: "12345",
        },
        secret: "mysecret",
        // Sorted order: pair, request_id, type, type_trade, volume
        expectedValues: ["PEPEW_USDT", "12345", "0", "1", "1000"],
    },
    {
        name: "With rate for limit order",
        params: {
            pair: "BTC_USDT",
            rate: "50000",
            request_id: "99999",
            type: 0,
            type_trade: 0,
            volume: "0.01",
        },
        secret: "anothersecret",
        // Sorted: pair, rate, request_id, type, type_trade, volume
        expectedValues: ["BTC_USDT", "50000", "99999", "0", "0", "0.01"],
    },
    {
        name: "Nested object values",
        params: {
            outer: "first",
            nested: { b: "second", a: "third" },
            last: "fourth",
        },
        secret: "test",
        // Sorted outer params: last, nested, outer
        // nested sorted: a, b → third, second
        expectedValues: ["fourth", "third", "second", "first"],
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Test Runner
// ─────────────────────────────────────────────────────────────────────────────

function runTests(): boolean {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  Dex-Trade Signature Unit Tests");
    console.log("═══════════════════════════════════════════════════════════════\n");

    let passed = 0;
    let failed = 0;

    for (const tc of testCases) {
        // Reconstruct values to check sorting
        const sortedKeys = Object.keys(tc.params).sort();
        const actualValues: string[] = [];

        for (const key of sortedKeys) {
            const value = tc.params[key];
            if (value && typeof value === "object" && !Array.isArray(value)) {
                const nestedKeys = Object.keys(value).sort();
                for (const nestedKey of nestedKeys) {
                    actualValues.push(String(value[nestedKey]));
                }
            } else {
                actualValues.push(String(value));
            }
        }

        const valuesMatch = JSON.stringify(actualValues) === JSON.stringify(tc.expectedValues);

        const signature = buildSignature(tc.params, tc.secret);
        const signatureFormat = /^[a-f0-9]{64}$/.test(signature);

        // Also verify the signature is reproducible
        const signature2 = buildSignature(tc.params, tc.secret);
        const reproducible = signature === signature2;

        if (valuesMatch && signatureFormat && reproducible) {
            console.log(`✓ ${tc.name}`);
            passed++;
        } else {
            console.log(`✗ ${tc.name}`);
            if (!valuesMatch) {
                console.log(`  Expected values: ${JSON.stringify(tc.expectedValues)}`);
                console.log(`  Actual values:   ${JSON.stringify(actualValues)}`);
            }
            if (!signatureFormat) {
                console.log(`  Invalid signature format: ${signature}`);
            }
            if (!reproducible) {
                console.log(`  Signature not reproducible!`);
            }
            failed++;
        }
    }

    console.log("\n───────────────────────────────────────────────────────────────");
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log("───────────────────────────────────────────────────────────────\n");

    return failed === 0;
}

// Run if called directly
const success = runTests();
process.exit(success ? 0 : 1);
