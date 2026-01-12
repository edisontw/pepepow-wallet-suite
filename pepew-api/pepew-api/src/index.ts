import Fastify from 'fastify';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { chainRoutes } from './routes/chain.js';
import { feeRoutes } from './routes/fee.js';
import { txRoutes } from './routes/tx.js';
import { utxoRoutes } from './routes/utxo.js';
import { mempoolRoutes } from './routes/mempool.js';
import { nodeRoutes } from './routes/node.js';
import { walletRoutes } from './routes/wallet.js';
import { balanceRoutes } from './routes/balance.js';
import { historyRoutes } from './routes/history.js';
import { apiKeyGuard } from './security/apikey.js';
import { rateLimitPlugin } from './security/rateLimit.js';
import { docsPlugin } from './docs.js';
import { startZMQ } from './zmq.js';
import { redis } from './redis.js';
import { RPC } from './rpc.js';
import cors from '@fastify/cors';

const app = Fastify({ logger: true });

function logStartupConfig() {
  const missing: string[] = [];
  if (!process.env.RPC_URL) missing.push('RPC_URL (defaulting to http://127.0.0.1:8093)');
  if (!config.rpcUser) missing.push('RPC_USER (RPC auth may fail)');
  if (!config.rpcPass) missing.push('RPC_PASS (RPC auth may fail)');
  if (!config.redisUrl) missing.push('REDIS_URL (redis cache disabled)');
  if (!process.env.ZMQ_BLOCK) missing.push('ZMQ_BLOCK (defaulting to tcp://127.0.0.1:28332)');
  if (missing.length) {
    app.log.warn(`[startup] Env not set: ${missing.join(', ')}`);
  }
}

logStartupConfig();

if (redis) {
  redis.on('connect', () => app.log.info('Redis connected'));
  redis.on('end', () => app.log.warn('Redis connection closed; retrying (check REDIS_URL/firewall)'));
  redis.on('reconnecting', (delay: number) =>
    app.log.warn({ delayMs: delay }, 'Redis reconnecting; check REDIS_URL/firewall')
  );
  redis.on('error', (err: any) =>
    app.log.error({ err: err?.message }, 'Redis connection error; retrying')
  );
}

await app.register(cors, {
  origin: ['https://wallet.pepepow.net', 'https://pepepow.net'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['content-type', 'authorization'],
  credentials: true,
});

await app.register(rateLimitPlugin);
await app.register(apiKeyGuard);
await app.register(docsPlugin);

await app.register(healthRoutes);
await app.register(chainRoutes);
await app.register(feeRoutes);
await app.register(txRoutes);
await app.register(utxoRoutes);
await app.register(historyRoutes);
await app.register(mempoolRoutes);
await app.register(nodeRoutes);
await app.register(walletRoutes);
await app.register(balanceRoutes);

app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'Not found' }));

startZMQ(app.log);

async function logStartupChecks() {
  try {
    const height = await RPC.getBlockCount();
    app.log.info({ height }, 'RPC check ok');
  } catch (err: any) {
    app.log.error({ err: err?.message }, 'RPC check failed');
  }
  if (redis) {
    try {
      const pong = await redis.ping();
      app.log.info({ pong }, 'Redis ping ok');
    } catch (err: any) {
      app.log.error({ err: err?.message }, 'Redis ping failed');
    }
  }
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`PEPEW API v${'0.5.1'} listening on :${config.port}`);
  void logStartupChecks();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
