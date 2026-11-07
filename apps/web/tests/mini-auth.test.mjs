import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { authenticateMiniApp, getMiniDestination } from "../.tmp-mini-tests/miniAuth.js";
import { canCreateLocalWallet, getLocalWalletState } from "../.tmp-mini-tests/localWalletState.js";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

{
  let requests = 0;
  const result = await authenticateMiniApp({
    initData: "",
    request: async () => { requests += 1; return response(200, { token: "unused" }); },
    saveToken() {},
    navigate() {},
  });
  assert.deepEqual(result, { ok: false, reason: "missingInitData" });
  assert.equal(requests, 0);
}

for (const [status, error] of [[400, "invalid initData"], [401, "auth_date expired"]]) {
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    request: async () => response(status, { error }),
    saveToken() {},
    navigate() {},
  });
  assert.deepEqual(result, { ok: false, reason: "invalidInitData" });
}

{
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    request: async () => { throw new TypeError("network down"); },
    saveToken() {},
    navigate() {},
  });
  assert.deepEqual(result, { ok: false, reason: "authNetworkFailed" });
}

{
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    timeoutMs: 5,
    request: async () => new Promise(() => {}),
    saveToken() {},
    navigate() {},
  });
  assert.deepEqual(result, { ok: false, reason: "authTimedOut" });
}

{
  const events = [];
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    startParam: "send_to_user name/1",
    username: "test-user",
    request: async (initData, signal) => {
      events.push(["request", initData, signal instanceof AbortSignal]);
      return response(200, { token: "test-jwt" });
    },
    saveToken: (token) => events.push(["save", token]),
    navigate: (path) => events.push(["navigate", path]),
    updateProfile: async (username, signal) => events.push(["profile", username, signal instanceof AbortSignal]),
  });
  assert.deepEqual(result, { ok: true, destination: "/send?to=user+name%2F1" });
  assert.deepEqual(events.slice(0, 3), [
    ["request", "test-init-data", true],
    ["save", "test-jwt"],
    ["navigate", "/send?to=user+name%2F1"],
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events[3], ["profile", "test-user", true]);
  assert.equal(getMiniDestination("claim_req 1"), "/claim?requestId=req+1");
}

{
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    request: async () => response(200, { token: "test-jwt" }),
    saveToken() {},
    navigate() { throw new Error("navigation failed"); },
  });
  assert.deepEqual(result, { ok: false, reason: "navigationFailed" });
}

{
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    request: async () => response(503, { error: "temporarily unavailable" }),
    saveToken() {},
    navigate() {},
  });
  assert.deepEqual(result, { ok: false, reason: "authFailed" });
}

{
  const result = await authenticateMiniApp({
    initData: "test-init-data",
    request: async () => response(200, { token: "test-jwt" }),
    saveToken() {},
    navigate() {},
    updateProfile: async () => new Promise(() => {}),
  });
  assert.deepEqual(result, { ok: true, destination: "/" });
}

assert.equal(getLocalWalletState("", ""), "missing");
assert.equal(getLocalWalletState("public-address", ""), "watchOnly");
assert.equal(getLocalWalletState("", "existing phrase"), "mnemonicOnly");
assert.equal(getLocalWalletState("public-address", "existing phrase"), "ready");
assert.equal(canCreateLocalWallet("", ""), true);
assert.equal(canCreateLocalWallet("public-address", ""), false);
assert.equal(canCreateLocalWallet("", "existing phrase"), false);
assert.equal(canCreateLocalWallet("", "", "stored-address", null), false);
assert.equal(canCreateLocalWallet("", "", null, "stored phrase"), false);

const walletHome = await readFile(new URL("../src/pages/WalletHome.tsx", import.meta.url), "utf8");
assert.match(walletHome, /walletState\.status === "error"/);
assert.match(walletHome, /walletStore\.fetch\(\{ fresh: true \}\)/);
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
assert.doesNotMatch(apiSource, /console\.info\([^)]*,\s*options/);

console.log("mini-auth.test: ok");
