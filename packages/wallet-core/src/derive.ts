import * as secp from "tiny-secp256k1";
import { deriveFromMnemonic } from "./mnemonic";
import { PepepowNetwork } from "./network";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";

bitcoin.initEccLib(secp);
const ECPair = ECPairFactory(secp);

export async function wifFromMnemonic(mnemonic: string, path: string, network: PepepowNetwork) {
  const node = await deriveFromMnemonic(mnemonic, path);
  const net: bitcoin.Network = {
    messagePrefix: network.messagePrefix,
    bip32: network.bip32,
    pubKeyHash: network.pubKeyHash,
    scriptHash: network.scriptHash,
    wif: network.wif
  } as any;
  const keyPair = ECPair.fromPrivateKey(Buffer.from(node.privateKey!), { network: net });
  return keyPair.toWIF();
}
