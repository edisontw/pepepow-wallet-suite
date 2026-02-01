import { getEnabledStrategyConfigs } from "./db.js";
import { getStrategyRunner } from "./strategies/runner.js";

const SCHEDULER_INTERVAL_MS = 10_000; // 10 seconds

async function runSchedulerTick(): Promise<void> {
    try {
        const configs = getEnabledStrategyConfigs();
        console.log(`[scheduler] tick: ${configs.length} enabled config(s)`);

        if (configs.length === 0) {
            return;
        }

        const now = Date.now();
        for (const config of configs) {
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
