import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const opsNginx = await readFile(new URL("../../../ops/nginx/api.conf", import.meta.url), "utf8");
const infraNginx = await readFile(new URL("../../../infra/nginx/api.conf", import.meta.url), "utf8");

for (const retired of [
  '"/wallet/tx/raw"',
  '"/api/tx/raw"',
  '"/v1/tx/raw/:txid"',
  "RawTxCacheEntry",
  "fetchRawTxUpstream",
  "getrawtransaction",
  "RAW_TX_CACHE_TTL_MS",
  "RAW_TX_CACHE_MAX",
  "RAW_TX_BATCH_MAX",
  "RAW_TX_BATCH_CONCURRENCY",
  "getPepewApiBaseV1",
]) {
  assert.ok(!server.includes(retired), `retired raw-tx implementation still present: ${retired}`);
}

for (const preserved of [
  'app.post("/wallet/tx/broadcast"',
  'app.post("/wallet/tx/send"',
  'app.post("/api/tx/send"',
  "sendrawtransaction",
  "getCoreRpcRequestConfig",
  "checkCoreRpc",
  "PEPEW_API_BASE",
  "CORE_RPC_URL",
]) {
  assert.ok(server.includes(preserved), `later-M6 compatibility boundary missing: ${preserved}`);
}

for (const [name, nginx] of [["ops", opsNginx], ["infra", infraNginx]]) {
  assert.match(
    nginx,
    /location \^~ \/v1\/tx\/raw\/ \{[\s\S]*?return 404;[\s\S]*?\}/,
    `${name} nginx must explicitly tombstone /v1/tx/raw/`
  );
  const block = nginx.match(/location \^~ \/v1\/tx\/raw\/ \{[\s\S]*?\}/)?.[0] ?? "";
  assert.doesNotMatch(block, /proxy_pass\s+http:\/\/127\.0\.0\.1:9193|proxy_pass\s+http:\/\/127\.0\.0\.1:9194/);
}

console.log("m6b-raw-tx-cleanup: ok");
