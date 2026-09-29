import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const envExample = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
const opsNginx = await readFile(new URL("../../../ops/nginx/api.conf", import.meta.url), "utf8");
const infraNginx = await readFile(new URL("../../../infra/nginx/api.conf", import.meta.url), "utf8");

for (const retired of [
  '"/wallet/tx/broadcast"',
  '"/wallet/tx/send"',
  '"/api/tx/send"',
  "sendrawtransaction",
  "decoderawtransaction",
  "WALLET_API_DEBUG_RAWTX",
  "WALLET_API_DEBUG_RAWTX_FILE",
  "WALLET_API_RATE_LIMIT_TX_WINDOW_MS",
  "WALLET_API_RATE_LIMIT_TX_MAX",
  "WALLET_API_RATE_LIMIT_JWT_TX_MAX",
  "txLimiters",
  "txLimiter",
  "txJwtLimiter",
  'from "fs"',
]) {
  assert.ok(!server.includes(retired), `retired direct-broadcast implementation still present: ${retired}`);
}

assert.doesNotMatch(envExample, /WALLET_API_DEBUG_RAWTX|WALLET_API_RATE_LIMIT_(?:JWT_)?TX_/);

for (const preserved of [
  'app.get("/readyz"',
  'app.get("/wallet/readyz"',
]) {
  assert.ok(server.includes(preserved), `readiness route missing: ${preserved}`);
}

for (const [name, nginx] of [["ops", opsNginx], ["infra", infraNginx]]) {
  for (const path of ["/wallet/tx/broadcast", "/wallet/tx/send", "/api/tx/send"]) {
    const escaped = path.replace(/\//g, "\\/");
    const match = nginx.match(new RegExp(`location = ${escaped} \\{[\\s\\S]*?\\}`));
    assert.ok(match, `${name} nginx missing M6c tombstone for ${path}`);
    assert.match(match[0], /return 404;/);
    assert.doesNotMatch(match[0], /proxy_pass/);
  }
}

// pepew-api's separate public compatibility broadcast remains out of M6c scope.
assert.match(opsNginx, /location = \/v1\/tx\/broadcast \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:9193;/);

console.log("m6c-direct-broadcast-cleanup: ok");
