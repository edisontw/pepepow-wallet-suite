import * as zmq from 'zeromq';
import { config } from './config.js';
import { RPC } from './rpc.js';
import { setCache } from './cache.js';
import { rset } from './redis.js';

export async function startZMQ(appLog: { info: Function; error: Function }) {
  try {
    const sock = new zmq.Subscriber();
    await sock.connect(config.zmqBlock);
    sock.subscribe('rawblock');
    appLog.info(`ZMQ subscribed to ${config.zmqBlock} topic=rawblock`);

    (async () => {
      for await (const [_topic, _msg] of sock) {
        try {
          const height = await RPC.getBlockCount();
          setCache('height', height, 5_000);
          await rset('height', height, 5_000).catch(() => {});
          appLog.info({ height }, 'ZMQ height refresh');
        } catch (e: any) {
          appLog.error({ err: e?.message }, 'ZMQ height refresh failed');
        }
      }
    })();
    return true;
  } catch (e: any) {
    appLog.error({ err: e?.message }, 'ZMQ start failed');
    return false;
  }
}
