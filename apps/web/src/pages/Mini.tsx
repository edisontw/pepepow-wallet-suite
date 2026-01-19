import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiFetch, setAuthToken, upsertProfile } from "../lib/api";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

const BUILD_ID = "2026-01-15 16:48"; // Manual timestamp

export default function Mini() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const debugEnabled = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("debug") === "1";
  const [status, setStatus] = useState<"authorizing" | "openInTelegram" | "missingInitData" | "authFailed" | "loggedIn">("authorizing");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<{
    hasTelegram: boolean;
    initDataLen: number;
    userId: number | null;
    platform: string | null;
    buildId: string;
    userAgent: string;
    href: string;
  } | null>(null);

  useEffect(() => {
    let active = true;

    const run = async () => {
      const updateDebug = () => {
        if (!debugEnabled || !active) return;
        const telegramWebApp = (window as any)?.Telegram?.WebApp;
        setDebugInfo({
          hasTelegram: Boolean(telegramWebApp),
          initDataLen: telegramWebApp?.initData?.length ?? 0,
          userId: telegramWebApp?.initDataUnsafe?.user?.id ?? null,
          platform: telegramWebApp?.platform ?? null,
          buildId: BUILD_ID,
          userAgent: navigator.userAgent,
          href: window.location.href,
        });
      };

      updateDebug();
      const telegramWebApp = (window as any)?.Telegram?.WebApp;
      const isTelegram = Boolean(telegramWebApp);
      if (!isTelegram) {
        if (active) {
          setStatus("openInTelegram");
          setStatusDetail(null);
        }
        return;
      }

      try {
        telegramWebApp?.ready?.();
        const { default: WebApp } = await import("@twa-dev/sdk");
        WebApp.ready();
        const initData = WebApp.initData;
        updateDebug();
        if (!initData) {
          return;
        }
        const r = await apiFetch("/auth/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.token) {
          if (active) {
            setStatus("authFailed");
            setStatusDetail(j?.error || null);
          }
          return;
        }
        setAuthToken(j.token);
        try {
          const user = telegramWebApp.initDataUnsafe?.user;
          await upsertProfile(user?.username);
        } catch (e) {
          console.error("Failed to upsert profile", e);
        }
        if (active) {
          setToken(j.token);
          setStatus("loggedIn");
          setStatusDetail(null);

          const startParam = telegramWebApp.initDataUnsafe?.start_param;
          if (startParam) {
            if (startParam.startsWith("claim_")) {
              navigate(`/claim?requestId=${startParam.replace("claim_", "")}`);
              return;
            }
            if (startParam.startsWith("send_to_")) {
              navigate(`/send?to=${startParam.replace("send_to_", "")}`);
              return;
            }
          }
          navigate("/");
        }
      } catch (e) {
        if (active) {
          setStatus("authFailed");
          setStatusDetail(null);
        }
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, []);

  return (
    <AppLayout compact>
      <PageCard title={t("mini.title")}>
        <div className="card">
          <p style={{ fontWeight: 'bold', color: status === 'openInTelegram' ? '#ff4444' : 'inherit' }}>
            {statusDetail || t(`mini.${status}`)}
          </p>
          {status === "openInTelegram" && <div style={{ fontSize: '0.8em', marginTop: 4 }}>{t("mini.routeLoaded")}</div>}
          {token && <p className="muted" style={{ wordBreak: "break-all" }}>{t("mini.tokenReady")}</p>}
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
