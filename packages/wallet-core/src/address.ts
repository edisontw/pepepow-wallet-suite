import bs58check from "bs58check";
import { PepepowNetwork } from "./network";
import * as bitcoin from "bitcoinjs-lib";

export function hash160(buffer: Buffer) {
  return bitcoin.crypto.hash160(buffer);
}

export function pubkeyToP2PKH(pubkey: Buffer, network: PepepowNetwork) {
  const h160 = hash160(pubkey);
  const payload = Buffer.allocUnsafe(21);
  payload.writeUInt8(network.pubKeyHash, 0);
  h160.copy(payload, 1);
  return bs58check.encode(payload);
}

export function validateBase58Address(addr: string) {
  try {
    bs58check.decode(addr);
    return true;
  } catch { return false; }
}
