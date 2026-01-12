import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch, setAuthToken } from "../lib/api";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

export default function Mini() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"authorizing" | "openInTelegram" | "missingInitData" | "authFailed" | "loggedIn">("authorizing");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const run = async () => {
      const telegramWebApp = (window as any)?.Telegram?.WebApp;
      if (!telegramWebApp) {
        if (active) {
          setStatus("openInTelegram");
          setStatusDetail(null);
        }
        return;
      }

      try {
        const { default: WebApp } = await import("@twa-dev/sdk");
        WebApp.ready();
        const initData = WebApp.initData;
        if (!initData) {
          if (active) {
            setStatus("missingInitData");
            setStatusDetail(null);
          }
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
        if (active) {
          setToken(j.token);
          setStatus("loggedIn");
          setStatusDetail(null);
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
          <p>{statusDetail || t(`mini.${status}`)}</p>
          {token && <p className="muted" style={{ wordBreak: "break-all" }}>{t("mini.tokenReady")}</p>}
        </div>
      </PageCard>
    </AppLayout>
  );
}
