import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

export const walletRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/wallet/importaddress', async (req, reply) => {
    const { address, label = '', rescan = false } = (req.body as any) || {};
    if (!address) { reply.code(400); return { error: 'address required' }; }
    try {
      const r = await RPC.importAddress(address, label, !!rescan);
      return { ok: true, result: r ?? null };
    } catch (e: any) {
      reply.code(500);
      return { ok: false, error: e.message };
    }
  });

  app.get('/v1/wallet/listunspent', async (req, reply) => {
    const q = req.query as any;
    const address = q?.address as string | undefined;
    const minconf = q?.minconf ? Number(q.minconf) : 0;
    const maxconf = q?.maxconf ? Number(q.maxconf) : 9999999;
    const list = await RPC.listUnspent(minconf, maxconf, address ? [address] : undefined);
    return list;
  });
};
