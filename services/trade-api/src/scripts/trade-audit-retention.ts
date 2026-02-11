import { checkpointWal, cleanupTradeAudit, getTradeAuditRetentionDays } from "../db.js";

function parseRetentionDays(): number {
    const arg = Number(process.argv[2]);
    if (Number.isFinite(arg) && arg > 0) {
        return Math.floor(arg);
    }
    return getTradeAuditRetentionDays();
}

function run(): void {
    const days = parseRetentionDays();
    const deleted = cleanupTradeAudit(days);
    const checkpoint = checkpointWal("TRUNCATE");

    console.log(
        `[trade-audit-retention] days=${days} deleted=${deleted} wal.busy=${checkpoint.busy} wal.log=${checkpoint.log} wal.checkpointed=${checkpoint.checkpointed}`
    );
}

run();
