import { StrategyRunner, StrategyType } from "./types.js";
import { dcaRunner } from "./dcaRunner.js";
import { gridRunner } from "./gridRunner.js";
import { mmRunner } from "./mmRunner.js";
import { devmmRunner } from "./devmmRunner.js";

export const strategyRunners: Record<StrategyType, StrategyRunner> = {
    DCA: dcaRunner,
    GRID: gridRunner,
    MM: mmRunner,
    DEVMM: devmmRunner,
};

export function getStrategyRunner(strategy: string): StrategyRunner | null {
    const key = strategy.toUpperCase() as StrategyType;
    return strategyRunners[key] || null;
}
