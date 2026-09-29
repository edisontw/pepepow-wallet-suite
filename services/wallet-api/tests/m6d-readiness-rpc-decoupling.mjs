import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const envExample = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");

for (const retired of [
  "PEPEW_API_BASE",
  "CORE_RPC_URL",
  "CORE_RPC_USER",
  "CORE_RPC_PASS",
  "CORE_RPC_TIMEOUT",
  "getCoreRpcRequestConfig",
  "getCoreRpcHostLabel",
  "checkPepewApi",
  "checkCoreRpc",
  "getblockcount",
  '"/healthz/rpc"',
  '"/wallet/healthz/rpc"',
  "coreRpc",
  "pepewApi",
  "x-block-height",
]) {
  assert.ok(!server.includes(retired), `legacy readiness/RPC dependency still present: ${retired}`);
}

assert.doesNotMatch(
  envExample,
  /^(?:PEPEW_API_BASE|CORE_RPC_URL|CORE_RPC_USER|CORE_RPC_PASS|CORE_RPC_TIMEOUT(?:_MS)?)=/m
);

for (const required of [
  "PEPEW_LIGHT_API_BASE",
  "getPepewLightApiBase",
  "checkPepewLightApi",
  "/api/status",
  "pepewLight",
  "checkTelegram",
  'app.get("/readyz"',
  'app.get("/wallet/readyz"',
  "botFetchLightJson",
]) {
  assert.ok(server.includes(required), `target readiness dependency missing: ${required}`);
}

assert.match(server, /return \{ ok, deps: \{ pepewLight: light, telegram: bot \} \};/);
assert.ok(server.includes("const url = `${getPepewLightApiBase()}/api/status`;"));

console.log("m6d-readiness-rpc-decoupling: ok");
