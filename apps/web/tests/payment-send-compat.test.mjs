import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parsePepewToAtomic } from "../.tmp-payment-tests/amount.js";

const here = dirname(fileURLToPath(import.meta.url));
const sendSource = fs.readFileSync(resolve(here, "../src/pages/Send.tsx"), "utf8");

for (const amount of ["0.1", "0.01", "0.0001"]) {
  const atomic = parsePepewToAtomic(amount, 8);
  assert.ok(atomic > 546n, `${amount} PEPEW should be a valid above-dust payment amount`);
}

assert.match(sendSource, /searchParams\.get\("to"\)/, "send route must accept recipient handoff");
assert.match(sendSource, /searchParams\.get\("amount"\)/, "send route must accept amount handoff");
assert.match(sendSource, /const DUST_THRESHOLD_SATS = 546;/, "wallet send dust threshold changed unexpectedly");
assert.match(
  sendSource,
  /recipientSatsBigInt <= BigInt\(DUST_THRESHOLD_SATS\)/,
  "wallet send must reject dust while allowing above-dust payment amounts",
);
assert.doesNotMatch(sendSource, /MIN_SEND_SATS/, "wallet must not reintroduce an arbitrary whole-coin send floor");
assert.doesNotMatch(sendSource, /send\.errors\.amountTooLow/, "wallet send path still contains the retired 1 PEPEW floor");

console.log("payment send compatibility: PASS");
