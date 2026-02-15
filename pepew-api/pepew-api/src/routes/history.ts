import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

function normalizeLimit(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

type HistoryTx = {
  txid: string;
  time: number | string | null;
  confirmations: number | null;
  valueIn: number | null;
  valueOut: number | null;
  netAmount: number | null;
  primaryAddress: string | null;
  amountSats: number | null;
};

function parseNumberLike(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseCoinToSats(value: unknown) {
  const coin = parseNumberLike(value);
  if (coin === null) return null;
  return Math.round(coin * 1e8);
}

function parseDeltaToSats(delta: any) {
  const directSats = parseNumberLike(
    delta?.satoshis ?? delta?.satoshi ?? delta?.valueSat ?? delta?.value_sats
  );
  if (directSats !== null) return Math.round(directSats);
  return parseCoinToSats(delta?.amount ?? delta?.value);
}

function collectOutputAddresses(tx: any) {
  if (!Array.isArray(tx?.vout)) return [] as string[];
  const out: string[] = [];
  for (const vout of tx.vout) {
    const script = vout?.scriptPubKey || {};
    if (typeof script?.address === 'string' && script.address) {
      out.push(script.address);
    }
    if (Array.isArray(script?.addresses)) {
      for (const addr of script.addresses) {
        if (typeof addr === 'string' && addr) out.push(addr);
      }
    }
    if (typeof vout?.address === 'string' && vout.address) {
      out.push(vout.address);
    }
  }
  return Array.from(new Set(out));
}

function pickPrimaryAddress(tx: any, ownedAddresses: Set<string>) {
  const candidates = collectOutputAddresses(tx);
  if (!candidates.length) return null;
  const counterparty = candidates.find((addr) => !ownedAddresses.has(addr));
  return counterparty || candidates[0] || null;
}

function pickAmountSats(netAmount: number | null, valueOut: number | null, valueIn: number | null) {
  const candidate = [netAmount, valueOut, valueIn].find((v) => typeof v === 'number' && Number.isFinite(v));
  if (typeof candidate !== 'number') return null;
  return Math.round(candidate);
}

async function fetchNetAmountByTxid(addresses: string[], txBlockHeights: Map<string, number>) {
  const netByTxid = new Map<string, number>();
  if (!addresses.length || !txBlockHeights.size) return netByTxid;

  const heights = Array.from(txBlockHeights.values()).filter((h) => Number.isFinite(h) && h > 0);
  if (!heights.length) return netByTxid;

  const start = Math.min(...heights);
  const end = Math.max(...heights);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return netByTxid;

  try {
    const deltas = await RPC.call<any>('getaddressdeltas', [{ addresses, start, end }]);
    if (!Array.isArray(deltas)) return netByTxid;

    for (const delta of deltas) {
      const txid = typeof delta?.txid === 'string' ? delta.txid : '';
      if (!txid || !txBlockHeights.has(txid)) continue;
      const sats = parseDeltaToSats(delta);
      if (sats === null) continue;
      netByTxid.set(txid, (netByTxid.get(txid) || 0) + sats);
    }
  } catch (err) {
    console.warn(`[history] net amount fallback due to getaddressdeltas error: ${err}`);
  }

  return netByTxid;
}

async function buildHistoryRows(
  txids: string[],
  limit: number,
  height: number | undefined,
  addresses: string[],
  ownedAddresses: Set<string>,
) {
  const sliced = txids.slice(-limit).reverse();
  const txs: HistoryTx[] = [];
  const txBlockHeights = new Map<string, number>();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('History loop timeout')), 1500)
  );

  try {
    await Promise.race([
      (async () => {
        for (const txid of sliced) {
          try {
            const tx = await RPC.getRawTransactionVerbose(txid);
            const txBlockHeight = parseNumberLike(tx?.blockheight);
            if (txBlockHeight !== null && txBlockHeight > 0) {
              txBlockHeights.set(txid, Math.floor(txBlockHeight));
            }

            const confirmations = typeof tx?.confirmations === 'number'
              ? tx.confirmations
              : (typeof tx?.blockheight === 'number' && height ? height - tx.blockheight + 1 : null);
            const time = tx?.time ?? tx?.blocktime ?? null;

            let foundVout = false;
            let valueOutCoinSum = 0;
            if (Array.isArray(tx?.vout)) {
              for (const vout of tx.vout) {
                const coin = parseNumberLike(vout?.value);
                if (coin === null) continue;
                foundVout = true;
                valueOutCoinSum += coin;
              }
            }
            const valueOut = foundVout ? Math.round(valueOutCoinSum * 1e8) : null;

            let foundVin = false;
            let valueInCoinSum = 0;
            if (Array.isArray(tx?.vin)) {
              for (const vin of tx.vin) {
                const coin = parseNumberLike(vin?.value);
                if (coin === null) continue;
                foundVin = true;
                valueInCoinSum += coin;
              }
            }
            const valueIn = foundVin ? Math.round(valueInCoinSum * 1e8) : null;

            txs.push({
              txid,
              time,
              confirmations,
              valueIn,
              valueOut,
              netAmount: null,
              primaryAddress: pickPrimaryAddress(tx, ownedAddresses),
              amountSats: null,
            });
          } catch {
            txs.push({
              txid,
              time: null,
              confirmations: null,
              valueIn: null,
              valueOut: null,
              netAmount: null,
              primaryAddress: null,
              amountSats: null,
            });
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    console.warn(`[history] Partial response due to: ${err}`);
  }

  const netByTxid = await fetchNetAmountByTxid(addresses, txBlockHeights);

  for (const row of txs) {
    const net = netByTxid.has(row.txid) ? netByTxid.get(row.txid)! : null;
    const normalizedNet = typeof net === 'number' && Number.isFinite(net) ? Math.round(net) : null;
    row.netAmount = normalizedNet;
    row.amountSats = pickAmountSats(normalizedNet, row.valueOut, row.valueIn);
  }

  return txs;
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

    const txs = await buildHistoryRows(txids, limit, height, [address], new Set([address]));
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
      const list = await RPC.call<any>('getaddresstxids', [{ addresses }]);
      if (Array.isArray(list)) txids = list;
    } catch (err: any) {
      error = err?.message || String(err);
    }

    if (!txids) {
      return { txs: [], source: 'pepew-api', error: error || 'address tx index unavailable' };
    }

    const txs = await buildHistoryRows(txids, limit, height, addresses, new Set(addresses));
    return { txs, source: 'pepew-api' };
  });
};
