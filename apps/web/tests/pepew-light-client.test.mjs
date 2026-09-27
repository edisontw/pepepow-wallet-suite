import assert from "node:assert/strict";
import { PepewLightApiClient, PepewLightApiError } from "../.tmp-tests/pepewLightClient.js";

const ADDRESS = "PRfbEeHAKKbz6Voz85WJudrJwTA3ZbHunb";
const TXID = "a".repeat(64);
const RAW_TX = "0100000001abcdef0123";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

{
  let seenUrl = "";
  const client = new PepewLightApiClient({
    baseUrl: "https://light.example.test/",
    maxReadRetries: 0,
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return jsonResponse({
        address: ADDRESS,
        balance: { confirmed: 100000000, unconfirmed: 0, confirmed_pepew: "1", unconfirmed_pepew: "0" },
        history: [{ txid: TXID, height: 123 }],
        source: "electrumx",
        read_only: true,
      });
    },
  });
  const result = await client.getAddress(ADDRESS, { fresh: true, verboseHistory: false, detailLimit: 5 });
  assert.equal(result.balance.confirmed, 100000000);
  assert.match(seenUrl, /\/api\/wallet\/address\//);
  assert.match(seenUrl, /fresh=1/);
  assert.match(seenUrl, /verbose_history=false/);
  assert.match(seenUrl, /detail_limit=5/);
}

{
  const client = new PepewLightApiClient({
    maxReadRetries: 0,
    fetchImpl: async () => jsonResponse({ ok: false, error: { code: "invalid_address", message: "bad" } }, { status: 400 }),
  });
  await assert.rejects(
    () => client.getAddress("Pbad"),
    (error) => error instanceof PepewLightApiError && error.code === "invalid_address" && error.status === 400 && error.message === "Invalid PEPEW address.",
  );
}

{
  let calls = 0;
  const sleeps = [];
  const client = new PepewLightApiClient({
    maxReadRetries: 1,
    retryDelayMs: 1,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ ok: false, error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "0" } });
      return jsonResponse({ address: ADDRESS, utxos: [{ txid: TXID, vout: 0, height: 1, value: 1000 }], utxo_count: 1, total: 1000, source: "electrumx", read_only: true });
    },
  });
  const result = await client.getUtxo(ADDRESS, { fresh: true });
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(result.utxos[0].txid, TXID);
  assert.equal(result.utxos[0].vout, 0);
}

{
  let calls = 0;
  const client = new PepewLightApiClient({
    maxReadRetries: 1,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: false, error: { code: "electrumx_error" } }, { status: 503 });
    },
  });
  await assert.rejects(
    () => client.getHistory(ADDRESS),
    (error) => error instanceof PepewLightApiError && error.code === "electrumx_error" && error.status === 503,
  );
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const client = new PepewLightApiClient({
    maxReadRetries: 2,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: false, error: { code: "broadcast_rejected" } }, { status: 503 });
    },
  });
  await assert.rejects(
    () => client.broadcastSignedRawTx(RAW_TX),
    (error) => error instanceof PepewLightApiError && error.code === "broadcast_rejected",
  );
  assert.equal(calls, 1, "broadcast must never be retried automatically");
}

{
  let requestBody = null;
  const client = new PepewLightApiClient({
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({ ok: true, txid: TXID, source: "electrumx", signed_raw_tx_only: true });
    },
  });
  const result = await client.broadcastSignedRawTx(RAW_TX);
  assert.deepEqual(Object.keys(requestBody), ["raw_tx"]);
  assert.equal(requestBody.raw_tx, RAW_TX);
  assert.equal("mnemonic" in requestBody, false);
  assert.equal("private_key" in requestBody, false);
  assert.equal(result.txid, TXID);
}

{
  const client = new PepewLightApiClient({
    timeoutMs: 5,
    maxReadRetries: 0,
    fetchImpl: async (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  });
  await assert.rejects(
    () => client.getTx(TXID),
    (error) => error instanceof PepewLightApiError && error.code === "timeout",
  );
}

await assert.rejects(() => new PepewLightApiClient().getTx("bad"), /Transaction id/);
await assert.rejects(() => new PepewLightApiClient().broadcastSignedRawTx("not-hex"), /Signed raw transaction/);

console.log("pepew-light-client.test: ok");
