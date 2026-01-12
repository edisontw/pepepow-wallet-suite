import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

function valid(x: any) { return typeof x === 'number' && isFinite(x) && x > 0; }

export const feeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/fee/estimate', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: 60000
      }
    }
  }, async (_, reply) => {
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));
    try {
      const res = await RPC.estimateSmartFee(6);
      const rate = res?.feerate ?? res?.feeRate;
      const fallback = 0.0001;
      return { feerate: valid(rate) ? rate : fallback, source: valid(rate) ? 'estimatesmartfee' : 'fallback' };
    } catch {
      return { feerate: 0.0001, source: 'fallback' };
    }
  });
};
