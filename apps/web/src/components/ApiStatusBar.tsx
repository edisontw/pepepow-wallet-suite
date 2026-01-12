import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch, API_BASE } from "../lib/api";

type ApiStatus = "checking" | "ok" | "fail";

export default function ApiStatusBar() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const r = await apiFetch("/wallet/healthz");
        const j = await r.json().catch(() => ({}));
        if (!active) return;
        if (r.ok) {
          setStatus("ok");
          console.info("[api] base", API_BASE, "healthz", j);
        } else {
          setStatus("fail");
          console.warn("[api] healthz failed", r.status, j);
        }
      } catch (err) {
        if (active) setStatus("fail");
        console.error("[api] healthz failed", err);
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, []);

  const statusLabel =
    status === "ok" ? t("api.ok") : status === "fail" ? t("api.fail") : t("api.checking");

  return (
    <div className="status-bar">
      <span>
        {t("api.base")}: <code>{API_BASE}</code>
      </span>
      <span>
        {t("api.status")}: <strong>{statusLabel}</strong>
      </span>
    </div>
  );
}
