import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const send = await read("src/pages/Send.tsx");
const policy = await read("src/lib/feePolicy.ts");

assert.match(policy, /PEPEW_FEE_RATE_ATOMIC_PER_KB = 10_000n/);
assert.match(policy, /PEPEW_MIN_FEE_ATOMIC = 10_000n/);
assert.match(policy, /10 \+ inputs \* 148 \+ outputs \* 34/);
assert.match(send, /selectP2PKHFeeForSortedInputs/);
assert.match(send, /calculateP2PKHFeeAtomic\(selected\.length, 1\)/);
assert.match(send, /client-size-policy/);
assert.match(send, /aria-readonly="true"/);
assert.doesNotMatch(send, /API_ENDPOINTS\.wallet\.feeEstimate|\/wallet\/fee\/estimate/);
assert.doesNotMatch(send, /setFee\(|feeTouched|FEE_FALLBACK/);

console.log("m5-client-fee-boundary.test: ok");
