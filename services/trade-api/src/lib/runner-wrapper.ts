/**
 * Strategy Runner Wrapper
 * 
 * Provides standardized error handling, monitoring, and auto-disable safety mechanisms
 * for all strategy types.
 */

import {
    autoDisableConfig,
    clearStrategyFailures,
    getBackoffState,
    resetBackoff,
    setBackoffUntil,
    StrategyConfig,
    upsertStrategyFailure,
} from "../db.js";
import { cancelOutstandingOrders } from "../strategies/strategyHelper.js";
import { calculateBackoffMs, sanitizeErrorMessage } from "./errors/classify.js";
import { classifyExchangeError } from "../exchanges/errors.js";

interface TickResult {
    success: boolean;
    error?: {
        message?: string;
        httpStatus?: number;
        code?: string | number;
        exchangeCode?: string | number;
        details?: any;
    };
}

/**
 * Wrap a strategy tick execution with monitoring and safety checks.
 */
export async function wrapStrategyTick(
    config: StrategyConfig,
    tickFn: () => Promise<TickResult>,
    now: number
): Promise<void> {
    // 1. Backoff Check
    const backoffState = getBackoffState(config.id);
    if (backoffState.isInBackoff) {
        // Silently return during backoff (low noise)
        // Debug log only if needed
        // console.debug(`[runner] Skipping config=${config.id}: backoff until ${new Date(backoffState.nextAllowedAt).toISOString()}`);
        return;
    }

    try {
        // 2. Execute Strategy Tick
        const result = await tickFn();

        if (result.success) {
            // 3. Success Handling
            // If it was previously failing (has consecutive failures), reset it
            if (backoffState.consecutiveFailures > 0) {
                resetBackoff(config.id);
                clearStrategyFailures(config.id);
                console.log(`[runner] Config=${config.id} recovered from backoff, cleared failures.`);
            }
            return;
        }

        // 4. Managed Failure Handling
        if (result.error) {
            handleStrategyError(config, result.error, backoffState.consecutiveFailures);
        }

    } catch (err: any) {
        // 5. Uncaught Exception Handling
        console.error(`[runner] Uncaught error for config=${config.id}: ${err.message}`);
        handleStrategyError(config, {
            message: err.message || "Unknown internal error",
            code: err.code,
        }, backoffState.consecutiveFailures);
    }
}

/**
 * Handle error classification, recording, and action (Disable/Backoff)
 */
function handleStrategyError(
    config: StrategyConfig,
    error: { message?: string; httpStatus?: number; code?: string | number; exchangeCode?: string | number; details?: any },
    currentConsecutiveFailures: number
): void {
    const classification = classifyExchangeError(config.exchange, {
        message: error.message,
        httpStatus: error.httpStatus,
        code: error.code,
        exchangeCode: error.exchangeCode,
        details: error.details,
    });

    const newConsecutiveFailures = currentConsecutiveFailures + 1;
    const shouldDisable = classification.shouldAutoDisable;

    // Record Failure (Aggregated)
    upsertStrategyFailure({
        configId: config.id,
        category: classification.category,
        message: sanitizeErrorMessage(error.message || "Unknown error"),
        httpStatus: error.httpStatus,
        exchangeCode: error.exchangeCode ?? error.code,
        detailsJson: error.details ? JSON.stringify(error.details) : null,
    });

    // Take Action
    if (shouldDisable) {
        console.warn(`[runner] Auto-disabling config=${config.id} reason=${classification.category}`);
        autoDisableConfig(config.id, classification.category);

        // Trigger order cancellation on auto-disable for safety
        cancelOutstandingOrders(config.id).catch(err => {
            console.warn(`[runner] Failed to cancel orders for config=${config.id} after auto-disable: ${err.message}`);
        });

        // Note: verify step might need to see an event, but we want low noise. 
        // The failure table IS the record. The UI will show "AUTO-STOPPED".
    } else if (classification.retryable) {
        const backoffMs = calculateBackoffMs(newConsecutiveFailures);
        const nextAllowedAt = Date.now() + backoffMs;

        console.warn(`[runner] Backoff config=${config.id} for ${backoffMs}ms (failures=${newConsecutiveFailures}) reason=${classification.category}`);

        setBackoffUntil({
            configId: config.id,
            nextAllowedAt,
            consecutiveFailures: newConsecutiveFailures,
        });
    } else {
        console.log(`[runner] Recorded non-retryable error for config=${config.id}: ${classification.category}`);
    }
}
