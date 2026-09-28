export const PEPEW_FEE_RATE_ATOMIC_PER_KB = 10_000n;
export const PEPEW_MIN_FEE_ATOMIC = 10_000n;
export const FEE_RATE_BYTES_PER_KB = 1_000n;

function assertCount(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function estimateP2PKHTxBytes(inputCount: number, outputCount = 2) {
  const inputs = assertCount(inputCount, "inputCount");
  const outputs = assertCount(outputCount, "outputCount");
  // Legacy P2PKH size model: 10 bytes base + 148 bytes per input + 34 bytes per output.
  return 10 + inputs * 148 + outputs * 34;
}

export function calculateP2PKHFeeAtomic(inputCount: number, outputCount = 2) {
  const estimatedBytes = BigInt(estimateP2PKHTxBytes(inputCount, outputCount));
  const proportionalFee = (
    estimatedBytes * PEPEW_FEE_RATE_ATOMIC_PER_KB + FEE_RATE_BYTES_PER_KB - 1n
  ) / FEE_RATE_BYTES_PER_KB;
  return proportionalFee > PEPEW_MIN_FEE_ATOMIC ? proportionalFee : PEPEW_MIN_FEE_ATOMIC;
}

export type P2PKHFeeSelection = {
  covered: boolean;
  inputCount: number;
  totalInAtomic: bigint;
  feeAtomic: bigint;
  targetAtomic: bigint;
};

export function selectP2PKHFeeForSortedInputs(
  sortedInputValuesAtomic: bigint[],
  spendAmountAtomic: bigint,
  subtractFee: boolean,
  outputCount = 2,
): P2PKHFeeSelection {
  if (spendAmountAtomic <= 0n) {
    throw new Error("spendAmountAtomic must be positive");
  }

  let totalInAtomic = 0n;
  let feeAtomic = PEPEW_MIN_FEE_ATOMIC;
  let targetAtomic = subtractFee ? spendAmountAtomic : spendAmountAtomic + feeAtomic;

  for (let i = 0; i < sortedInputValuesAtomic.length; i += 1) {
    const valueAtomic = sortedInputValuesAtomic[i];
    if (typeof valueAtomic !== "bigint" || valueAtomic < 0n) {
      throw new Error(`sortedInputValuesAtomic[${i}] must be a non-negative bigint`);
    }
    totalInAtomic += valueAtomic;
    feeAtomic = calculateP2PKHFeeAtomic(i + 1, outputCount);
    targetAtomic = subtractFee ? spendAmountAtomic : spendAmountAtomic + feeAtomic;
    if (totalInAtomic >= targetAtomic) {
      return {
        covered: true,
        inputCount: i + 1,
        totalInAtomic,
        feeAtomic,
        targetAtomic,
      };
    }
  }

  if (sortedInputValuesAtomic.length > 0) {
    feeAtomic = calculateP2PKHFeeAtomic(sortedInputValuesAtomic.length, outputCount);
    targetAtomic = subtractFee ? spendAmountAtomic : spendAmountAtomic + feeAtomic;
  }

  return {
    covered: false,
    inputCount: sortedInputValuesAtomic.length,
    totalInAtomic,
    feeAtomic,
    targetAtomic,
  };
}
