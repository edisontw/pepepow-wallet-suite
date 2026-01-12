import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

export default function Pay() {
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
          setInfo({ error: true, message: j?.error || "Link invalid." });
          return;
        }
        setInfo(j);
      } catch {
        if (active) setInfo({ error: true, message: "Unable to reach API." });
      }
    };

    void run();
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <AppLayout>
      <PageCard title="Payment">
        <div className="card">
          {info?.error ? <p>{info?.message || "Link invalid."}</p> :
            info ? (
              <div>
                <p>Address: <code>{info.address}</code></p>
                <p>Amount: <strong>{info.amount}</strong> PEPEW</p>
                <p>Memo: {info.memo || '-'}</p>
              </div>
            ) : <p>Loading...</p>
          }
        </div>
      </PageCard>
    </AppLayout>
  );
}
