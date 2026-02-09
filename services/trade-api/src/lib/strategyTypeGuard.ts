import db from "../db.js";

export type RuntimeStrategyType = "DCA" | "GRID" | "MM" | "DEVMM";

export interface StrategyTypeCount {
    type: RuntimeStrategyType;
    count: number;
}

export interface StrategyTypeConflict {
    requestedType: RuntimeStrategyType;
    activeTypes: StrategyTypeCount[];
    blockingTypes: StrategyTypeCount[];
}

const TYPE_ORDER: RuntimeStrategyType[] = ["DCA", "GRID", "MM", "DEVMM"];
const TYPE_SET = new Set<RuntimeStrategyType>(TYPE_ORDER);

function normalizeRuntimeType(value: unknown): RuntimeStrategyType | null {
    if (typeof value !== "string") return null;
    const upper = value.trim().toUpperCase() as RuntimeStrategyType;
    return TYPE_SET.has(upper) ? upper : null;
}

function sortedTypeCounts(counts: Map<RuntimeStrategyType, number>): StrategyTypeCount[] {
    const ranked = TYPE_ORDER.map((type, index) => ({ type, index }));
    const orderMap = new Map<RuntimeStrategyType, number>(ranked.map((item) => [item.type, item.index]));
    return Array.from(counts.entries())
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => (orderMap.get(a.type) ?? 999) - (orderMap.get(b.type) ?? 999));
}

export function getActiveStrategyTypeCounts(tgUserId: string): StrategyTypeCount[] {
    if (!tgUserId) return [];

    const counts = new Map<RuntimeStrategyType, number>();

    const strategyRows = db.prepare(`
        SELECT UPPER(strategy) AS strategy_type, COUNT(*) AS count
        FROM trade_strategy_config
        WHERE tg_user_id = ? AND enabled = 1
        GROUP BY UPPER(strategy)
    `).all(tgUserId) as Array<{ strategy_type: string; count: number }>;

    for (const row of strategyRows) {
        const type = normalizeRuntimeType(row.strategy_type);
        if (!type || type === "DEVMM") continue;
        counts.set(type, (counts.get(type) || 0) + Number(row.count || 0));
    }

    const devmmRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM devmm_config c
        LEFT JOIN devmm_state s ON s.exchange = c.exchange AND s.symbol = c.symbol
        WHERE c.tg_user_id = ?
          AND c.is_enabled = 1
          AND (s.status IS NULL OR s.status IN ('ACTIVE', 'DEGRADED'))
    `).get(tgUserId) as { count: number } | undefined;

    const devmmCount = Number(devmmRow?.count || 0);
    if (devmmCount > 0) {
        counts.set("DEVMM", devmmCount);
    }

    return sortedTypeCounts(counts);
}

export function getStrategyTypeConflict(
    tgUserId: string,
    requestedType: RuntimeStrategyType
): StrategyTypeConflict | null {
    const activeTypes = getActiveStrategyTypeCounts(tgUserId);
    const blockingTypes = activeTypes.filter((item) => item.type !== requestedType);
    if (blockingTypes.length === 0) return null;
    return { requestedType, activeTypes, blockingTypes };
}

export function formatStrategyTypeCounts(counts: StrategyTypeCount[]): string {
    if (!counts.length) return "none";
    return counts.map((item) => `${item.type}(${item.count})`).join(", ");
}

export function buildStrategyTypeConflictMessage(
    requestedType: RuntimeStrategyType,
    blockingTypes: StrategyTypeCount[]
): string {
    return `Cannot start ${requestedType}: active strategy types ${formatStrategyTypeCounts(blockingTypes)}. Stop them first.`;
}

export function buildStrategyTypeConflictPayload(
    requestedType: RuntimeStrategyType,
    blockingTypes: StrategyTypeCount[],
    activeTypes: StrategyTypeCount[]
) {
    return {
        ok: false,
        error: "STRATEGY_TYPE_CONFLICT",
        message: buildStrategyTypeConflictMessage(requestedType, blockingTypes),
        requestedType,
        blockingTypes,
        activeTypes,
    };
}
