
const https = require('https');
const crypto = require('crypto');

const KEYRING = "7b8a06b22e0c370e0531364e14ee6182bbc631131900e4efe5565dff77f71ef3";

function decryptKeyPair(payload) {
    const key = Buffer.from(KEYRING, 'hex');
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const cipherBytes = Buffer.concat([
        Buffer.from(payload.keyCipher, 'base64'),
        Buffer.from(payload.secretCipher, 'base64'),
    ]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(cipherBytes),
        decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8"));
}

function buildSignature(params, secret) {
    const sortedKeys = Object.keys(params).sort();
    const values = [];

    for (const key of sortedKeys) {
        const value = params[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
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

async function runTest() {
    // Keys for user 818916321
    const encrypted = {
        keyCipher: "oCNd6hexLyDOoLpE1gqw+w2nED+3MRsKABLzF7QmyAOq/5TpxqWWomxvppglHhrtUzyOC8OXO51SjuTI217pR7cebJWYCYtuEHF7oV0V",
        secretCipher: "Bo1Wp6F2Mdk9GY78+DTpjxcD/XeeZ2XBaDPA6q8xHoahjsXKwv9ayII9vUkzq/WBInqlVBJwql3CPDcdZVsA7qb4NmT6it22oay23C5x",
        iv: "skKDB2Dx1ujY+D6e",
        tag: "bA04uQM2PYCJd/3v1xjBtQ=="
    };

    const { apiKey, apiSecret } = decryptKeyPair(encrypted);
    console.log(`Decrypted API Key: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);

    const testPairs = ["PEPEW/USDT", "PEPEWUSDT"];

    for (const pair of testPairs) {
        console.log(`\nTesting pair: ${pair}`);
        const params = {
            request_id: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
            pair: pair
        };

        const signature = buildSignature(params, apiSecret);
        const bodyStr = JSON.stringify(params);

        const options = {
            hostname: 'api.dex-trade.com',
            port: 443,
            path: '/v1/private/orders',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'login-token': apiKey,
                'x-auth-sign': signature
            }
        };

        try {
            const result = await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                req.on('error', reject);
                req.write(bodyStr);
                req.end();
            });

            console.log(`Status: ${result.status}`);
            console.log(`Body: ${result.data}`);
        } catch (err) {
            console.error(`Error: ${err.message}`);
        }
    }
}

runTest();
