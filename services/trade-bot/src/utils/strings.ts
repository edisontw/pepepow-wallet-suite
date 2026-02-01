export function safeText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message || String(value);
    if (value === null || value === undefined) return String(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "[object]";
        }
    }
    return String(value);
}

export function safeLower(value: unknown): string {
    return safeText(value).toLowerCase();
}

export function truncateText(value: string, maxLength = 200): string {
    if (value.length <= maxLength) return value;
    return value.slice(0, Math.max(0, maxLength - 3)) + "...";
}
