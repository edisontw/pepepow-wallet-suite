import { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

export const apiKeyGuard: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const pass = req.headers['x-api-key'];
    if (!config.apiKey || pass === config.apiKey) return;
    reply.code(401).send({ error: 'Unauthorized' });
  });
};
