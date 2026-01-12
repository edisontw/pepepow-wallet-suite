import { config } from './config.js';
import { request } from 'undici';

let rpcId = 0;
function redactRpcUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return raw.replace(/\/\/([^@]+)@/, '//***@');
  }
}

function classifyRpcError(err: any) {
  const safeUrl = redactRpcUrl(config.rpcUrl);
  const code = err?.code || '';
  if (code === 'ECONNREFUSED') {
    return `RPC connection refused at ${safeUrl}. Is pepepowd running and RPC listening?`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `RPC host not found for ${safeUrl}. Check RPC_URL.`;
  }
  if (code === 'ETIMEDOUT' || err?.name === 'TimeoutError') {
    return `RPC timeout contacting ${safeUrl}. Check network/firewall.`;
  }
  return `RPC request failed: ${err?.message || String(err)}`;
}

class Semaphore {
  private tasks: (() => void)[] = [];
  constructor(private count: number) {}
  async acquire() {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>(res => this.tasks.push(res));
  }
  release() {
    if (this.tasks.length > 0) {
      const next = this.tasks.shift();
      next?.();
    } else {
      this.count++;
    }
  }
}

const sem = new Semaphore(5); // Max 5 concurrent RPC calls

async function rpcCall<T = any>(method: string, params: any[] = []): Promise<T> {
  // Layer 3 Protection: Concurrency Limit
  await sem.acquire();
  try {
    const body = { jsonrpc: '2.0', id: ++rpcId, method, params };
    const auth = Buffer.from(`${config.rpcUser}:${config.rpcPass}`).toString('base64');
    const safeUrl = redactRpcUrl(config.rpcUrl);
  
    let res;
    try {
      res = await request(config.rpcUrl, {
        method: 'POST',
        headersTimeout: 5000,
        bodyTimeout: 15000,
        headers: {
          'content-type': 'application/json',
          'authorization': `Basic ${auth}`
        },
        body: JSON.stringify(body)
      });
    } catch (err: any) {
      throw new Error(classifyRpcError(err));
    }
  
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new Error(`RPC auth failed (${res.statusCode}) for ${safeUrl}. Check RPC_USER/RPC_PASS.`);
    }
    if (res.statusCode != 200) {
      const text = await res.body.text().catch(() => '');
      throw new Error(`RPC HTTP ${res.statusCode} from ${safeUrl}: ${text || 'empty response'}`);
    }
    const json: any = await res.body.json();
    if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
    return json.result as T;
  } finally {
    sem.release();
  }
}

export const RPC = {
  call: rpcCall,
  getBlockCount: () => rpcCall<number>('getblockcount'),
  estimateSmartFee: (confTarget = 6) => rpcCall<any>('estimatesmartfee', [confTarget]),
  sendRawTransaction: (hex: string) => rpcCall<string>('sendrawtransaction', [hex]),
  getRawTransactionVerbose: (txid: string) => rpcCall<any>('getrawtransaction', [txid, 1]),
  getAddressUtxos: (address: string) =>
    rpcCall<any>('getaddressutxos', [{ addresses: [address] }]).catch(() => null),
  getAddressBalance: (address: string) =>
    rpcCall<any>('getaddressbalance', [{ addresses: [address] }]).catch(() => null),
  getMempoolInfo: () => rpcCall<any>('getmempoolinfo'),
  listUnspent: (minconf = 0, maxconf = 9999999, addresses?: string[]) =>
    addresses && addresses.length
      ? rpcCall<any>('listunspent', [minconf, maxconf, addresses])
      : rpcCall<any>('listunspent', [minconf, maxconf]),
  importAddress: (address: string, label = '', rescan = false) =>
    rpcCall<any>('importaddress', [address, label, rescan])
};
