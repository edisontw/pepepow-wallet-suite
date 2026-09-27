import { addressToScript, PEPEPOW } from "@pepepow/wallet-core";
import { getPendingSpendTotal } from "./pending";
import { pepewLightClient } from "./pepewLightClient";

export interface Utxo {
    txid: string;
    vout: number;
    valueSats: number;
    scriptHex: string;
    confirmations?: number;
    invalid?: boolean;
}

export type WalletState = {
    address: string;
    utxos: Utxo[];
    balanceSats: number | null;
    utxoSumSats: number | null;
    pendingSpendSats: number;
    optimisticDeductionSats: number;
    lastUpdate: number;
    error: string | null;
    status: "idle" | "loading" | "ok" | "error";
    rawUtxoSumStatus: number | null;
    rawUtxoSumLastRequestUrl: string | null;
    rawUtxoSumError: string | null;
};

export type WalletFetchOptions = {
    fresh?: boolean;
    includeBalance?: boolean;
};

type Listener = (state: WalletState) => void;

class WalletStore {
    private state: WalletState = {
        address: localStorage.getItem("pepew_address") || "",
        utxos: [],
        balanceSats: null,
        utxoSumSats: null,
        pendingSpendSats: 0,
        optimisticDeductionSats: 0,
        lastUpdate: 0,
        error: null,
        status: "idle",
        rawUtxoSumStatus: null,
        rawUtxoSumLastRequestUrl: null,
        rawUtxoSumError: null,
    };

    private listeners: Set<Listener> = new Set();
    private requestSeq = 0;
    private spentOutpoints: Record<string, number> = {};
    private SPENT_OUTPOINT_TTL_MS = 10 * 60 * 1000;

    constructor() {
        this.updatePending();
        if (this.state.address) {
            setTimeout(() => this.fetch(), 0);
        }
    }

    getState() {
        return { ...this.state };
    }

    getDisplayBalance() {
        const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
        const chainBalance = this.state.balanceSats ?? this.state.utxoSumSats;
        if (chainBalance === null) return null;

        const balance = Math.max(chainBalance - this.state.optimisticDeductionSats, 0);
        if (debug) {
            console.log("[WalletStore] getDisplayBalance Debug:", {
                lightBalanceSats: this.state.balanceSats,
                lightUtxoSumSats: this.state.utxoSumSats,
                optimisticDeductionSats: this.state.optimisticDeductionSats,
                result: balance,
                address: this.state.address,
                pendingSpendsTotalSats: this.state.pendingSpendSats
            });
        }
        return balance;
    }

    applyOptimistic(amountSats: number) {
        this.state.optimisticDeductionSats += amountSats;
        this.notify();
    }

    subscribe(l: Listener) {
        this.listeners.add(l);
        return () => { this.listeners.delete(l); };
    }

    private notify() {
        this.listeners.forEach((l) => l(this.getState()));
    }

    setAddress(addr: string) {
        if (this.state.address === addr) return;
        this.state.address = addr;
        this.state.utxos = [];
        this.state.balanceSats = null;
        this.state.utxoSumSats = null;
        this.updatePending();
        this.notify();
        if (addr) void this.fetch();
    }

    updatePending() {
        if (!this.state.address) {
            this.state.pendingSpendSats = 0;
        } else {
            const { totalSats } = getPendingSpendTotal(this.state.address);
            this.state.pendingSpendSats = totalSats;
        }
        this.notify();
    }

    markSpentOutpoints(outpoints: string[]) {
        const now = Date.now();
        outpoints.filter(Boolean).forEach((key) => {
            this.spentOutpoints[key] = now;
        });
        this.filterUtxos();
    }

    private filterUtxos() {
        const now = Date.now();
        const filtered = this.state.utxos.filter((u) => {
            const key = `${u.txid}:${u.vout}`;
            const ts = this.spentOutpoints[key];
            if (!ts) return true;
            if (now - ts > this.SPENT_OUTPOINT_TTL_MS) {
                delete this.spentOutpoints[key];
                return true;
            }
            return false;
        });
        if (filtered.length !== this.state.utxos.length) {
            this.state.utxos = filtered;
            this.state.utxoSumSats = filtered.reduce((s, u) => s + u.valueSats, 0);
        }
    }

