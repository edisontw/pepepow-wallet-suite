import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

const [unit, deploy, doctor, packRelease, envExample, opsApi, infraApi, opsWallet, infraWallet, envRules, runtime, systemdDoc, layoutDoc] = await Promise.all([
  read("systemd/pepepow-wallet-api.service"),
  read("scripts/deploy.sh"),
  read("scripts/doctor.sh"),
  read("scripts/pack_release.sh"),
  read(".env.example"),
  read("ops/nginx/api.conf"),
  read("infra/nginx/api.conf"),
  read("ops/nginx/wallet.conf"),
  read("infra/nginx/wallet.conf"),
  read("docs/ENV_RULES.md"),
  read("docs/runtime.md"),
  read("docs/systemd.md"),
  read("docs/deploy_layout.md"),
]);

assert.match(unit, /WorkingDirectory=\/home\/ubuntu\/pepepow-wallet-suite\/services\/wallet-api/);
assert.match(unit, /EnvironmentFile=\/etc\/pepepow\/pepepow-wallet-api\.env/);
assert.doesNotMatch(unit, /\/opt\/pepepow-wallet-suite\/current/);

assert.match(deploy, /\/var\/www\/pepepow-wallet/);
assert.match(deploy, /restart "\$WALLET_SERVICE"/);
assert.doesNotMatch(deploy, /restart\s+pepew-api|\/opt\/pepepow-wallet-suite/);

assert.match(doctor, /PEPEW Light API:/);
assert.match(doctor, /\/api\/status/);
assert.doesNotMatch(doctor, /CORE_RPC_URL|\/releases|\/shared|\/current/);
assert.doesNotMatch(doctor, /PEPEW_ENV_FILE|pepew-api\||REDIS_URL|redis-cli/);

assert.doesNotMatch(packRelease, /PEPEW_API_BASE=/);
assert.doesNotMatch(envExample, /^(?:PEPEW_API_BASE|CORE_RPC_URL|CORE_RPC_USER|CORE_RPC_PASS|CORE_RPC_TIMEOUT(?:_MS)?)=/m);

for (const nginx of [opsApi, infraApi]) {
  assert.doesNotMatch(nginx, /location = \/v1\/history \{/);
  assert.match(nginx, /location \^~ \/v1\/tx\/raw\/ \{[\s\S]*?return 404;/);
  for (const path of ["/wallet/tx/broadcast", "/wallet/tx/send", "/api/tx/send"]) {
    const escaped = path.replace(/\//g, "\\/");
    assert.match(nginx, new RegExp(`location = ${escaped} \\{[\\s\\S]*?return 404;`));
  }
}

for (const nginx of [opsWallet, infraWallet]) {
  assert.match(nginx, /root \/var\/www\/pepepow-wallet;/);
}

for (const doc of [envRules, runtime, systemdDoc]) {
  assert.doesNotMatch(doc, /\/opt\/pepepow-wallet-suite\/current/);
}
assert.match(layoutDoc, /not the active Wallet production convention/);

console.log("m6e-deployment-config-cleanup: ok");
