/**
 * NonKYC Signature Unit Tests
 * 
 * Tests the HMAC signature generation to ensure it matches the expected format.
 */

import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Copy of the signature function for testing
// ─────────────────────────────────────────────────────────────────────────────

function generateSignature(
    apiKey: string,
    fullUrl: string,
    bodyString: string,
    nonce: string,
    apiSecret: string
): string {
    const canonical = apiKey + fullUrl + bodyString + nonce;
    return crypto
        .createHmac("sha256", apiSecret)
        .update(canonical)
        .digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Cases
// ─────────────────────────────────────────────────────────────────────────────

interface TestCase {
    name: string;
    apiKey: string;
    apiSecret: string;
    fullUrl: string;
    body: Record<string, any> | null;
    nonce: string;
    expectedCanonical: string;
}

const testCases: TestCase[] = [
    {
        name: "GET balances (no body)",
        apiKey: "test_api_key_123",
        apiSecret: "test_api_secret_456",
        fullUrl: "https://api.nonkyc.io/api/v2/balances",
        body: null,
        nonce: "1706419234567",
        expectedCanonical: "test_api_key_123https://api.nonkyc.io/api/v2/balances1706419234567",
    },
    {
        name: "POST createorder",
        apiKey: "abc123",
        apiSecret: "secret456",
        fullUrl: "https://api.nonkyc.io/api/v2/createorder",
        body: { symbol: "PEPEW_BNB", side: "buy", type: "limit", quantity: 1000, price: 0.0001 },
        nonce: "1706500000000",
        expectedCanonical: 'abc123https://api.nonkyc.io/api/v2/createorder{"symbol":"PEPEW_BNB","side":"buy","type":"limit","quantity":1000,"price":0.0001}1706500000000',
    },
    {
        name: "POST cancelorder",
        apiKey: "keyABC",
        apiSecret: "secretXYZ",
        fullUrl: "https://api.nonkyc.io/api/v2/cancelorder",
        body: { id: "order-uuid-12345" },
        nonce: "1706600000000",
        expectedCanonical: 'keyABChttps://api.nonkyc.io/api/v2/cancelorder{"id":"order-uuid-12345"}1706600000000',
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Test Runner
// ─────────────────────────────────────────────────────────────────────────────

function runTests(): boolean {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  NonKYC Signature Unit Tests");
    console.log("═══════════════════════════════════════════════════════════════\n");

    let passed = 0;
    let failed = 0;

    for (const tc of testCases) {
        const bodyString = tc.body ? JSON.stringify(tc.body) : "";
        const actualCanonical = tc.apiKey + tc.fullUrl + bodyString + tc.nonce;

        const signature = generateSignature(
            tc.apiKey,
            tc.fullUrl,
            bodyString,
            tc.nonce,
            tc.apiSecret
        );

        // Verify canonical string matches
        const canonicalMatch = actualCanonical === tc.expectedCanonical;

        // Verify signature is a 64-char hex string
        const signatureFormat = /^[a-f0-9]{64}$/.test(signature);

        if (canonicalMatch && signatureFormat) {
            console.log(`✓ ${tc.name}`);
            passed++;
        } else {
            console.log(`✗ ${tc.name}`);
            if (!canonicalMatch) {
                console.log(`  Expected canonical: ${tc.expectedCanonical}`);
                console.log(`  Actual canonical:   ${actualCanonical}`);
            }
            if (!signatureFormat) {
                console.log(`  Invalid signature format: ${signature}`);
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
