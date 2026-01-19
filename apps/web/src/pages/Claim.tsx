import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { getPaymentRequest, claimPaymentRequest } from "../lib/api";
import AppLayout from "../components/layout/AppLayout";
import PageCard from "../components/layout/PageCard";

export default function Claim() {
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const requestId = searchParams.get("requestId");
    const [address, setAddress] = useState(localStorage.getItem("pepew_address") || "");
    const [request, setRequest] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        if (!requestId) return;
        let active = true;

        const run = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await getPaymentRequest(requestId);
                if (!active) return;
                if (res.ok) {
                    setRequest(res);
                } else {
                    setError(res.error || t("claim.fetchFailed"));
                }
            } catch (e) {
                if (active) setError(t("errors.networkError"));
            } finally {
                if (active) setLoading(false);
            }
        };

        void run();
        return () => { active = false; };
    }, [requestId]);

    const handleClaim = async () => {
        if (!requestId || !address) return;
        setClaiming(true);
        setError(null);
        try {
            const res = await claimPaymentRequest(requestId, address);
            if (res.ok) {
                setSuccess(true);
            } else {
                setError(res.error || t("claim.failed"));
            }
        } catch (e) {
            setError(t("errors.networkError"));
        } finally {
            setClaiming(false);
        }
    };

    if (!requestId) {
        return (
            <AppLayout>
                <PageCard title={t("claim.title")}>
                    <div className="card">
                        <p className="error">{t("claim.missingId")}</p>
                    </div>
                </PageCard>
            </AppLayout>
        );
    }

    return (
        <AppLayout>
            <PageCard title={t("claim.title")}>
                <div className="card">
                    {loading && <p>{t("loading")}</p>}
                    {error && <p className="error">{error}</p>}
                    {success && <p className="success">{t("claim.success")}</p>}

                    {request && !success && (
                        <>
                            <div className="row" style={{ marginBottom: 16 }}>
                                <div>
                                    <div className="muted">{t("claim.status")}</div>
                                    <div className="summary-value" style={{ textTransform: 'capitalize' }}>{request.status}</div>
                                </div>
                                {request.expiresAt && (
                                    <div style={{ marginLeft: 20 }}>
                                        <div className="muted">{t("claim.expires")}</div>
                                        <div className="summary-value">{new Date(request.expiresAt).toLocaleString()}</div>
                                    </div>
                                )}
                            </div>

                            {request.status === 'pending' ? (
                                <>
                                    <label className="field-label">{t("claim.yourAddress")}</label>
                                    <input
                                        className="input"
                                        value={address}
                                        onChange={e => setAddress(e.target.value)}
                                        placeholder="PMXw..."
                                    />
                                    <div style={{ marginTop: 16 }}>
                                        <button
                                            className="btn"
                                            onClick={handleClaim}
                                            disabled={claiming || !address}
                                        >
                                            {claiming ? "..." : t("claim.button")}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <p>{t("claim.alreadyProcessed")}</p>
                            )}
                        </>
                    )}
                </div>
            </PageCard>
        </AppLayout>
    );
}
