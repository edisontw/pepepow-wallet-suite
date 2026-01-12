import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

export const mempoolRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/mempool/info', async (_, reply) => {
    const info = await RPC.getMempoolInfo();
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));
    return info;
  });
};
