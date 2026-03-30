export const PEPEW_DECIMALS = 8;
export const MAX_ATOMIC = 9223372036854775807n;
const DIGITS_RE = /^\d+$/;
function pow10(decimals) {
    return 10n ** BigInt(decimals);
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function groupThousands(input) {
    return input.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function parsePepewToAtomic(input, decimals = PEPEW_DECIMALS) {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`Invalid decimals: ${decimals}`);
    }
    const raw = String(input ?? "");
    const normalized = raw.trim().replace(/,/g, "").replace(/\s+/g, "");
    if (!normalized)
        throw new Error("Invalid decimal amount: empty");
    if (normalized.includes("-"))
        throw new Error(`Invalid decimal amount: negative value ${input}`);
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new Error(`Invalid decimal amount: ${input}`);
    }
    const [wholeRaw, fracRaw = ""] = normalized.split(".");
    const whole = wholeRaw || "0";
    const base = pow10(decimals);
    let atomic = BigInt(whole) * base;
    if (decimals > 0) {
        const fracTake = fracRaw.slice(0, decimals);
        const fracPadded = (fracTake + "0".repeat(decimals)).slice(0, decimals);
        atomic += fracPadded ? BigInt(fracPadded) : 0n;
        if (fracRaw.length > decimals) {
            const roundDigit = fracRaw[decimals];
            if (roundDigit && DIGITS_RE.test(roundDigit) && Number(roundDigit) >= 5) {
                atomic += 1n;
            }
        }
    }
    return atomic;
}
export function formatAtomicToPepew(atomic, decimals = PEPEW_DECIMALS, opts = {}) {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`Invalid decimals: ${decimals}`);
    }
    if (atomic < 0n) {
        throw new Error(`Invalid atomic amount: ${atomic.toString()}`);
    }
    const group = opts.group ?? true;
    const trimTrailingZeros = opts.trimTrailingZeros ?? true;
    const maxFractionDigits = clamp(opts.maxFractionDigits ?? decimals, 0, decimals);
    const minFractionDigits = clamp(opts.minFractionDigits ?? 0, 0, maxFractionDigits);
    let roundedAtomic = atomic;
    if (maxFractionDigits < decimals) {
        const divisor = pow10(decimals - maxFractionDigits);
        const quotient = atomic / divisor;
        const remainder = atomic % divisor;
        roundedAtomic = remainder * 2n >= divisor ? quotient + 1n : quotient;
    }
    const displayBase = pow10(maxFractionDigits);
    const wholeRaw = maxFractionDigits > 0
        ? (roundedAtomic / displayBase).toString()
        : roundedAtomic.toString();
    let fraction = maxFractionDigits > 0
        ? (roundedAtomic % displayBase).toString().padStart(maxFractionDigits, "0")
        : "";
    if (maxFractionDigits > 0) {
        if (trimTrailingZeros) {
            while (fraction.length > minFractionDigits && fraction.endsWith("0")) {
                fraction = fraction.slice(0, -1);
            }
        }
        if (fraction.length < minFractionDigits) {
            fraction = fraction.padEnd(minFractionDigits, "0");
        }
    }
    const whole = group ? groupThousands(wholeRaw) : wholeRaw;
    if (fraction.length === 0)
        return whole;
    return `${whole}.${fraction}`;
}
export function addAtomic(a, b) {
    return a + b;
}
export function cmpAtomic(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
