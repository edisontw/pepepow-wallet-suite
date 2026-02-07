import crypto from "crypto";
import { getExchangeSpec } from "../registry/exchanges.js";
import { AssetCode, BalanceSnapshot, ExchangeId, RegistryError } from "../registry/types.js";

type NormalizeOptions = {
    source: "live" | "cached";
    stalenessMs: number;
    ts?: number;
};

function stableStringify(value: any): string {
    if (value === null || value === undefined) return "null";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${pairs.join(",")}}`;
}

function hashRaw(value: any): string {
    const stable = stableStringify(value);
    return crypto.createHash("sha256").update(stable).digest("hex");
}

function readPath(payload: any, path: string[]): any {
    let cursor = payload;
    for (const key of path) {
        if (cursor === null || cursor === undefined) return undefined;
        cursor = cursor[key];
    }
    return cursor;
}

function normalizeAsset(assetRaw: string, aliases: Record<string, AssetCode> | undefined): AssetCode | null {
    const normalized = assetRaw.trim().toUpperCase();
    const mapped = aliases?.[normalized] || normalized;
    if (mapped === "USDT" || mapped === "BNB" || mapped === "PEPEW") return mapped;
    return null;
}

function readNestedField(entry: any, key: string): any {
    if (!key.includes(".")) return entry?.[key];
    const parts = key.split(".");
    let cursor = entry;
    for (const part of parts) {
        if (cursor === null || cursor === undefined) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

function pickNumeric(entry: any, keys: string[]): number | null {
    for (const key of keys) {
        const raw = readNestedField(entry, key);
        if (raw === null || raw === undefined || raw === "") continue;
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function extractList(payload: any, listPaths: string[][]): any[] {
    for (const path of listPaths) {
        const value = path.length ? readPath(payload, path) : payload;
        if (Array.isArray(value)) return value;
    }

    if (payload?.balances && typeof payload.balances === "object") {
        return Object.entries(payload.balances).map(([asset, v]) => ({ asset, available: v }));
    }
    if (payload?.data?.balances && typeof payload.data.balances === "object") {
        return Object.entries(payload.data.balances).map(([asset, v]) => ({ asset, available: v }));
    }

    return [];
}

export function normalizeBalance(exchangeId: ExchangeId, rawBalanceResponse: any, options: NormalizeOptions): BalanceSnapshot {
    const spec = getExchangeSpec(exchangeId);
    const list = extractList(rawBalanceResponse, spec.balancePolicy.listPaths);
    const assets: Record<AssetCode, { free: number; locked: number; total: number }> = {
        USDT: { free: 0, locked: 0, total: 0 },
        BNB: { free: 0, locked: 0, total: 0 },
        PEPEW: { free: 0, locked: 0, total: 0 },
    };

    for (const row of list) {
        let rawAsset = "";
        for (const key of spec.balancePolicy.fieldMapping.assetKeys) {
            const v = readNestedField(row, key);
            if (v !== null && v !== undefined && String(v).trim() !== "") {
                rawAsset = String(v);
                break;
            }
        }
        if (!rawAsset) continue;

        const asset = normalizeAsset(rawAsset, spec.balancePolicy.assetAliases);
        if (!asset) continue;

        const free = pickNumeric(row, spec.balancePolicy.fieldMapping.freeKeys);
        const locked = pickNumeric(row, spec.balancePolicy.fieldMapping.lockedKeys);
        const total = pickNumeric(row, spec.balancePolicy.fieldMapping.totalKeys);

        if (free === null && total === null) {
            const snippet = stableStringify({ asset: rawAsset, row });
            throw new RegistryError(
                "BALANCE_PARSE_FAILED",
                `BALANCE_PARSE_FAILED: exchangeId=${exchangeId} asset=${rawAsset} missing free/total row=${snippet.slice(0, 320)}`
            );
        }

        const resolvedFree = free ?? Math.max((total ?? 0) - (locked ?? 0), 0);
        const resolvedLocked = locked ?? Math.max((total ?? 0) - resolvedFree, 0);
        const resolvedTotal = total ?? resolvedFree + resolvedLocked;

        assets[asset] = {
            free: resolvedFree,
            locked: resolvedLocked,
            total: resolvedTotal,
        };
    }

    return {
        exchangeId,
        ts: options.ts ?? Date.now(),
        stalenessMs: options.stalenessMs,
        source: options.source,
        rawHash: hashRaw(rawBalanceResponse),
        assets,
    };
}
