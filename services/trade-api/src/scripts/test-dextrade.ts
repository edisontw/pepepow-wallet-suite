import fetch from "node-fetch";
import crypto from "crypto";

const loginToken = process.argv[2];
const secret = process.argv[3];

if (!loginToken || !secret) {
    console.log("Usage: node test-dextrade.js <token> <secret>");
    process.exit(1);
}

function buildSignature(params: Record<string, any>, secret: string): string {
    const sortedKeys = Object.keys(params).sort();
    const values: string[] = [];
    for (const key of sortedKeys) {
        values.push(String(params[key]));
    }
    const signPayload = values.join("") + secret;
    return crypto.createHash("sha256").update(signPayload).digest("hex");
}

async function testEndpoint(endpoint: string) {
    const url = `https://api.dex-trade.com/v1${endpoint}`;
    console.log(`Testing ${url}...`);

    const params = {
        request_id: String(Date.now() * 1000),
    };
    const signature = buildSignature(params, secret);

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "login-token": loginToken,
            "x-auth-sign": signature,
        },
        body: JSON.stringify(params),
    });

    console.log(`  Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`  Body: ${text}`);
}

async function testOrders(endpoint: string) {
    const url = `https://api.dex-trade.com/v1${endpoint}`;
    console.log(`Testing ${url}...`);

    const params = {
        request_id: String(Date.now() * 1000),
    };
    const signature = buildSignature(params, secret);

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "login-token": loginToken,
            "x-auth-sign": signature,
        },
        body: JSON.stringify(params),
    });

    console.log(`  Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`  Body: ${text.slice(0, 1000)}`);
}

async function testDeleteOrder(orderId: string, pair?: string) {
    const url = `https://api.dex-trade.com/v1/private/delete-order`;
    console.log(`Testing ${url} (orderId=${orderId}, pair=${pair})...`);

    const params: any = {
        request_id: String(Date.now() * 1000),
        order_id: orderId,
    };
    if (pair) params.pair = pair;

    const signature = buildSignature(params, secret);

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "login-token": loginToken,
            "x-auth-sign": signature,
        },
        body: JSON.stringify(params),
    });

    console.log(`  Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`  Body: ${text}`);
}

async function run() {
    console.log("--- Balances ---");
    await testEndpoint("/private/balances");
    console.log("\n--- Orders ---");
    await testOrders("/private/orders");

    console.log("\n--- Delete Order (no pair) ---");
    await testDeleteOrder("12345");

    console.log("\n--- Delete Order (with pair) ---");
    await testDeleteOrder("12345", "PEPEWUSDT");
}

run();
