export type WakeLockSentinelLike = {
  released?: boolean;
  release?: () => Promise<void>;
};

export async function requestWakeLock(): Promise<WakeLockSentinelLike | null> {
  if (typeof window === "undefined") return null;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return null;
  const nav = navigator as any;
  const wakeLock = nav?.wakeLock;
  if (!wakeLock || typeof wakeLock.request !== "function") return null;
  try {
    const sentinel = await wakeLock.request("screen");
    return sentinel ?? null;
  } catch {
    return null;
  }
}

export async function releaseWakeLock(sentinel: WakeLockSentinelLike | null): Promise<void> {
  if (!sentinel || typeof sentinel.release !== "function") return;
  if (sentinel.released) return;
  try {
    await sentinel.release();
  } catch {
    // best-effort only
  }
}
