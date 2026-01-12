import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

export const nodeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/node/blockchaininfo', async (_, reply) => {
    const info = await RPC.call('getblockchaininfo', []);
    const height = info?.blocks ?? await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));
    return info;
  });

  app.get('/v1/node/indexinfo', async (_, reply) => {
    try {
      const info = await RPC.call('getindexinfo', []);
      const height = await RPC.getBlockCount().catch(() => undefined);
      if (height) reply.header('x-block-height', String(height));
      return info;
    } catch (e: any) {
      reply.code(404);
      return { error: 'getindexinfo not available', detail: e.message };
    }
  });
};
