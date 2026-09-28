import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const tx = await read("src/lib/tx.ts");
const client = await read("src/lib/pepewLightClient.ts");
const send = await read("src/pages/Send.tsx");
const store = await read("src/lib/walletStore.ts");

assert.match(tx, /pepewLightClient\.broadcastSignedRawTx\(rawTx\)/);
assert.doesNotMatch(tx, /API_ENDPOINTS\.wallet\.txBroadcast|BROADCAST_MAX_ATTEMPTS|broadcastFetchOnce/);
assert.match(tx, /Do not automatically retry POST \/api\/wallet\/broadcast/);

assert.match(client, /"\/api\/wallet\/broadcast"/);
assert.match(client, /JSON\.stringify\(\{ raw_tx: normalized \}\)/);
assert.match(client, /false,\s*\n\s*\);/);

assert.match(send, /walletStore\.markSpentOutpoints\(spentOutpoints\)/);
assert.match(send, /walletStore\.markSpentOutpoints\(\[\.\.\.spentOutpoints\]\)/);
assert.match(send, /pepewLightClient\.getUtxo\(sendFrom, \{ fresh: true \}\)/);
assert.match(send, /API_ENDPOINTS\.wallet\.feeEstimate/);

assert.match(store, /pepew_recent_spent_outpoints/);
assert.match(store, /SPENT_OUTPOINT_TTL_MS = 10 \* 60 \* 1000/);

console.log("m4-light-broadcast-boundary: ok");
