import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiFetch, setAuthToken, upsertProfile } from "../lib/api";
import { authenticateMiniApp, type MiniAuthFailure } from "../lib/miniAuth";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

export default function Mini() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const debugEnabled = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("debug") === "1";
  const [status, setStatus] = useState<"authorizing" | "openInTelegram" | MiniAuthFailure | "loggedIn">("authorizing");
  const [retryCount, setRetryCount] = useState(0);
  const [debugInfo, setDebugInfo] = useState<{
    hasTelegram: boolean;
    initDataLen: number;
    userId: number | null;
    platform: string | null;
  } | null>(null);

  const closeOrReload = () => {
    const telegramWebApp = (window as any)?.Telegram?.WebApp;
    if (typeof telegramWebApp?.close === "function") {
      telegramWebApp.close();
      return;
    }
    window.location.reload();
  };

  useEffect(() => {
    let active = true;
    setStatus("authorizing");

    const run = async () => {
      const updateDebug = () => {
        if (!debugEnabled || !active) return;
        const telegramWebApp = (window as any)?.Telegram?.WebApp;
        setDebugInfo({
          hasTelegram: Boolean(telegramWebApp),
          initDataLen: telegramWebApp?.initData?.length ?? 0,
          userId: telegramWebApp?.initDataUnsafe?.user?.id ?? null,
          platform: telegramWebApp?.platform ?? null,
        });
      };

      updateDebug();
      const telegramWebApp = (window as any)?.Telegram?.WebApp;
      const isTelegram = Boolean(telegramWebApp);
      if (!isTelegram) {
        if (active) {
          setStatus("openInTelegram");
        }
        return;
      }

      try {
        telegramWebApp?.ready?.();
        const initData = telegramWebApp?.initData || "";
        updateDebug();
        if (!initData) {
          if (active) setStatus("missingInitData");
          return;
        }
        const result = await authenticateMiniApp({
          initData,
          startParam: telegramWebApp.initDataUnsafe?.start_param,
          username: telegramWebApp.initDataUnsafe?.user?.username,
          request: (data, signal) => apiFetch("/auth/telegram", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ initData: data }),
            signal,
          }),
          saveToken: setAuthToken,
          navigate: (destination) => {
            if (active) {
              setStatus("loggedIn");
              navigate(destination);
            }
          },
          updateProfile: (username, signal) => upsertProfile(username, { signal }),
        });
        if (result.ok === false) {
          if (active) setStatus(result.reason);
          return;
        }
      } catch {
        if (active) {
          setStatus("authFailed");
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [retryCount]);

  return (
    <AppLayout compact>
      <PageCard title={t("mini.title")}>
        <div className="card">
          <p style={{ fontWeight: 'bold', color: status === 'openInTelegram' ? '#ff4444' : 'inherit' }}>
            {t(`mini.${status}`)}
          </p>
          {status === "openInTelegram" && <div style={{ fontSize: '0.8em', marginTop: 4 }}>{t("mini.routeLoaded")}</div>}
          {(status === "missingInitData" || status === "invalidInitData") && (
            <div style={{ marginTop: 8 }}>
              <button className="btn secondary" onClick={() => setRetryCount((count) => count + 1)}>{t("mini.retry")}</button>
              <button className="btn ghost" onClick={closeOrReload}>{t("mini.reopen")}</button>
            </div>
          )}
          {(status === "authNetworkFailed" || status === "authTimedOut" || status === "authFailed") && (
            <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => setRetryCount((count) => count + 1)}>{t("mini.retry")}</button>
          )}
          {(status === "authStorageFailed" || status === "navigationFailed") && (
            <button className="btn ghost" style={{ marginTop: 8 }} onClick={closeOrReload}>{t("mini.reopen")}</button>
          )}
          {debugEnabled && (
            <div className="muted" style={{ marginTop: 12 }}>
              <div>{t("mini.debugLabel")}</div>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                {JSON.stringify({
                  hasTelegram: debugInfo?.hasTelegram ?? false,
                  initDataLen: debugInfo?.initDataLen ?? 0,
                  userId: debugInfo?.userId ?? null,
                  platform: debugInfo?.platform ?? null,
                }, null, 2)}
              </pre>
              {debugInfo?.hasTelegram && (debugInfo?.initDataLen ?? 0) === 0 && (
                <div style={{ marginTop: 8 }}>
                  {t("mini.initDataHint")}
                </div>
              )}
            </div>
          )}
        </div>
      </PageCard>
    </AppLayout>
  );
}
