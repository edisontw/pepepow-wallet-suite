import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const walletStore = await read("src/lib/walletStore.ts");
const tx = await read("src/lib/tx.ts");
const history = await read("src/pages/History.tsx");
const send = await read("src/pages/Send.tsx");

assert.match(walletStore, /pepewLightClient\.getAddress/);
assert.match(walletStore, /pepewLightClient\.getUtxo/);
assert.doesNotMatch(walletStore, /API_ENDPOINTS\.wallet\.utxos|\/wallet\/utxos/);

assert.match(history, /pepewLightClient\.getHistory/);
assert.doesNotMatch(history, /API_ENDPOINTS\.wallet\.history|\/wallet\/history/);

assert.match(tx, /pepewLightClient\.getTx/);
assert.doesNotMatch(tx, /API_ENDPOINTS\.wallet\.txRaw|API_ENDPOINTS\.wallet\.txRawBatch|\/wallet\/tx\/raw/);

assert.match(send, /API_ENDPOINTS\.wallet\.feeEstimate/);
assert.match(send, /walletStore\.fetch\(\{ fresh: true, includeBalance: false \}\)/);

console.log("m2-light-read-boundary.test: ok");
