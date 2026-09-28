import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const send = await read("src/pages/Send.tsx");
const policy = await read("src/lib/feePolicy.ts");
const api = await read("src/lib/api.ts");
const walletApiServer = await read("../../services/wallet-api/src/server.ts");

assert.match(policy, /PEPEW_FEE_RATE_ATOMIC_PER_KB = 10_000n/);
assert.match(policy, /PEPEW_MIN_FEE_ATOMIC = 10_000n/);
assert.match(policy, /10 \+ inputs \* 148 \+ outputs \* 34/);
assert.match(send, /selectP2PKHFeeForSortedInputs/);
assert.match(send, /calculateP2PKHFeeAtomic\(selected\.length, 1\)/);
assert.match(send, /client-size-policy/);
assert.match(send, /aria-readonly="true"/);
assert.doesNotMatch(send, /API_ENDPOINTS\.wallet\.feeEstimate|\/wallet\/fee\/estimate/);
assert.doesNotMatch(send, /setFee\(|feeTouched|FEE_FALLBACK/);
assert.doesNotMatch(api, /feeEstimate|\/wallet\/fee\/estimate/);
assert.doesNotMatch(walletApiServer, /\/wallet\/fee\/estimate|estimatesmartfee|FEE_ESTIMATE_TARGET|FEE_ESTIMATE_FALLBACK/);

console.log("m5-client-fee-boundary.test: ok");
