export function renderMenu(title: string, subtitle?: string): string {
    const header = (title || "Menu").trim();
    const line = "--------------------";
    const detail = (subtitle || "").trim();
    if (!detail) return `${header}\n${line}`;
    return `${header}\n${line}\n${detail}`;
}
