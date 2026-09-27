import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const start = server.indexOf("// --- Bot Helper Functions ---");
const end = server.indexOf("// --- Price (CoinMarketCap) ---");
assert.ok(start >= 0 && end > start);
const bot = server.slice(start, end);

assert.match(bot, /PEPEW_LIGHT_API_BASE/);
assert.match(bot, /\/api\/wallet\/address\/\$\{encodeURIComponent\(address\)\}/);
assert.match(bot, /\/api\/wallet\/history\/\$\{encodeURIComponent\(address\)\}/);
assert.doesNotMatch(bot, /127\.0\.0\.1:9194\/wallet\/balance/);
assert.doesNotMatch(bot, /127\.0\.0\.1:9194\/wallet\/history/);
assert.match(bot, /127\.0\.0\.1:9194\/v1\/address\/default/);
assert.match(bot, /formatPepewAtomic\(confirmed\)/);
assert.match(bot, /formatLightHistoryAmount/);
assert.match(server, /app\.post\("\/wallet\/tx\/broadcast"/);
assert.match(server, /\/wallet\/fee\/estimate/);

console.log("m3-bot-light-read-boundary: ok");
