import assert from "node:assert/strict";
import {
  calculateP2PKHFeeAtomic,
  estimateP2PKHTxBytes,
  PEPEW_FEE_RATE_ATOMIC_PER_KB,
  PEPEW_MIN_FEE_ATOMIC,
  selectP2PKHFeeForSortedInputs,
} from "../.tmp-tests/feePolicy.js";

assert.equal(PEPEW_FEE_RATE_ATOMIC_PER_KB, 10_000n);
assert.equal(PEPEW_MIN_FEE_ATOMIC, 10_000n);

assert.equal(estimateP2PKHTxBytes(1, 2), 226);
assert.equal(calculateP2PKHFeeAtomic(1, 2), 10_000n);
assert.equal(calculateP2PKHFeeAtomic(5, 2), 10_000n);
assert.equal(calculateP2PKHFeeAtomic(10, 2), 15_580n);
assert.equal(calculateP2PKHFeeAtomic(80, 1), 118_840n);
assert.equal(calculateP2PKHFeeAtomic(80, 2), 119_180n);

const oneInput = selectP2PKHFeeForSortedInputs([100_000_000n], 50_000_000n, false, 2);
assert.equal(oneInput.covered, true);
assert.equal(oneInput.inputCount, 1);
assert.equal(oneInput.feeAtomic, 10_000n);
assert.equal(oneInput.targetAtomic, 50_010_000n);

const subtractFee = selectP2PKHFeeForSortedInputs([100_000_000n], 50_000_000n, true, 2);
assert.equal(subtractFee.covered, true);
assert.equal(subtractFee.feeAtomic, 10_000n);
assert.equal(subtractFee.targetAtomic, 50_000_000n);

const highInput = selectP2PKHFeeForSortedInputs(
  Array.from({ length: 80 }, () => 100_000_000n),
  7_900_000_000n,
  false,
  2,
);
assert.equal(highInput.covered, true);
assert.equal(highInput.inputCount, 80);
assert.equal(highInput.feeAtomic, 119_180n);

assert.throws(() => estimateP2PKHTxBytes(0, 2), /inputCount/);
assert.throws(() => calculateP2PKHFeeAtomic(1, 0), /outputCount/);

console.log("fee-policy.test: ok");
