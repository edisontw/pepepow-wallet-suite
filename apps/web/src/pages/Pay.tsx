import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

export default function Pay() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!token) return;
      try {
        const r = await apiFetch(`/api/paylink/verify?token=${encodeURIComponent(token)}`);
        const j = await r.json().catch(() => ({}));
        if (!active) return;
        if (!r.ok) {
          setInfo({ error: true, message: j?.error || t("pay.linkInvalid") });
          return;
        }
        setInfo(j);
      } catch {
        if (active) setInfo({ error: true, message: t("pay.apiUnreachable") });
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <AppLayout>
      <PageCard title={t("pay.title")}>
        <div className="card">
          {info?.error ? <p>{info?.message || t("pay.linkInvalid")}</p> :
            info ? (
              <div>
                <p>{t("pay.addressLabel")}: <code>{info.address}</code></p>
                <p>{t("pay.amountLabel")}: <strong>{info.amount}</strong> PEPEW</p>
                <p>{t("pay.memoLabel")}: {info.memo || '-'}</p>
              </div>
            ) : <p>{t("loading")}</p>
          }
        </div>
      </PageCard>
    </AppLayout>
  );
}
