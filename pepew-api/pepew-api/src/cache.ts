type Entry<T> = { v: T; exp: number };
const store = new Map<string, Entry<any>>();

export function getCache<T>(k: string): T | undefined {
  const e = store.get(k);
  if (!e) return;
  if (Date.now() > e.exp) { store.delete(k); return; }
  return e.v as T;
}
export function setCache<T>(k: string, v: T, ttlMs: number) {
  store.set(k, { v, exp: Date.now() + ttlMs });
}
