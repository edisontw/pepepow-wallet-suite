import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';
import { getCache, setCache } from '../cache.js';
import { rget, rset } from '../redis.js';

export const chainRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/chain/height', async (_, reply) => {
    const rk = 'height';
    const rc = await rget<number>(rk);
    if (rc !== undefined) {
      reply.header('x-block-height', String(rc));
      return { height: rc };
    }
    const mc = getCache<number>(rk);
    if (mc !== undefined) {
      reply.header('x-block-height', String(mc));
      return { height: mc };
    }
    const height = await RPC.getBlockCount();
    await rset(rk, height, 3_000).catch(() => {});
    setCache(rk, height, 3_000);
    reply.header('x-block-height', String(height));
    return { height };
  });
};
