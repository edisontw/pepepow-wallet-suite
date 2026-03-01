import * as bitcoin from "bitcoinjs-lib";
import * as secp from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { PepepowNetwork } from "./network";

bitcoin.initEccLib(secp);
const ECPair = ECPairFactory(secp);

const SATOSHI_MAX = 9223372036854775807n;
const UINT32_MAX = 0xffffffff;

type AtomicLike = string | bigint;

export type UTXO = { txid: string; vout: number; value: AtomicLike; nonWitnessUtxo: string };

function normalizeAtomic(value: AtomicLike, label: string) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: numbers are not allowed in atomic core`);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: expected decimal integer string`);
  }
  return trimmed.replace(/^0+(?=\d)/, "") || "0";
}

function toSatoshiBigInt(value: AtomicLike, label: string) {
  const normalized = normalizeAtomic(value, label);
  const satoshi = BigInt(normalized);

  if (satoshi < 0n) {
    throw new Error(`Invalid ${label}: negative value`);
  }
  if (satoshi > SATOSHI_MAX) {
    throw new Error(`Invalid ${label}: exceeds max satoshi range`);
  }
  return satoshi;
}

function assertUInt32(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`Invalid ${label}: expected uint32`);
  }
  return value;
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

export function selectUtxos(utxos: UTXO[], target: AtomicLike) {
  const targetAtomic = toSatoshiBigInt(target, "target");
  // simple largest-first
  const sorted = [...utxos].sort((a, b) => {
    const bValue = toSatoshiBigInt(b.value, "utxo.value");
    const aValue = toSatoshiBigInt(a.value, "utxo.value");
    if (bValue > aValue) return 1;
    if (bValue < aValue) return -1;
    return 0;
  });
  const picked: UTXO[] = [];
  let sum = 0n;
  for (const u of sorted) {
    picked.push(u);
    sum += toSatoshiBigInt(u.value, "utxo.value");
    if (sum >= targetAtomic) break;
  }
  if (sum < targetAtomic) throw new Error("insufficient funds");
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
  traceId?: string;
}) {
  const { network, utxos, wif, to, amount, changeAddress, fee, traceId } = params;
  const trace = (stage: "BUILT" | "SIGNED", extra: Record<string, unknown>) => {
    if (!traceId) return;
    console.info("[wallet-core][txbuilder]", { traceId, stage, ...extra });
  };

  const net = toBitcoinNetwork(network);
  const keyPair = ECPair.fromWIF(wif, net);
  const psbt = new bitcoin.Psbt({ network: net });

  let totalIn = 0n;
  utxos.forEach(u => {
    psbt.addInput({
      hash: u.txid,
      index: assertUInt32(u.vout, `utxo[${u.txid}:${u.vout}].vout`),
      nonWitnessUtxo: Buffer.from(u.nonWitnessUtxo, "hex")
    });
    totalIn += toSatoshiBigInt(u.value, "utxo.value");
  });

  const amountSats = toSatoshiBigInt(amount, "amount");
  const feeSats = toSatoshiBigInt(fee, "fee");

  psbt.addOutput({ address: to, value: amountSats });
  const change = totalIn - amountSats - feeSats;
  if (change < 0) throw new Error("Insufficient funds including fee");
  if (change > 0) psbt.addOutput({ address: changeAddress, value: change });
  trace("BUILT", {
    inputs: utxos.length,
    totalInAtomic: totalIn.toString(),
    amountAtomic: amountSats.toString(),
    feeAtomic: feeSats.toString(),
    changeAtomic: change.toString(),
    outputs: change > 0n ? 2 : 1,
  });

  utxos.forEach((_, i) => psbt.signInput(i, keyPair));
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  trace("SIGNED", {
    rawTxBytes: rawTx.length / 2,
  });
  return rawTx;
}
