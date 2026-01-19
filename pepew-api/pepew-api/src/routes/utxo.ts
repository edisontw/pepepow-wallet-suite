import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';
import { getCache, setCache } from '../cache.js';

export const utxoRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/addr/:address/utxos', async (req, reply) => {
    const { address } = req.params as { address: string };
    const q = req.query as any;
    const importAddr = q?.import === '1' || q?.import === 'true';
    const rescan = q?.rescan === '1' || q?.rescan === 'true';

    const ck = `utxos:${address}`;
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));

    const cached = getCache<any[]>(ck);
    if (cached) return { utxos: cached, cached: true, source: 'cache' };

    try {
      const ai = await RPC.getAddressUtxos(address);
      if (ai && Array.isArray(ai)) {
        setCache(ck, ai, 10_000);
        return { utxos: ai, cached: false, source: 'addressindex' };
      }
    } catch { }

    if (importAddr) {
      try { await RPC.importAddress(address, '', rescan); } catch { }
    }

    try {
      const lus = await RPC.listUnspent(0, 9999999, [address]);
      if (Array.isArray(lus) && lus.length) {
        const mapped = lus.map((u: any) => ({
          address,
          txid: u.txid,
          outputIndex: u.vout,
          script: u.scriptPubKey,
          satoshis: Math.round(Number(u.amount) * 1e8),
          height: u.confirmations ? (height ? (height - u.confirmations + 1) : null) : null
        }));
        setCache(ck, mapped, 5_000);
        return { utxos: mapped, cached: false, source: 'listunspent' };
      }
    } catch { }

    return { utxos: [], note: 'no address index; use ?import=1 to add as watch-only (rescan=1 for historical, heavy), or reindex with addressindex=1' };
    return { utxos: [], note: 'no address index; use ?import=1 to add as watch-only (rescan=1 for historical, heavy), or reindex with addressindex=1' };
  });

  app.post('/v1/utxos', async (req, reply) => {
    const body = req.body as { addresses: string[] };
    const addresses = Array.isArray(body.addresses) ? body.addresses : [];
    if (!addresses.length) return { utxos: [] };

    const ck = `utxos:multi:${addresses.sort().join(',')}`; // Basic cache key strategy
    // Note: In prod, hashing the key is better for long lists

    // We skip cache implementation for simplicity in this task unless strictly needed, 
    // but the plan says "wallet-api can cache". 
    // Existing code uses cache. Let's try to respect it if easy, or just skip for multi-addr for now to ensure freshness.

    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('UTXO lookup timeout')), 2000)
    );

    try {
      await Promise.race([
        (async () => {
          // rpc.ts getAddressUtxos accepts (address: string) => [{ addresses: [address] }]
          // We need to call rpcCall manually or update RPC helper.
          // Let's call rpcCall manually here to be safe and quick.
          const param = { addresses };
          const res = await RPC.call<any>('getaddressutxos', [param]).catch(() => null);

          if (res && Array.isArray(res)) {
            // Map to standard format and ensure confirmations
            const mapped = res.map((u: any) => ({
              address: u.address,
              txid: u.txid,
              outputIndex: u.outputIndex,
              script: u.script,
              satoshis: u.satoshis, // getaddressutxos returns satoshis usually
              height: u.height,
              confirmations: (typeof u.height === 'number' && height) ? (height - u.height + 1) : 0
            }));
            return { utxos: mapped, source: 'addressindex' };
          }

          // Fallback: listunspent supports multiple addresses
          const lus = await RPC.listUnspent(0, 9999999, addresses);
          if (Array.isArray(lus)) {
            const mapped = lus.map((u: any) => ({
              address: u.address,
              txid: u.txid,
              outputIndex: u.vout,
              script: u.scriptPubKey,
              satoshis: Math.round(Number(u.amount) * 1e8),
              height: u.confirmations ? (height ? (height - u.confirmations + 1) : null) : null,
              confirmations: u.confirmations
            }));
            return { utxos: mapped, source: 'listunspent' };
          }
        })(),
        timeoutPromise
      ]);
    } catch (err) {
      console.warn(`[utxo] Multi-address lookup timeout or error: ${err}`);
    }

    return { utxos: [] };
  });
};
