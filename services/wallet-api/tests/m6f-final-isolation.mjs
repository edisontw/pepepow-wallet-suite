import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

const [server, webApi, lightClient, envExample, walletUnit, deploy, doctor, opsApi, infraApi, pepewRpc, pepewTxRoute] = await Promise.all([
  read("services/wallet-api/src/server.ts"),
  read("apps/web/src/lib/api.ts"),
  read("apps/web/src/lib/pepewLightClient.ts"),
  read(".env.example"),
  read("systemd/pepepow-wallet-api.service"),
  read("scripts/deploy.sh"),
  read("scripts/doctor.sh"),
  read("ops/nginx/api.conf"),
  read("infra/nginx/api.conf"),
  read("pepew-api/pepew-api/src/rpc.ts"),
  read("pepew-api/pepew-api/src/routes/tx.ts"),
]);

const retiredWalletRouteRegistrations = [
  /app\.get\("\/wallet\/balance"/,
  /app\.get\("\/wallet\/utxos"/,
  /app\.get\("\/wallet\/history"/,
  /app\.post\("\/v1\/history"/,
  /app\.get\("\/wallet\/tx\/raw"/,
  /app\.get\("\/api\/tx\/raw"/,
  /app\.get\("\/v1\/tx\/raw\/:txid"/,
  /app\.post\("\/wallet\/tx\/raw\/batch"/,
  /app\.post\("\/api\/tx\/raw\/batch"/,
  /app\.post\("\/wallet\/tx\/broadcast"/,
  /app\.post\("\/wallet\/tx\/send"/,
  /app\.post\("\/api\/tx\/send"/,
  /app\.get\("\/wallet\/fee\/estimate"/,
];

for (const retired of retiredWalletRouteRegistrations) {
  assert.doesNotMatch(server, retired, `wallet-api legacy route still registered: ${retired}`);
}

for (const retired of [
  "PEPEW_API_BASE",
  "CORE_RPC_URL",
  "CORE_RPC_USER",
  "CORE_RPC_PASS",
  "getrawtransaction",
  "sendrawtransaction",
  "estimatesmartfee",
]) {
  assert.ok(!server.includes(retired), `wallet-api legacy dependency present: ${retired}`);
}

for (const retired of [
  '/wallet/balance',
  '/wallet/utxos',
  '/wallet/history',
  '/wallet/tx/raw',
  '/wallet/tx/broadcast',
  '/wallet/fee/estimate',
]) {
  assert.ok(!webApi.includes(retired), `web control-plane API still references legacy chain path: ${retired}`);
}

for (const required of [
  "/api/wallet/address/",
  "/api/wallet/history/",
  "/api/wallet/utxo/",
  "/api/wallet/tx/",
  "/api/wallet/broadcast",
]) {
  assert.ok(lightClient.includes(required), `PEPEW Light client route missing: ${required}`);
}

assert.doesNotMatch(envExample, /^(?:PEPEW_API_BASE|CORE_RPC_URL|CORE_RPC_USER|CORE_RPC_PASS|CORE_RPC_TIMEOUT(?:_MS)?)=/m);
assert.match(envExample, /^PEPEW_LIGHT_API_BASE=https:\/\/light\.pepepow\.net$/m);
assert.match(envExample, /^VITE_PEPEW_LIGHT_API_BASE_URL=https:\/\/light\.pepepow\.net$/m);

assert.match(walletUnit, /WorkingDirectory=\/home\/ubuntu\/pepepow-wallet-suite\/services\/wallet-api/);
assert.match(walletUnit, /EnvironmentFile=\/etc\/pepepow\/pepepow-wallet-api\.env/);
assert.doesNotMatch(walletUnit, /9193|CORE_RPC|pepew-api/);

assert.doesNotMatch(deploy, /pepew-api|9193|CORE_RPC|PEPEW_API_BASE/);
assert.doesNotMatch(doctor, /pepew-api|9193|CORE_RPC|PEPEW_API_BASE|REDIS_URL/);
assert.match(doctor, /PEPEW Light API:/);
assert.match(doctor, /\/api\/status/);

for (const nginx of [opsApi, infraApi]) {
  assert.doesNotMatch(nginx, /location = \/v1\/history \{/);
  assert.match(nginx, /location \^~ \/v1\/tx\/raw\/ \{[\s\S]*?return 404;/);
  for (const path of ["/wallet/tx/broadcast", "/wallet/tx/send", "/api/tx/send"]) {
    const escaped = path.replace(/\//g, "\\/");
    assert.match(nginx, new RegExp(`location = ${escaped} \\{[\\s\\S]*?return 404;`));
  }
}

// Separate legacy pepew-api remains intentionally available to its own consumers.
assert.match(opsApi, /location = \/v1\/tx\/broadcast \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:9193;/);
assert.match(pepewRpc, /sendrawtransaction|getrawtransaction|estimatesmartfee/);
assert.match(pepewTxRoute, /broadcast|sendrawtransaction/);

console.log("m6f-final-isolation: ok");
