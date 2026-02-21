import assert from "node:assert/strict";
import { formatAtomicToPepew, parsePepewToAtomic } from "../.tmp-tests/amount.js";

assert.equal(parsePepewToAtomic("100000000", 8), 10000000000000000n);
assert.equal(formatAtomicToPepew(10000000000000000n, 8), "100,000,000");
assert.equal(parsePepewToAtomic("0.0001", 8), 10000n);
assert.equal(parsePepewToAtomic("1.234567891", 8), 123456789n);

assert.equal(parsePepewToAtomic("1.234567894", 8), 123456789n);
assert.equal(parsePepewToAtomic("1.234567895", 8), 123456790n);
assert.equal(parsePepewToAtomic(" 1,000,000.00000001 ", 8), 100000000000001n);

assert.throws(() => parsePepewToAtomic("-1", 8));
assert.throws(() => parsePepewToAtomic("abc", 8));
assert.throws(() => parsePepewToAtomic("1.2.3", 8));

console.log("amount.bigint.test: ok");
