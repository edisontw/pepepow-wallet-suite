import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const api = await readFile(new URL("../../../apps/web/src/lib/api.ts", import.meta.url), "utf8");

for (const route of [
  'app.get("/wallet/balance"',
  'app.get("/wallet/utxos"',
  'app.get("/wallet/history"',
  'app.post("/v1/history"',
]) {
  assert.ok(!server.includes(route), `retired route still present: ${route}`);
}

assert.doesNotMatch(server, /withPepewApiSlot|UpstreamBusyError|PEPEW_API_UPSTREAM_/);
assert.doesNotMatch(api, /balance:\s*"\/wallet\/balance"|utxos:\s*"\/wallet\/utxos"|history:\s*"\/wallet\/history"/);
assert.doesNotMatch(api, /txRaw:\s*"\/wallet\/tx\/raw"|txRawBatch:\s*"\/wallet\/tx\/raw\/batch"|txBroadcast:\s*"\/wallet\/tx\/broadcast"/);
assert.doesNotMatch(api, /history:\s*"\/v1\/history"/);

assert.match(server, /app\.get\("\/wallet\/healthz"/);
assert.match(server, /app\.get\("\/wallet\/price"/);
assert.match(server, /app\.get\("\/v1\/address\/default"/);

console.log("m6a-legacy-read-cleanup: ok");
