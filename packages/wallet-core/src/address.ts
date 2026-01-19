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

export type AddressScriptInfo = {
  type: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
  script: Buffer;
};

export function addressToScript(address: string, network: PepepowNetwork): AddressScriptInfo {
  const net = {
    messagePrefix: network.messagePrefix,
    bech32: network.bech32,
    bip32: network.bip32,
    pubKeyHash: network.pubKeyHash,
    scriptHash: network.scriptHash,
    wif: network.wif
  } as bitcoin.Network;

  let base58Error: Error | null = null;
  try {
    const decoded = bitcoin.address.fromBase58Check(address);
    if (decoded.version === network.pubKeyHash) {
      const payment = bitcoin.payments.p2pkh({ hash: decoded.hash, network: net });
      if (!payment.output) throw new Error("missing p2pkh output");
      return { type: "p2pkh", script: payment.output };
    }
    if (decoded.version === network.scriptHash) {
      const payment = bitcoin.payments.p2sh({ hash: decoded.hash, network: net });
      if (!payment.output) throw new Error("missing p2sh output");
      return { type: "p2sh", script: payment.output };
    }
    throw new Error("base58 version mismatch");
  } catch (err: any) {
    base58Error = err instanceof Error ? err : new Error(String(err));
    // fall through to bech32 parsing
  }

  try {
    const decoded = bitcoin.address.fromBech32(address);
    if (!network.bech32 || decoded.prefix !== network.bech32) {
      throw new Error("bech32 prefix mismatch");
    }
    if (decoded.version === 0 && decoded.data.length === 20) {
      const payment = bitcoin.payments.p2wpkh({ hash: decoded.data, network: net });
      if (!payment.output) throw new Error("missing p2wpkh output");
      return { type: "p2wpkh", script: payment.output };
    }
    if (decoded.version === 0 && decoded.data.length === 32) {
      const payment = bitcoin.payments.p2wsh({ hash: decoded.data, network: net });
      if (!payment.output) throw new Error("missing p2wsh output");
      return { type: "p2wsh", script: payment.output };
    }
    if (decoded.version === 1 && decoded.data.length === 32) {
      const payment = bitcoin.payments.p2tr({ pubkey: decoded.data, network: net });
      if (!payment.output) throw new Error("missing p2tr output");
      return { type: "p2tr", script: payment.output };
    }
    throw new Error("unsupported bech32 address");
  } catch (err: any) {
    if (base58Error) throw base58Error;
    throw err;
  }
}