    async fetch(options: WalletFetchOptions = {}) {
        const addr = this.state.address.trim();
        if (!addr) return;

        const seq = ++this.requestSeq;
        const includeBalance = options.includeBalance !== false;

        this.state.status = "loading";
        this.state.error = null;
        this.state.rawUtxoSumLastRequestUrl = `/api/wallet/utxo/${encodeURIComponent(addr)}${options.fresh ? "?fresh=1" : ""}`;
        this.state.rawUtxoSumError = null;
        this.notify();

        try {
            const [utxoData, addressData] = await Promise.all([
                pepewLightClient.getUtxo(addr, { fresh: options.fresh }),
                includeBalance
                    ? pepewLightClient.getAddress(addr, { fresh: options.fresh })
                    : Promise.resolve(null),
            ]);

            if (seq !== this.requestSeq || this.state.address.trim() !== addr) return;

            const scriptHex = addressToScript(addr, PEPEPOW).script.toString("hex");
            const rawUtxos = Array.isArray(utxoData?.utxos) ? utxoData.utxos : [];
            const mapped: Utxo[] = rawUtxos.map((u) => {
                const txid = String(u?.txid || "");
                const vout = Number(u?.vout);
                const valueSats = Math.round(Number(u?.value ?? 0));
                const height = Number(u?.height ?? 0);
                const utxo: Utxo = {
                    txid,
                    vout,
                    valueSats,
                    scriptHex,
                    confirmations: Number.isFinite(height) ? (height > 0 ? 1 : 0) : undefined,
                };
                if (!utxo.txid || !Number.isInteger(utxo.vout) || utxo.vout < 0 || !Number.isFinite(utxo.valueSats) || utxo.valueSats <= 0 || !utxo.scriptHex) {
                    utxo.invalid = true;
                }
                return utxo;
            });

            const validMapped = mapped.filter((u) => !u.invalid);
            const oldUtxoSum = this.state.utxoSumSats;
            const newUtxoSum = validMapped.reduce((sum, u) => sum + u.valueSats, 0);

            let nextBalance = this.state.balanceSats;
            if (addressData) {
                const confirmed = Number(addressData?.balance?.confirmed ?? 0);
                const unconfirmed = Number(addressData?.balance?.unconfirmed ?? 0);
                if (!Number.isFinite(confirmed) || !Number.isFinite(unconfirmed)) {
                    throw new Error("Invalid PEPEW Light API balance response");
                }
                nextBalance = Math.max(Math.round(confirmed + unconfirmed), 0);
            }

            this.state.utxos = validMapped;
            this.state.utxoSumSats = newUtxoSum;
            this.state.balanceSats = nextBalance;
            this.state.rawUtxoSumStatus = 200;
            this.state.status = "ok";
            this.state.lastUpdate = Date.now();

            if (oldUtxoSum !== null && newUtxoSum !== oldUtxoSum) {
                this.state.optimisticDeductionSats = 0;
            }

            const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
            if (debug) {
                console.log("[WalletStore] Light API fetch success:", {
                    address: addr,
                    balanceSats: this.state.balanceSats,
                    utxoCount: validMapped.length,
                    utxoSumSats: newUtxoSum,
                    filteredInvalid: mapped.length - validMapped.length,
                    fresh: Boolean(options.fresh),
                });
            }

            this.filterUtxos();
            this.notify();
        } catch (e: any) {
            if (seq !== this.requestSeq || this.state.address.trim() !== addr) return;
            this.state.status = "error";
            const errDetail = e?.message || "PEPEW Light API request failed";
            this.state.error = errDetail;
            this.state.rawUtxoSumError = errDetail;
            this.state.rawUtxoSumStatus = typeof e?.status === "number" ? e.status : null;
            this.notify();
        }
    }

    scheduleRefresh(delays = [0, 2000, 5000]) {
        const baseline = this.state.utxoSumSats;
        delays.forEach((delay) => {
            setTimeout(() => {
                if (delay !== 0 && this.state.utxoSumSats !== baseline) return;
                void this.fetch({ fresh: delay === 0 });
                this.updatePending();
            }, delay);
        });
    }
}

export const walletStore = new WalletStore();
