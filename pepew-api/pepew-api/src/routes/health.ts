import { FastifyPluginAsync } from 'fastify';
import { RPC } from '../rpc.js';
import { config } from '../config.js';
import { redis } from '../redis.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const serviceName = 'pepew-api';

  async function checkRpc() {
    try {
      const height = await RPC.getBlockCount();
      return { ok: true, height };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'rpc error' };
    }
  }

  async function checkRedis() {
    if (!config.redisUrl || !redis) return { ok: true, detail: 'disabled' };
    try {
      const pong = await redis.ping();
      return { ok: pong === 'PONG', detail: pong };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'redis error' };
    }
  }

  function summarizeDependencyErrors(deps: Record<string, any>) {
    const errors: string[] = [];
    if (deps.rpc && !deps.rpc.ok) {
      errors.push(`rpc: ${deps.rpc.error || 'unreachable'}`);
    }
    if (deps.redis && !deps.redis.ok) {
      errors.push(`redis: ${deps.redis.error || 'unreachable'}`);
    }
    return errors;
  }

  app.get('/health', async (_, reply) => {
    const rpc = await checkRpc();
    if (rpc.ok && typeof (rpc as any).height === 'number') {
      reply.header('x-block-height', String((rpc as any).height));
    }
    if (!rpc.ok) reply.code(500);
    return rpc.ok ? { ok: true, height: (rpc as any).height } : { ok: false, error: rpc.error };
  });

  async function readiness(reply: any) {
    const [rpc, redisCheck] = await Promise.all([checkRpc(), checkRedis()]);
    const ok = rpc.ok && redisCheck.ok;
    if (rpc.ok && typeof (rpc as any).height === 'number') {
      reply.header('x-block-height', String((rpc as any).height));
    }
    reply.code(ok ? 200 : 503);
    return {
      ok,
      service: serviceName,
      uptimeSec: Math.round(process.uptime()),
      deps: {
        rpc,
        redis: redisCheck
      },
      ...(ok ? {} : { error: summarizeDependencyErrors({ rpc, redis: redisCheck }).join('; ') })
    };
  }

  app.get('/healthz', async () => ({
    ok: true,
    service: serviceName,
    uptimeSec: Math.round(process.uptime())
  }));
  app.get('/readyz', async (_, reply) => readiness(reply));
};
