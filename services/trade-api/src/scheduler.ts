import { getEnabledDevmmConfigs, getEnabledStrategyConfigs } from "./db.js";
import { devmmRunner } from "./strategies/devmmRunner.js";
import { DevmmIssueCode, DEVMM_SCHEDULER_REASON_DEVMM_OWNS_PAIR } from "./strategies/devmmCodes.js";
import { getStrategyRunner } from "./strategies/runner.js";
import { normalizeExchangeId } from "./registry/exchanges.js";
import { toCanonicalPair } from "./registry/pairs.js";

const SCHEDULER_INTERVAL_MS = 10_000; // 10 seconds

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
        console.log(`[scheduler] tick: ${configs.length} enabled config(s)`);

        for (const config of configs) {
            const strategyName = String(config.strategy || "").toUpperCase();
            if (strategyName === "MM") {
                const normalizedExchange = normalizeExchangeSafe(String(config.exchange || ""));
                const canonicalPair = normalizePairSafe(String(config.pair || ""));
                if (normalizedExchange && canonicalPair) {
                    const occupiedGlobal = devmmGlobalOccupancy.has(buildOccupancyKey("*", normalizedExchange, canonicalPair));
                    if (occupiedGlobal) {
                        console.log(
                            `[scheduler] skip strategy=MM config=${config.id} reason=${DEVMM_SCHEDULER_REASON_DEVMM_OWNS_PAIR} issueCode=${DevmmIssueCode.F04_MM_DEVMM_COLLISION} exchange=${normalizedExchange} pair=${canonicalPair}`
                        );
                        continue;
                    }
                }
            }
            const runner = getStrategyRunner(config.strategy);
            if (!runner) {
                console.warn(`[scheduler] No runner for strategy=${config.strategy} config=${config.id}`);
                continue;
            }
            console.log(`[scheduler] dispatch strategy=${config.strategy} config=${config.id}`);
            await runner.tick(config.id, now);
        }
    } catch (err: any) {
        console.error(`[scheduler] Tick error: ${err.message}`);
    }

    try {
        const devmmConfigs = getEnabledDevmmConfigs();
        console.log(`[devmmScheduler] tick enabled=${devmmConfigs.length}`);

        for (const config of devmmConfigs) {
            console.log(`[devmmScheduler] dispatch DEVMM id=${config.id} exchange=${config.exchange}`);
            await devmmRunner.tick(config.id, now);
        }
    } catch (err: any) {
        console.error(`[devmmScheduler] Tick error: ${err.message}`);
    }
}

let schedulerInterval: NodeJS.Timeout | null = null;

export function startScheduler(): void {
    if (schedulerInterval) {
        console.warn("[scheduler] Already running");
        return;
    }

    console.log(`[scheduler] Starting strategy scheduler (interval: ${SCHEDULER_INTERVAL_MS}ms)`);

    // Run immediately once
    runSchedulerTick();

    // Then run on interval
    schedulerInterval = setInterval(runSchedulerTick, SCHEDULER_INTERVAL_MS);
}

export function stopScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log("[scheduler] Stopped");
    }
}
