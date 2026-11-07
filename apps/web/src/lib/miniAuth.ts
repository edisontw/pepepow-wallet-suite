export type MiniAuthFailure =
  | "missingInitData"
  | "invalidInitData"
  | "authFailed"
  | "authNetworkFailed"
  | "authTimedOut"
  | "authStorageFailed"
  | "navigationFailed";

export type MiniAuthResult =
  | { ok: true; destination: string }
  | { ok: false; reason: MiniAuthFailure };

type AuthResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type MiniAuthOptions = {
  initData: string;
  startParam?: string;
  username?: string;
  timeoutMs?: number;
  request: (initData: string, signal: AbortSignal) => Promise<AuthResponse>;
  saveToken: (token: string) => void;
  navigate: (destination: string) => void;
  updateProfile?: (username?: string, signal?: AbortSignal) => Promise<unknown>;
};

export function getMiniDestination(startParam?: string) {
  if (startParam?.startsWith("claim_")) {
    const requestId = startParam.slice("claim_".length);
    return `/claim?${new URLSearchParams({ requestId }).toString()}`;
  }
  if (startParam?.startsWith("send_to_")) {
    const recipient = startParam.slice("send_to_".length);
    return `/send?${new URLSearchParams({ to: recipient }).toString()}`;
  }
  return "/";
}

function classifyAuthFailure(status: number, error: unknown): MiniAuthFailure {
  const message = typeof error === "string" ? error.toLowerCase() : "";
  if (status === 400 || status === 401 || /invalid|expired|missing initdata/.test(message)) {
    return "invalidInitData";
  }
  return "authFailed";
}

export async function authenticateMiniApp(options: MiniAuthOptions): Promise<MiniAuthResult> {
  const initData = options.initData.trim();
  if (!initData) return { ok: false, reason: "missingInitData" };

  const timeoutMs = options.timeoutMs ?? 12_000;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("auth_timeout"));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      options.request(initData, controller.signal),
      timeout,
    ]);
    const payload = await response.json().catch(() => null) as { token?: unknown; error?: unknown } | null;
    if (!response.ok || typeof payload?.token !== "string" || !payload.token) {
      return {
        ok: false,
        reason: classifyAuthFailure(response.status, payload?.error),
      };
    }

    try {
      options.saveToken(payload.token);
    } catch {
      return { ok: false, reason: "authStorageFailed" };
    }

    const destination = getMiniDestination(options.startParam);
    try {
      options.navigate(destination);
    } catch {
      return { ok: false, reason: "navigationFailed" };
    }

    if (options.updateProfile) {
      const profileController = new AbortController();
      const profileTimeout = setTimeout(() => profileController.abort(), 8_000);
      void Promise.resolve().then(() => options.updateProfile!(options.username, profileController.signal))
        .catch(() => undefined)
        .finally(() => clearTimeout(profileTimeout));
    }

    return { ok: true, destination };
  } catch {
    return { ok: false, reason: timedOut ? "authTimedOut" : "authNetworkFailed" };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
