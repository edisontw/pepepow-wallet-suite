const crypto = require("crypto");
const https = require("https");

const loginTokenEnc = "oCNd6hexLyDOoLpE1gqw+w2nED+3MRsKABLzF7QmyAOq/5TpxqWWomxvppglHhrtUzyOC8OXO51SjuTI217pR7cebJWYCYtuEHF7oV0V";
const secretEnc = "Bo1Wp6F2Mdk9GY78+DTpjxcD/XeeZ2XBaDPA6q8xHoahjsXKwv9ayII9vUkzq/WBInqlVBJwql3CPDcdZVsA7qb4NmT6it22oay23C5x";
const iv = "skKDB2Dx1ujY+D6e";
const tag = "bA04uQM2PYCJd/3v1xjBtQ==";
const keyring = "7b8a06b22e0c370e0531364e14ee6182bbc631131900e4efe5565dff77f71ef3";

function decrypt(keyring, payload) {
    const key = Buffer.from(keyring, "hex");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const cipherBytes = Buffer.concat([
        Buffer.from(payload.keyCipher, "base64"),
        Buffer.from(payload.secretCipher, "base64"),
    ]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(cipherBytes),
        decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
}

const { apiKey: loginToken, apiSecret: secret } = decrypt(keyring, {
    keyCipher: loginTokenEnc,
    secretCipher: secretEnc,
    iv,
    tag
});

function buildSignature(params, secret) {
    const sortedKeys = Object.keys(params).sort();
    let str = "";
    for (const key of sortedKeys) {
        str += params[key];
    }
    str += secret;
    return crypto.createHash("sha256").update(str).digest("hex");
}

function request(url, options) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => resolve({ status: res.statusCode, text: data }));
        });
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function testDeleteOrder(orderId, pair) {
    const url = `https://api.dex-trade.com/v1/private/delete-order`;
    console.log(`Testing ${url} (orderId=${orderId}, pair=${pair})...`);

    const params = {
        request_id: String(Date.now() * 1000),
        order_id: String(orderId || ""),
    };
    if (pair) params.pair = pair;

    const signature = buildSignature(params, secret);

    const res = await request(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "login-token": loginToken,
            "x-auth-sign": signature,
        },
        body: JSON.stringify(params),
    });

    console.log(`  Status: ${res.status}`);
    console.log(`  Body: ${res.text}`);
}

async function run() {
    console.log("\n--- Delete Order (no pair) ---");
    await testDeleteOrder("12345");

    console.log("\n--- Delete Order (with pair) ---");
    await testDeleteOrder("12345", "PEPEWUSDT");
}

run();
