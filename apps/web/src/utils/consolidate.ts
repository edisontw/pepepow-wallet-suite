import { buildAndSignP2PKH, PEPEPOW, type PepepowNetwork } from "@pepepow/wallet-core";
import type { Utxo } from "../lib/walletStore";
import { assertAtomic, atomicToString, validateAtomicRange, type AtomicValue } from "../lib/atomic";
import { MAX_ATOMIC } from "../lib/amount";

export const MAX_CONSOLIDATE_INPUTS = 80;
export const MAX_SEND_INPUTS = 80;
export const MAX_CONSOLIDATE_TX_BYTES = 100000;

export type ConsolidationInput = {
  txid: string;
  vout: number;
  value: AtomicValue;
  nonWitnessUtxo: string;
};

export function selectConsolidationUtxos(utxos: Utxo[], maxInputs = MAX_CONSOLIDATE_INPUTS) {
  return [...utxos]
    .sort((a, b) => a.valueSats - b.valueSats)
    .slice(0, maxInputs);
}

export function estimateConsolidationRounds(totalUtxos: number, roundSize = MAX_CONSOLIDATE_INPUTS) {
  if (!Number.isFinite(totalUtxos) || totalUtxos <= 0) return 0;
  const safeRound = Math.max(1, Math.floor(roundSize));
  return Math.ceil(totalUtxos / safeRound);
}

export function estimateP2PKHTxBytes(inputCount: number, outputCount = 1) {
  // Legacy P2PKH size model: 10 bytes base + 148 bytes per input + 34 bytes per output.
  return 10 + inputCount * 148 + outputCount * 34;
}

export function buildConsolidationTx(params: {
  inputs: ConsolidationInput[];
  address: string;
  feeSats: AtomicValue;
  wif: string;
  network?: PepepowNetwork;
}) {
  const { inputs, address, feeSats, wif, network = PEPEPOW } = params;
  const feeAtomic = assertAtomic(feeSats, "feeAtomic");
  const totalInAtomic = inputs.reduce(
    (sum, u, idx) => sum + assertAtomic(u.value, `inputs[${idx}].value`),
    0n
  );
  const outputAtomic = totalInAtomic - feeAtomic;
  if (outputAtomic <= 0n) {
    throw new Error("insufficient funds including fee");
  }
  validateAtomicRange(feeAtomic, "feeAtomic", MAX_ATOMIC);
  validateAtomicRange(totalInAtomic, "totalInAtomic", MAX_ATOMIC);
  validateAtomicRange(outputAtomic, "outputAtomic", MAX_ATOMIC);

  const normalizedInputs = inputs.map((input) => ({
    ...input,
    value: atomicToString(assertAtomic(input.value, `input:${input.txid}:${input.vout}`)),
  }));

  const rawTx = buildAndSignP2PKH({
    network,
    utxos: normalizedInputs,
    wif,
    to: address,
    amount: atomicToString(outputAtomic),
    changeAddress: address,
    fee: atomicToString(feeAtomic)
  });

  return { rawTx, totalInAtomic, outputAtomic };
}
