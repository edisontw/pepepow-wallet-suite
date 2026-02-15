import { apiFetch, API_ENDPOINTS, withAddress, getApiUrl } from "./api";
import { getPendingSpendTotal } from "./pending";

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
    utxoSumSats: number | null;
    pendingSpendSats: number;
    optimisticDeductionSats: number; // Added for MVP
    lastUpdate: number;
    error: string | null;
    status: "idle" | "loading" | "ok" | "error";
    rawUtxoSumStatus: number | null;
    rawUtxoSumLastRequestUrl: string | null;
    rawUtxoSumError: string | null;
};

type Listener = (state: WalletState) => void;

class WalletStore {
    private state: WalletState = {
        address: localStorage.getItem("pepew_address") || "",
        utxos: [],
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
    private abortController: AbortController | null = null;
    private spentOutpoints: Record<string, number> = {};
    private SPENT_OUTPOINT_TTL_MS = 10 * 60 * 1000;

    constructor() {
        this.updatePending();
        // Trigger initial fetch if address exists (fixes Web balance=0 on page refresh)
        if (this.state.address) {
            // Use setTimeout to avoid blocking constructor
            setTimeout(() => this.fetch(), 0);
        }
    }

    getState() {
        return { ...this.state };
    }

    getDisplayBalance() {
        const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
        if (this.state.utxoSumSats === null) return null;

        // MVP: Balance is utxoSumSats - optimisticDeductionSats
        // We IGNORE pendingSpendSats here because it's only for "displaying a list"
        const balance = Math.max(this.state.utxoSumSats - this.state.optimisticDeductionSats, 0);

        if (debug) {
            console.log("[WalletStore] getDisplayBalance Debug:", {
                oldSpendableSats: this.state.utxoSumSats, // rename for debug naming consistency
                apiUtxoSumSats: this.state.utxoSumSats,
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
        this.state.utxoSumSats = null;
        this.updatePending();
        this.notify();
        if (addr) this.fetch();
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
        // Disabled for now as per MVP strategy to avoid complexity
        // this.filterUtxos();
        // this.updatePending();
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
            this.notify();
        }
    }

    async fetch() {
        const addr = this.state.address;
        if (!addr) return;

        this.abortController?.abort();
        this.abortController = new AbortController();

        this.state.status = "loading";
        this.state.error = null;
        this.notify();

        try {
            const path = withAddress(API_ENDPOINTS.wallet.utxos, addr);
            const url = getApiUrl(path);
            this.state.rawUtxoSumLastRequestUrl = url;
            this.state.rawUtxoSumError = null;

            const r = await apiFetch(path, { signal: this.abortController.signal });
            this.state.rawUtxoSumStatus = r.status;

            const data = await r.json().catch(() => null);

            if (!r.ok) {
                this.state.status = "error";
                const errDetail = data?.error || `HTTP ${r.status}`;
                this.state.error = errDetail;
                this.state.rawUtxoSumError = errDetail;
                this.notify();
                return;
            }

            const rawUtxos = Array.isArray(data) ? data : Array.isArray(data?.utxos) ? data.utxos : [];
            const mapped: Utxo[] = rawUtxos.map((u: any) => {
                const scriptHex = String(
                    u.scriptHex ||
                    u.scriptPubKey ||
                    u.script_pubkey ||
                    u.script ||
                    u.pkScript ||
                    (u.scriptPubKey?.hex) ||
                    u.hex ||
                    ""
                ).trim();

                const txid = u.txid || u.txId || u.tx;
                const vout = u.vout ?? u.n ?? u.outputIndex ?? u.output_index;
                const valueSats = u.satoshis ?? u.amount ?? u.value ?? 0;
                const confirmationsRaw = u.confirmations ?? u.confirmation ?? u.confirmed ?? u.confirm;
                const confirmations = Number(confirmationsRaw);

                const utxo: Utxo = {
                    txid: String(txid || ""),
                    vout: Number(vout),
                    valueSats: Math.round(Number(valueSats)),
                    scriptHex: scriptHex,
                    confirmations: Number.isFinite(confirmations) ? confirmations : undefined,
                };

                if (!utxo.txid || !Number.isFinite(utxo.vout) || !Number.isFinite(utxo.valueSats) || !utxo.scriptHex) {
                    utxo.invalid = true;
                }
                return utxo;
            });

            const validMapped = mapped.filter(u => !u.invalid);

            const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
            if (debug && validMapped.length > 0) {
                console.log("[WalletStore] Sample UTXO:", validMapped[0]);
                if (mapped.length > validMapped.length) {
                    console.warn("[WalletStore] Filtered out invalid UTXOs:", mapped.length - validMapped.length);
                }
            }

            const oldSum = this.state.utxoSumSats;
            const newSum = validMapped.reduce((s, u) => s + u.valueSats, 0);

            this.state.utxos = validMapped;
            this.state.utxoSumSats = newSum;
            this.state.status = "ok";
            this.state.lastUpdate = Date.now();

            // Clear optimistic deduction if the UTXO sum has changed (implies API updated)
            if (oldSum !== null && newSum !== oldSum) {
                this.state.optimisticDeductionSats = 0;
            }

            if (debug) {
                console.log("[WalletStore] fetch success:", {
                    count: validMapped.length,
                    sumSats: newSum,
                    optimisticRemaining: this.state.optimisticDeductionSats
                });
            }

            // this.filterUtxos(); // Disabled for MVP
            this.notify();
        } catch (e: any) {
            if (e.name === "AbortError") return;
            this.state.status = "error";
            const errDetail = e.message || "Network error";
            this.state.error = errDetail;
            this.state.rawUtxoSumError = errDetail;
            this.notify();
        }
    }

    scheduleRefresh(delays = [0, 2000, 5000]) {
        const baseline = this.state.utxoSumSats;
        delays.forEach((delay) => {
            setTimeout(() => {
                // If we already detected a change, skip subsequent polls (optional)
                if (delay !== 0 && this.state.utxoSumSats !== baseline) return;
                this.fetch();
                this.updatePending();
            }, delay);
        });
    }
}

export const walletStore = new WalletStore();
