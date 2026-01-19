import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

function normalizeLimit(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/addr/:address/txs', async (req, reply) => {
    const { address } = req.params as { address: string };
    const q = req.query as any;
    const limit = normalizeLimit(q?.limit);
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));

    let txids: string[] | null = null;
    let error: string | null = null;

    try {
      const list = await RPC.call<any>('getaddresstxids', [{ addresses: [address] }]);
      if (Array.isArray(list)) txids = list;
    } catch (err: any) {
      error = err?.message || String(err);
    }

    if (!txids) {
      try {
        const deltas = await RPC.call<any>('getaddressdeltas', [{ addresses: [address] }]);
        if (Array.isArray(deltas)) {
          const set = new Set<string>();
          for (const d of deltas) {
            if (d?.txid) set.add(d.txid);
          }
          txids = Array.from(set);
        }
      } catch (err: any) {
        error = err?.message || String(err);
      }
    }

    if (!txids) {
      return { txs: [], source: 'pepew-api', error: error || 'address tx index unavailable' };
    }

    const sliced = txids.slice(-10).reverse();
    const txs: Array<{
      txid: string;
      time: number | string | null;
      confirmations: number | null;
      valueIn: number | null;
      valueOut: number | null;
      netAmount: number | null;
    }> = [];

    // Safety timeout for the entire loop
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('History loop timeout')), 1500)
    );

    try {
      await Promise.race([
        (async () => {
          for (const txid of sliced) {
            try {
              const tx = await RPC.getRawTransactionVerbose(txid);
              const confirmations = typeof tx?.confirmations === 'number'
                ? tx.confirmations
                : (typeof tx?.blockheight === 'number' && height ? height - tx.blockheight + 1 : null);
              const time = tx?.time ?? tx?.blocktime ?? null;
              const valueOut = Array.isArray(tx?.vout)
                ? Math.round(tx.vout.reduce((sum: number, v: any) => sum + (typeof v?.value === 'number' ? v.value : 0), 0) * 1e8)
                : null;

              let valueIn: number | null = null;
              if (Array.isArray(tx?.vin)) {
                const hasVinValue = tx.vin.some((vin: any) => typeof vin?.value === 'number');
                if (hasVinValue) {
                  valueIn = Math.round(tx.vin.reduce((sum: number, vin: any) => sum + (typeof vin?.value === 'number' ? vin.value : 0), 0) * 1e8);
                }
              }

              txs.push({ txid, time, confirmations, valueIn, valueOut, netAmount: null });
            } catch {
              txs.push({ txid, time: null, confirmations: null, valueIn: null, valueOut: null, netAmount: null });
            }
          }
        })(),
        timeoutPromise
      ]);
    } catch (err) {
      console.warn(`[history] Partial response due to: ${err}`);
    }

    return { txs, source: 'pepew-api' };
  });

  app.post('/v1/history', async (req, reply) => {
    const body = req.body as { addresses: string[]; limit?: number };
    const addresses = Array.isArray(body.addresses) ? body.addresses : [];
    if (!addresses.length) return { txs: [], source: 'pepew-api', error: 'No addresses provided' };

    const limit = normalizeLimit(body.limit);
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));

    let txids: string[] | null = null;
    let error: string | null = null;

    try {
      // API supports receiving multiple addresses in the array
      const list = await RPC.call<any>('getaddresstxids', [{ addresses }]);
      if (Array.isArray(list)) txids = list;
    } catch (err: any) {
      error = err?.message || String(err);
    }

    if (!txids) {
      return { txs: [], source: 'pepew-api', error: error || 'address tx index unavailable' };
    }

    const sliced = txids.slice(-10).reverse();
    const txs: Array<{
      txid: string;
      time: number | string | null;
      confirmations: number | null;
      valueIn: number | null;
      valueOut: number | null;
      netAmount: number | null;
    }> = [];

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('History loop timeout')), 1500)
    );

    try {
      await Promise.race([
        (async () => {
          for (const txid of sliced) {
            try {
              const tx = await RPC.getRawTransactionVerbose(txid);
              const confirmations = typeof tx?.confirmations === 'number'
                ? tx.confirmations
                : (typeof tx?.blockheight === 'number' && height ? height - tx.blockheight + 1 : null);
              const time = tx?.time ?? tx?.blocktime ?? null;
              const valueOut = Array.isArray(tx?.vout)
                ? Math.round(tx.vout.reduce((sum: number, v: any) => sum + (typeof v?.value === 'number' ? v.value : 0), 0) * 1e8)
                : null;

              let valueIn: number | null = null;
              if (Array.isArray(tx?.vin)) {
                const hasVinValue = tx.vin.some((vin: any) => typeof vin?.value === 'number');
                if (hasVinValue) {
                  valueIn = Math.round(tx.vin.reduce((sum: number, vin: any) => sum + (typeof vin?.value === 'number' ? vin.value : 0), 0) * 1e8);
                }
              }

              txs.push({ txid, time, confirmations, valueIn, valueOut, netAmount: null });
            } catch {
              txs.push({ txid, time: null, confirmations: null, valueIn: null, valueOut: null, netAmount: null });
            }
          }
        })(),
        timeoutPromise
      ]);
    } catch (err) {
      console.warn(`[history] Partial response due to: ${err}`);
    }

    return { txs, source: 'pepew-api' };
  });
};
