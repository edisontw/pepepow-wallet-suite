import * as bitcoin from "bitcoinjs-lib";
import * as secp from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { PepepowNetwork } from "./network";

bitcoin.initEccLib(secp);
const ECPair = ECPairFactory(secp);

export type UTXO = { txid: string; vout: number; value: number; nonWitnessUtxo: string };

export function toBitcoinNetwork(n: PepepowNetwork): bitcoin.Network {
  return {
    messagePrefix: n.messagePrefix,
    bech32: (n as any).bech32,
    bip32: { public: n.bip32.public, private: n.bip32.private },
    pubKeyHash: n.pubKeyHash,
    scriptHash: n.scriptHash,
    wif: n.wif
  };
}

export function selectUtxos(utxos: UTXO[], target: number) {
  // simple largest-first
  const sorted = [...utxos].sort((a,b)=>b.value - a.value);
  const picked: UTXO[] = [];
  let sum = 0;
  for (const u of sorted) {
    picked.push(u); sum += u.value;
    if (sum >= target) break;
  }
  if (sum < target) throw new Error("insufficient funds");
  return { picked, total: sum };
}

export function buildAndSignP2PKH(params: {
  network: PepepowNetwork;
  utxos: UTXO[];
  wif: string;
  to: string;
  amount: number;  // satoshis
  changeAddress: string;
  fee: number;     // satoshis
}) {
  const { network, utxos, wif, to, amount, changeAddress, fee } = params;
  const net = toBitcoinNetwork(network);
  const keyPair = ECPair.fromWIF(wif, net);
  const psbt = new bitcoin.Psbt({ network: net });

  let totalIn = 0;
  utxos.forEach(u => {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      nonWitnessUtxo: Buffer.from(u.nonWitnessUtxo, 'hex')
    });
    totalIn += u.value;
  });

  psbt.addOutput({ address: to, value: amount });
  const change = totalIn - amount - fee;
  if (change < 0) throw new Error("Insufficient funds including fee");
  if (change > 0) psbt.addOutput({ address: changeAddress, value: change });

  utxos.forEach((_, i) => psbt.signInput(i, keyPair));
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  return rawTx;
}
