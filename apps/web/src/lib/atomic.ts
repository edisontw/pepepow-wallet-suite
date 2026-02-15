export type AtomicValue = string | number | bigint;

type AtomicToNumberOptions = {
  max?: bigint;
};

const DECIMAL_INTEGER_RE = /^-?\d+$/;
const COIN_INPUT_RE = /^\d+(\.\d+)?$/;
const DIGITS_ONLY_RE = /^\d+$/;

function stripLeadingZeros(value: string) {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const stripped = digits.replace(/^0+(?=\d)/, "") || "0";
  if (stripped === "0") return "0";
  return negative ? `-${stripped}` : stripped;
}

export function normalizeAtomic(value: AtomicValue): string {
  if (typeof value === "bigint") return stripLeadingZeros(value.toString());

  if (typeof value === "number") {
    throw new Error(`Invalid atomic number in core path: ${value}`);
  }

  const trimmed = value.trim();
  if (!trimmed) throw new Error("Invalid atomic string: empty");
  if (!DECIMAL_INTEGER_RE.test(trimmed)) {
    throw new Error(`Invalid atomic string: ${value}`);
  }
  return stripLeadingZeros(trimmed);
}

export function toAtomicBigInt(input: string, decimals = 8): bigint {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid decimal amount: empty");
  }
  const normalized = trimmed.replace(/,/g, "");
  if (!COIN_INPUT_RE.test(normalized)) {
    throw new Error(`Invalid decimal amount: ${input}`);
  }

  const [wholeRaw, fracRaw = ""] = normalized.split(".");
  if (fracRaw.length > decimals) {
    throw new Error(`Invalid decimal amount: exceeds ${decimals} decimals`);
  }
  const whole = wholeRaw || "0";
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(`${whole}${frac}`);
}

export function atomicToString(v: bigint): string {
  return v.toString();
}

export function assertAtomic(v: unknown, label: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    throw new Error(`Invalid ${label}: number is not allowed in atomic core`);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) {
      throw new Error(`Invalid ${label}: empty`);
    }
    if (!DIGITS_ONLY_RE.test(trimmed)) {
      throw new Error(`Invalid ${label}: expected digits-only atomic string`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`Invalid ${label}: unsupported type ${typeof v}`);
}

export function validateAtomicRange(v: bigint, label: string, max: bigint) {
  if (v < 0n) {
    throw new Error(`Atomic ${label} must be non-negative: ${v.toString()}`);
  }
  if (v > max) {
    throw new Error(`Atomic ${label} exceeds max ${max.toString()}: ${v.toString()}`);
  }
}

export function coinInputToAtomicString(coin: string, decimals = 8): string | null {
  try {
    return atomicToString(toAtomicBigInt(coin, decimals));
  } catch {
    return null;
  }
}

export function atomicToBigInt(atomic: string): bigint {
  return assertAtomic(normalizeAtomic(atomic), "atomic");
}

export function atomicToSafeNumber(atomic: string, opts: AtomicToNumberOptions = {}): number {
  const normalized = normalizeAtomic(atomic);
  const asBigInt = BigInt(normalized);
  if (asBigInt < 0n) {
    throw new Error(`Atomic value must be non-negative: ${normalized}`);
  }
  if (opts.max !== undefined && asBigInt > opts.max) {
    throw new Error(`Atomic value exceeds max ${opts.max.toString()}: ${normalized}`);
  }
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Atomic value exceeds Number.MAX_SAFE_INTEGER: ${normalized}`);
  }
  return Number(asBigInt);
}

export function describeOutputShape(outputs: unknown): string {
  if (!Array.isArray(outputs)) return `outputs:${typeof outputs}`;
  if (outputs.length === 0) return "outputs:[]";

  const shape = outputs.slice(0, 3).map((output, idx) => {
    if (Array.isArray(output)) {
      const addrType = typeof output[0];
      const amtType = typeof output[1];
      return `outputs[${idx}]=[addr:${addrType}, amt:${amtType}]`;
    }

    if (output && typeof output === "object") {
      const asRecord = output as Record<string, unknown>;
      const addressValue = asRecord.address ?? asRecord.to;
      const amountValue = asRecord.value ?? asRecord.amount;
      return `outputs[${idx}]={address:${typeof addressValue}, value:${typeof amountValue}}`;
    }

    return `outputs[${idx}]=${typeof output}`;
  });

  if (outputs.length > 3) {
    shape.push(`... +${outputs.length - 3} more`);
  }

  return shape.join(" ");
}
