import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';

export const txRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tx/:txid', async (req, reply) => {
    const { txid } = req.params as { txid: string };
    const height = await RPC.getBlockCount().catch(() => undefined);
    if (height) reply.header('x-block-height', String(height));
    const tx = await RPC.getRawTransactionVerbose(txid);
    return tx;
  });



app.post('/v1/tx/broadcast', {
  config: {
    rateLimit: {
      max: 3, // Strict limit for broadcasting: 3 per minute
      timeWindow: 60000
    }
  }
}, async (req, reply) => {
  const { rawtx } = req.body as { rawtx: string };
  if (!rawtx || typeof rawtx !== 'string') {
    reply.code(400);
    return { error: 'rawtx required' };
  }
  const txid = await RPC.sendRawTransaction(rawtx);
  const height = await RPC.getBlockCount().catch(() => undefined);
  if (height) reply.header('x-block-height', String(height));
  return { txid };
});
};
