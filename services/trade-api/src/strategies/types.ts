export type StrategyType = "DCA" | "GRID" | "MM";

export interface StrategyRunner {
    type: StrategyType;
    tick(configId: number, now: number): Promise<void>;
}
