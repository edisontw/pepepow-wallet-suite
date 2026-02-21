import * as bitcoin from "bitcoinjs-lib";
import * as secp from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { PepepowNetwork } from "./network";

bitcoin.initEccLib(secp);
const ECPair = ECPairFactory(secp);

const SATOSHI_MAX = 9223372036854775807n;

type AtomicLike = string | number | bigint;

export type UTXO = { txid: string; vout: number; value: AtomicLike; nonWitnessUtxo: string };

function normalizeAtomic(value: AtomicLike, label: string) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid ${label}: non-integer or unsafe number`);
    }
    return value.toString();
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: expected decimal integer string`);
  }
  return trimmed.replace(/^0+(?=\d)/, "") || "0";
}

function toSafeSatoshiNumber(value: AtomicLike, label: string) {
  const normalized = normalizeAtomic(value, label);
  const satoshi = BigInt(normalized);

  if (satoshi < 0n) {
    throw new Error(`Invalid ${label}: negative value`);
  }
  if (satoshi > SATOSHI_MAX) {
    throw new Error(`Invalid ${label}: exceeds max satoshi range`);
  }
  const asNumber = Number(satoshi);
  if (!Number.isFinite(asNumber) || !Number.isInteger(asNumber)) {
    throw new Error(`Invalid ${label}: cannot represent satoshi value as number`);
  }
  if (BigInt(asNumber) !== satoshi) {
    throw new Error(`Invalid ${label}: cannot represent satoshi value precisely`);
  }
  return asNumber;
}

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
  const sorted = [...utxos].sort((a, b) => toSafeSatoshiNumber(b.value, "utxo.value") - toSafeSatoshiNumber(a.value, "utxo.value"));
  const picked: UTXO[] = [];
  let sum = 0;
  for (const u of sorted) {
    picked.push(u);
    sum += toSafeSatoshiNumber(u.value, "utxo.value");
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
  amount: AtomicLike;  // satoshis
  changeAddress: string;
  fee: AtomicLike;     // satoshis
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
    totalIn += toSafeSatoshiNumber(u.value, "utxo.value");
  });

  const amountSats = toSafeSatoshiNumber(amount, "amount");
  const feeSats = toSafeSatoshiNumber(fee, "fee");

  psbt.addOutput({ address: to, value: amountSats });
  const change = totalIn - amountSats - feeSats;
  if (change < 0) throw new Error("Insufficient funds including fee");
  if (change > 0) psbt.addOutput({ address: changeAddress, value: change });

  utxos.forEach((_, i) => psbt.signInput(i, keyPair));
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  return rawTx;
}
