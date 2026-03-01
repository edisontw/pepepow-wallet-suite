import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `trade-api-mm-devmm-collision-${Date.now()}.db`);
process.env.TRADE_DB_PATH = dbPath;

const EXPECTED_DISABLED_REASON = "DEVMM_OWNS_PAIR:F04_MM_DEVMM_COLLISION";
const EXPECTED_AUDIT_REASON = `SCHEDULER:${EXPECTED_DISABLED_REASON}`;

async function main(): Promise<void> {
    const dbModule = await import("../db.js");
    const {
        upsertStrategyConfig,
        upsertDevmmConfig,
        insertStrategyOrder,
        insertStrategyOrderRegistry,
        getStrategyConfigById,
        getOpenStrategyOrdersRegistry,
    } = dbModule;
    const db = dbModule.default;
    const { runSchedulerTickOnce } = await import("../scheduler.js");

    const mmConfig = upsertStrategyConfig({
        tgUserId: "mm_collision_user",
        exchange: "nonkyc",
        pair: "PEPEW/USDT",
        tradeMode: "REAL",
        strategy: "MM",
        paramsJson: JSON.stringify({
            mode: "TWO_SIDED",
            spread_pct: 0.01,
            quote_per_order: 1.05,
            orders_per_side: 1,
            refresh_sec: 30,
        }),
        enabled: true,
    });

    upsertDevmmConfig({
        exchange: "nonkyc",
        symbol: "PEPEW/USDT",
        tgUserId: "devmm_collision_user",
        orderQuoteUsdt: 1.05,
        refreshSeconds: 45,
    });

    insertStrategyOrder({
        configId: mmConfig.id,
        tgUserId: mmConfig.tg_user_id,
        exchange: "nonkyc",
        pair: "PEPEW/USDT",
        strategy: "MM",
        tradeMode: "REAL",
        side: "BUY",
        price: 4.40e-7,
        qty: 2_386_363,
        quoteQty: 1.05,
        status: "OPEN",
        exchangeOrderId: "mm-collision-buy-1",
        clientOrderId: "PPW-MM-COLLISION-BUY-1",
    });
    insertStrategyOrder({
        configId: mmConfig.id,
        tgUserId: mmConfig.tg_user_id,
        exchange: "nonkyc",
        pair: "PEPEW/USDT",
        strategy: "MM",
        tradeMode: "REAL",
        side: "SELL",
        price: 4.60e-7,
        qty: 2_282_608,
        quoteQty: 1.05,
        status: "OPEN",
        exchangeOrderId: "mm-collision-sell-1",
        clientOrderId: "PPW-MM-COLLISION-SELL-1",
    });

    insertStrategyOrderRegistry({
        strategy_id: String(mmConfig.id),
        exchange: "nonkyc",
        pair: "PEPEW/USDT",
        order_id: "mm-collision-buy-1",
        client_order_id: "PPW-MM-COLLISION-BUY-1",
        side: "BUY",
        price: "4.40e-7",
        qty: "2386363",
        status: "OPEN",
    });
    insertStrategyOrderRegistry({
        strategy_id: String(mmConfig.id),
        exchange: "nonkyc",
        pair: "PEPEW/USDT",
        order_id: "mm-collision-sell-1",
        client_order_id: "PPW-MM-COLLISION-SELL-1",
        side: "SELL",
        price: "4.60e-7",
        qty: "2282608",
        status: "OPEN",
    });

    await runSchedulerTickOnce();

    const mmAfter = getStrategyConfigById(mmConfig.id);
    const registryOpen = getOpenStrategyOrdersRegistry(String(mmConfig.id));
    const tradeOpenCount = Number(
        (db.prepare("SELECT COUNT(*) AS c FROM trade_strategy_order WHERE config_id = ? AND status = 'OPEN'").get(mmConfig.id) as any)?.c || 0
    );
    const registryCancelledCount = Number(
        (db.prepare("SELECT COUNT(*) AS c FROM strategy_order WHERE strategy_id = ? AND status = 'CANCELLED'").get(String(mmConfig.id)) as any)?.c || 0
    );
    const tradeCanceledCount = Number(
        (db.prepare("SELECT COUNT(*) AS c FROM trade_strategy_order WHERE config_id = ? AND status = 'CANCELED'").get(mmConfig.id) as any)?.c || 0
    );
    const collisionSkipCount = Number(
        (db.prepare(
            "SELECT COUNT(*) AS c FROM trade_audit WHERE strategy_type = 'MM' AND strategy_id = ? AND action = 'skip' AND reason = ?"
        ).get(String(mmConfig.id), EXPECTED_AUDIT_REASON) as any)?.c || 0
    );

    if (!mmAfter) {
        throw new Error("MM config missing after scheduler tick");
    }
    if (mmAfter.enabled !== 0) {
        throw new Error(`expected MM enabled=0, got ${mmAfter.enabled}`);
    }
    if (mmAfter.disabled_reason !== EXPECTED_DISABLED_REASON) {
        throw new Error(`expected disabled_reason=${EXPECTED_DISABLED_REASON}, got ${mmAfter.disabled_reason}`);
    }
    if (registryOpen.length !== 0) {
        throw new Error(`expected strategy_order OPEN=0, got ${registryOpen.length}`);
    }
    if (tradeOpenCount !== 0) {
        throw new Error(`expected trade_strategy_order OPEN=0, got ${tradeOpenCount}`);
    }
    if (registryCancelledCount < 2) {
        throw new Error(`expected strategy_order CANCELLED>=2, got ${registryCancelledCount}`);
    }
    if (tradeCanceledCount < 2) {
        throw new Error(`expected trade_strategy_order CANCELED>=2, got ${tradeCanceledCount}`);
    }
    if (collisionSkipCount < 1) {
        throw new Error(`expected collision skip audit >=1, got ${collisionSkipCount}`);
    }

    console.log("[verify-mm-devmm-collision] PASS");
    console.log(
        JSON.stringify(
            {
                dbPath,
                mmConfigId: mmConfig.id,
                enabled: mmAfter.enabled,
                disabledReason: mmAfter.disabled_reason,
                registryOpen: registryOpen.length,
                tradeOpenCount,
                registryCancelledCount,
                tradeCanceledCount,
                collisionSkipCount,
            },
            null,
            2
        )
    );

    fs.unlinkSync(dbPath);
}

main().catch((err) => {
    console.error("[verify-mm-devmm-collision] FAIL");
    console.error(err?.stack || err?.message || String(err));
    console.error(`DB left at: ${dbPath}`);
    process.exitCode = 1;
});
