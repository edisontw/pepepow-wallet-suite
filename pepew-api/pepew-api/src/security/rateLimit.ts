import { FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';

function getUserId(req: any): string | null {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.split(' ')[1];
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Simple decode of payload without verify (rate limit grouping purpose only)
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload.sub || payload.user_id || payload.uid || null;
  } catch {
    return null;
  }
}

export const rateLimitPlugin: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    max: config.rateMax, // Default global limit (e.g. 60)
    timeWindow: config.rateWindowMs,
    ban: 0,
    keyGenerator: (req) => {
      const user = getUserId(req);
      // If user is identified, limit by User ID (and maybe IP). 
      // User asked for "JWT sub as key".
      // If we mix IP, it prevents shared IP issues. 
      // Let's use UserID if present, else IP.
      return user ? `user:${user}` : `ip:${req.ip}`; 
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true
    }
  });
};
