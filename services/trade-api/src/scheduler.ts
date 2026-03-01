import {
    cancelOpenStrategyOrders,
    getEnabledDevmmConfigs,
    getEnabledStrategyConfigs,
    insertTradeAudit,
    setStrategyDisabledWithReason,
} from "./db.js";
import { devmmRunner } from "./strategies/devmmRunner.js";
import { DevmmIssueCode, DEVMM_SCHEDULER_REASON_DEVMM_OWNS_PAIR } from "./strategies/devmmCodes.js";
import { getStrategyRunner } from "./strategies/runner.js";
import { normalizeExchangeId } from "./registry/exchanges.js";
import { toCanonicalPair } from "./registry/pairs.js";
import { tradeLog } from "./lib/tradeLogger.js";
import { cancelOutstandingOrders } from "./strategies/strategyHelper.js";

const SCHEDULER_INTERVAL_MS = 10_000; // 10 seconds
const MM_DEVMM_COLLISION_REASON = `${DEVMM_SCHEDULER_REASON_DEVMM_OWNS_PAIR}:${DevmmIssueCode.F04_MM_DEVMM_COLLISION}`;
const MM_DEVMM_COLLISION_AUDIT_REASON = `SCHEDULER:${MM_DEVMM_COLLISION_REASON}`;

function buildOccupancyKey(tgUserId: string, exchange: string, pair: string): string {
    return `${tgUserId}|${exchange}|${pair}`;
}

function normalizeExchangeSafe(input: string): string | null {
    try {
        return normalizeExchangeId(input);
    } catch {
        return null;
    }
}

function normalizePairSafe(input: string): string | null {
    try {
        return toCanonicalPair(input);
    } catch {
        return null;
    }
}

