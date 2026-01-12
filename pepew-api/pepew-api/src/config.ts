import 'dotenv/config';

export const config = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8093',
  rpcUser: process.env.RPC_USER || '',
  rpcPass: process.env.RPC_PASS || '',
  port: Number(process.env.PORT || 9193),
  apiKey: process.env.API_KEY || '',
  rateMax: Number(process.env.RATE_MAX || 60),
  rateWindowMs: Number(process.env.RATE_TIME_WINDOW || 60_000),
  redisUrl: process.env.REDIS_URL || '',
  zmqBlock: process.env.ZMQ_BLOCK || 'tcp://127.0.0.1:28332',
};
