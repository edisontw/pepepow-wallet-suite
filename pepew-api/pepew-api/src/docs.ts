import { FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

export const docsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
    openapi: {
      info: { title: 'PEPEW Light API', version: '0.5.1' }
    }
  });
  await app.register(swaggerUI, { routePrefix: '/docs' });
};
