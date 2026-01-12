import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

export const balanceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/addr/:address/balance', async (req, reply) => {
    const { address } = req.params as { address: string };
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));

    const ai = await RPC.getAddressBalance(address).catch(() => null);
    if (ai && typeof ai === 'object' && 'balance' in ai) {
      const raw = (ai as any).balance;
      const sat = typeof raw === 'number' ? raw : (raw?.sat || 0);
      return { address, balanceSat: sat, balance: sat / 1e8, source: 'addressindex' };
    }

    const lus = await RPC.listUnspent(0, 9999999, [address]).catch(() => []);
    const sat = Array.isArray(lus) ? Math.round(lus.reduce((s, u) => s + Number(u.amount || 0) * 1e8, 0)) : 0;
    return { address, balanceSat: sat, balance: sat / 1e8, source: 'listunspent' };
  });
};
