import fetch from "node-fetch";

export async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json();
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

export function parseNumber(value: any): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }
    return null;
}

export function truncateRaw(obj: any, maxLen = 800): string {
    const str = JSON.stringify(obj);
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + "...[truncated]";
}
