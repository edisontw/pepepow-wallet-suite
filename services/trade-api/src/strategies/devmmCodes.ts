export enum DevmmIssueCode {
    F01_START_CAP_LOCK = "F01_START_CAP_LOCK",
    F02_BOOTSTRAP_ONE_SIDE = "F02_BOOTSTRAP_ONE_SIDE",
    F03_NESTEX_SIDE_UNKNOWN = "F03_NESTEX_SIDE_UNKNOWN",
    F04_MM_DEVMM_COLLISION = "F04_MM_DEVMM_COLLISION",
    F05_NOT_VISIBLE_DUP_BURST = "F05_NOT_VISIBLE_DUP_BURST",
    F06_KEYS_SCOPE_MISMATCH = "F06_KEYS_SCOPE_MISMATCH",
    F07_ZERO_SPREAD_LOOP = "F07_ZERO_SPREAD_LOOP",
    F08_UNKNOWN_ORDERS_PRESENT = "F08_UNKNOWN_ORDERS_PRESENT",
}

export enum DevmmSkipReason {
    DAILY_CAP_REACHED = "DAILY_CAP_REACHED",
    HOURLY_CAP_REACHED = "HOURLY_CAP_REACHED",
    PENDING_NOT_VISIBLE = "PENDING_NOT_VISIBLE",
    MAX_OPEN_ORDERS_SOFT = "MAX_OPEN_ORDERS_SOFT",
    MAX_NEW_ORDERS_PER_TICK = "MAX_NEW_ORDERS_PER_TICK",
    NO_CROSSING = "NO_CROSSING",
    MIN_NOTIONAL = "MIN_NOTIONAL",
    BOOTSTRAP_ONE_SIDE = "BOOTSTRAP_ONE_SIDE",
}

export enum DevmmPauseReason {
    INVALID_EXCHANGE = "INVALID_EXCHANGE",
    NO_API_KEYS = "NO_API_KEYS",
    KEY_DECRYPT_FAILED = "KEY_DECRYPT_FAILED",
    SPREAD_TOO_NARROW = "SPREAD_TOO_NARROW",
    SPREAD_TOO_WIDE = "SPREAD_TOO_WIDE",
    TREND_DEVIATION = "TREND_DEVIATION",
    CANCEL_FAILED = "CANCEL_FAILED",
    POST_ONLY_REJECT = "POST_ONLY_REJECT",
    BALANCE_FETCH_FAILED = "BALANCE_FETCH_FAILED",
    BALANCE_CACHED = "BALANCE_CACHED",
    TICKER_FALLBACK_BOOK = "TICKER_FALLBACK_BOOK",
    ZERO_SPREAD = "ZERO_SPREAD",
}

export const DEVMM_SCHEDULER_REASON_DEVMM_OWNS_PAIR = "DEVMM_OWNS_PAIR";

export function mapSkipReasonToIssueCode(
    reason: DevmmSkipReason,
    opts?: { phase?: "BOOTSTRAP" | "NORMAL"; zeroSpread?: boolean }
): DevmmIssueCode | null {
    if (reason === DevmmSkipReason.DAILY_CAP_REACHED && opts?.phase === "BOOTSTRAP") {
        return DevmmIssueCode.F01_START_CAP_LOCK;
    }
    if (reason === DevmmSkipReason.BOOTSTRAP_ONE_SIDE) {
        return DevmmIssueCode.F02_BOOTSTRAP_ONE_SIDE;
    }
    if (reason === DevmmSkipReason.PENDING_NOT_VISIBLE) {
        return DevmmIssueCode.F05_NOT_VISIBLE_DUP_BURST;
    }
    if (reason === DevmmSkipReason.NO_CROSSING && opts?.zeroSpread) {
        return DevmmIssueCode.F07_ZERO_SPREAD_LOOP;
    }
    return null;
}

export function mapPauseReasonToIssueCode(reason: string | null | undefined): DevmmIssueCode | null {
    if (!reason) return null;
    if (reason === DevmmPauseReason.NO_API_KEYS || reason === DevmmPauseReason.KEY_DECRYPT_FAILED) {
        return DevmmIssueCode.F06_KEYS_SCOPE_MISMATCH;
    }
    return null;
}

export function parseIssueCodeFromText(text: string | null | undefined): DevmmIssueCode | null {
    if (!text) return null;
    for (const code of Object.values(DevmmIssueCode)) {
        if (text.includes(code)) return code;
    }
    return null;
}

export function extractIssueCodesFromText(text: string | null | undefined): DevmmIssueCode[] {
    if (!text) return [];
    const codes: DevmmIssueCode[] = [];
    for (const code of Object.values(DevmmIssueCode)) {
        if (text.includes(code)) {
            codes.push(code);
        }
    }
    return codes;
}
