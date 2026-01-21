import { buildAndSignP2PKH, PEPEPOW, type PepepowNetwork } from "@pepepow/wallet-core";
import type { Utxo } from "../lib/walletStore";

export const MAX_CONSOLIDATE_INPUTS = 200;
export const MAX_CONSOLIDATE_TX_BYTES = 100000;

export type ConsolidationInput = {
  txid: string;
  vout: number;
  value: number;
  nonWitnessUtxo: string;
};

export function selectConsolidationUtxos(utxos: Utxo[], maxInputs = MAX_CONSOLIDATE_INPUTS) {
  return [...utxos]
    .sort((a, b) => a.valueSats - b.valueSats)
    .slice(0, maxInputs);
}

export function estimateP2PKHTxBytes(inputCount: number, outputCount = 1) {
  // Legacy P2PKH size model: 10 bytes base + 148 bytes per input + 34 bytes per output.
  return 10 + inputCount * 148 + outputCount * 34;
}

export function buildConsolidationTx(params: {
  inputs: ConsolidationInput[];
  address: string;
  feeSats: number;
  wif: string;
  network?: PepepowNetwork;
}) {
  const { inputs, address, feeSats, wif, network = PEPEPOW } = params;
  const totalInSats = inputs.reduce((sum, u) => sum + Number(u.value || 0), 0);
  const outputSats = totalInSats - feeSats;
  if (outputSats <= 0) {
    throw new Error("insufficient funds including fee");
  }
  const rawTx = buildAndSignP2PKH({
    network,
    utxos: inputs,
    wif,
    to: address,
    amount: outputSats,
    changeAddress: address,
    fee: feeSats
  });
  return { rawTx, totalInSats, outputSats };
}