async function runSchedulerTick(): Promise<void> {
    const now = Date.now();

    try {
        const devmmConfigs = getEnabledDevmmConfigs();
        const devmmGlobalOccupancy = new Set<string>();
        for (const config of devmmConfigs) {
            const normalizedExchange = normalizeExchangeSafe(String(config.exchange || ""));
            const canonicalPair = normalizePairSafe(String(config.symbol || ""));
            if (!normalizedExchange || !canonicalPair) continue;
            devmmGlobalOccupancy.add(buildOccupancyKey("*", normalizedExchange, canonicalPair));
        }

        const configs = getEnabledStrategyConfigs();
        tradeLog({
            scope: "scheduler",
            level: "info",
            message: `tick enabled=${configs.length}`,
            throttleKey: "scheduler:tick",
            throttleSec: 30,
        });

        for (const config of configs) {
            const strategyName = String(config.strategy || "").toUpperCase();
            if (strategyName === "MM") {
                const normalizedExchange = normalizeExchangeSafe(String(config.exchange || ""));
                const canonicalPair = normalizePairSafe(String(config.pair || ""));
                if (normalizedExchange && canonicalPair) {
                    const occupiedGlobal = devmmGlobalOccupancy.has(buildOccupancyKey("*", normalizedExchange, canonicalPair));
                    if (occupiedGlobal) {
                        tradeLog({
                            scope: "scheduler",
                            level: "warn",
                            message: `skip strategy=MM config=${config.id} reason=${DEVMM_SCHEDULER_REASON_DEVMM_OWNS_PAIR} issueCode=${DevmmIssueCode.F04_MM_DEVMM_COLLISION} exchange=${normalizedExchange} pair=${canonicalPair}`,
                            throttleKey: `scheduler:mm-collision:${config.id}`,
                            throttleSec: 30,
                        });
                        insertTradeAudit({
                            ts: now,
                            strategyId: config.id,
                            strategyType: "MM",
                            exchange: config.exchange,
                            pair: config.pair,
                            action: "skip",
                            reason: MM_DEVMM_COLLISION_AUDIT_REASON,
                        });

                        const disabled = setStrategyDisabledWithReason(config.id, config.tg_user_id, MM_DEVMM_COLLISION_REASON);
                        let cancelled = 0;
                        let failed = 0;
                        let alreadyClosed = 0;

                        try {
                            const cancelResult = await cancelOutstandingOrders(config.id);
                            cancelled = cancelResult.cancelled;
                            failed = cancelResult.failed;
                            alreadyClosed = cancelResult.alreadyClosed;
                        } catch (err: any) {
                            tradeLog({
                                scope: "scheduler",
                                level: "error",
                                strategyId: config.id,
                                exchange: config.exchange,
                                message: `mm-collision cancelOutstandingOrders failed config=${config.id} err=${err?.message || String(err)}`,
                                throttleKey: `scheduler:mm-collision-cancel-fail:${config.id}`,
                                throttleSec: 20,
                            });
                        }

                        try {
                            cancelOpenStrategyOrders(config.id);
                        } catch (err: any) {
                            tradeLog({
                                scope: "scheduler",
                                level: "error",
                                strategyId: config.id,
                                exchange: config.exchange,
                                message: `mm-collision cancelOpenStrategyOrders failed config=${config.id} err=${err?.message || String(err)}`,
                                throttleKey: `scheduler:mm-collision-local-cancel-fail:${config.id}`,
                                throttleSec: 20,
                            });
                        }

                        tradeLog({
                            scope: "scheduler",
                            level: "info",
                            strategyId: config.id,
                            exchange: config.exchange,
                            message: `mm-collision-resolved config=${config.id} disabled=${disabled} cancelled=${cancelled} alreadyClosed=${alreadyClosed} failed=${failed}`,
                            throttleKey: `scheduler:mm-collision-resolved:${config.id}`,
                            throttleSec: 30,
                        });
                        continue;
                    }
                }
            }
            const runner = getStrategyRunner(config.strategy);
            if (!runner) {
                tradeLog({
                    scope: "scheduler",
                    level: "warn",
                    message: `No runner for strategy=${config.strategy} config=${config.id}`,
                });
                continue;
            }
            tradeLog({
                scope: "scheduler",
                level: "debug",
                strategyId: config.id,
                exchange: config.exchange,
                message: `dispatch strategy=${config.strategy} config=${config.id}`,
                throttleKey: `scheduler:dispatch:${config.id}`,
                throttleSec: 20,
            });
            await runner.tick(config.id, now);
        }
    } catch (err: any) {
        tradeLog({
            scope: "scheduler",
            level: "error",
            message: `Tick error: ${err.message}`,
            throttleKey: "scheduler:error",
            throttleSec: 20,
        });
    }

    try {
        const devmmConfigs = getEnabledDevmmConfigs();
        tradeLog({
            scope: "devmmScheduler",
            level: "info",
            message: `tick enabled=${devmmConfigs.length}`,
            throttleKey: "devmmScheduler:tick",
            throttleSec: 20,
        });

        for (const config of devmmConfigs) {
            tradeLog({
                scope: "devmmScheduler",
                level: "debug",
                strategyId: config.id,
                exchange: config.exchange,
                message: `dispatch DEVMM id=${config.id}`,
                throttleKey: `devmmScheduler:dispatch:${config.id}`,
                throttleSec: 20,
            });
            await devmmRunner.tick(config.id, now);
        }
    } catch (err: any) {
        tradeLog({
            scope: "devmmScheduler",
            level: "error",
            message: `Tick error: ${err.message}`,
            throttleKey: "devmmScheduler:error",
            throttleSec: 20,
        });
    }
}

export async function runSchedulerTickOnce(): Promise<void> {
    await runSchedulerTick();
}

let schedulerInterval: NodeJS.Timeout | null = null;

export function startScheduler(): void {
    if (schedulerInterval) {
        tradeLog({ scope: "scheduler", level: "warn", message: "Already running" });
        return;
    }

    tradeLog({
        scope: "scheduler",
        level: "info",
        message: `Starting strategy scheduler intervalMs=${SCHEDULER_INTERVAL_MS}`,
    });

    // Run immediately once
    runSchedulerTick();

    // Then run on interval
    schedulerInterval = setInterval(runSchedulerTick, SCHEDULER_INTERVAL_MS);
}

export function stopScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        tradeLog({ scope: "scheduler", level: "info", message: "Stopped" });
    }
}
