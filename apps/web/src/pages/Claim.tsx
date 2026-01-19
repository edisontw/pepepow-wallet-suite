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
                    setError(res.error || "Failed to fetch request");
                }
            } catch (e) {
                if (active) setError("Network error");
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
                setError(res.error || "Claim failed");
            }
        } catch (e) {
            setError("Network error");
        } finally {
            setClaiming(false);
        }
    };

    if (!requestId) {
        return (
            <AppLayout>
                <PageCard title={t("claim.title") || "Claim Payment"}>
                    <div className="card">
                        <p className="error">{t("claim.missingId") || "Missing Request ID"}</p>
                    </div>
                </PageCard>
            </AppLayout>
        );
    }

    return (
        <AppLayout>
            <PageCard title={t("claim.title") || "Claim Payment"}>
                <div className="card">
                    {loading && <p>{t("loading")}</p>}
                    {error && <p className="error">{error}</p>}
                    {success && <p className="success">{t("claim.success") || "Payment claimed successfully!"}</p>}

                    {request && !success && (
                        <>
                            <div className="row" style={{ marginBottom: 16 }}>
                                <div>
                                    <div className="muted">{t("claim.status") || "Status"}</div>
                                    <div className="summary-value" style={{ textTransform: 'capitalize' }}>{request.status}</div>
                                </div>
                                {request.expiresAt && (
                                    <div style={{ marginLeft: 20 }}>
                                        <div className="muted">{t("claim.expires") || "Expires"}</div>
                                        <div className="summary-value">{new Date(request.expiresAt).toLocaleString()}</div>
                                    </div>
                                )}
                            </div>

                            {request.status === 'pending' ? (
                                <>
                                    <label className="field-label">{t("claim.yourAddress") || "Your Receiving Address"}</label>
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
                                            {claiming ? "..." : t("claim.button") || "Claim PEPEW"}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <p>{t("claim.alreadyProcessed") || "This request has already been processed or expired."}</p>
                            )}
                        </>
                    )}
                </div>
            </PageCard>
        </AppLayout>
    );
}
