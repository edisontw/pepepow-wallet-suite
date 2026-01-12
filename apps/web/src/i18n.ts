import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export type Lang = "en" | "zh-TW";
export const LANG_STORAGE_KEY = "lang";
const DEFAULT_LANG: Lang = "en";

const normalizeLang = (value?: string | null): Lang => {
  if (!value) return DEFAULT_LANG;
  const lowered = value.toLowerCase();
  if (lowered.startsWith("zh")) return "zh-TW";
  return "en";
};

const resources = {
  "zh-TW": {
    translation: {
      title: "PEPEPOW 錢包",
      address: "地址",
      balance: "餘額",
      receive: "收款",
      createPayLink: "建立收款連結",
      amount: "金額",
      memo: "備註",
      generate: "產生",
      copy: "複製",
      copied: "已複製",
      copyFailed: "複製失敗",
      show: "顯示",
      hide: "隱藏",
      dark: "深色",
      light: "淺色",
      nav: {
        home: "首頁",
        send: "發送",
        history: "紀錄",
        mini: "Mini"
      },
      lang: {
        en: "EN",
        zh: "中文"
      },
      api: {
        base: "API_BASE",
        status: "API 狀態",
        ok: "OK",
        fail: "FAIL",
        checking: "檢查中"
      },
      errors: {
        apiUnreachable: "無法連線 API"
      },
      home: {
        save: "儲存",
        localWallet: "本地錢包（助記詞只存前端）",
        createWallet: "產生助記詞並建立地址",
        useMnemonic: "使用助記詞導出地址",
        mnemonicPlaceholder: "助記詞 (可手動貼上)",
        amountLabel: "金額（PEPEW）",
        balanceFailed: "餘額查詢失敗",
        priceFailed: "價格查詢失敗",
        paylinkFailed: "收款連結建立失敗",
        walletCreateFailed: "建立錢包失敗",
        mnemonicMissing: "請先輸入助記詞",
        mnemonicInvalid: "助記詞無效或無法導出地址",
        usdLabel: "USD",
        usdNote: "CoinMarketCap",
        usdUnavailable: "CMC 無法取得",
        usdNetworkError: "網路錯誤",
        payUrlLabel: "URL"
      },
      send: {
        title: "發送（完整簽名流程）",
        yourAddress: "你的地址（找零將回此處）：",
        saveAddress: "儲存地址",
        mnemonicLabel: "助記詞（暫存於瀏覽器 localStorage）：",
        signingSource: "簽名金鑰來源：本地錢包（僅瀏覽器）",
        pathLabel: "Derivation Path（唯讀）：",
        pathNote: "（請改為 PEPEPOW 正式 path）",
        saveMnemonic: "儲存助記詞",
        toLabel: "收款地址",
        recentRecipients: "最近使用地址",
        noRecentRecipients: "尚無最近地址",
        amountLabel: "金額（PEPEW）",
        feeLabel: "手續費（PEPEW）",
        feeEstimate: "估算手續費（API）：",
        feeFallbackNotice: "估算失敗，使用預設手續費 {{fee}} PEPEW",
        feeSummary: "手續費",
        totalCost: "總成本",
        recipientReceives: "收款方實收",
        subtractFee: "從金額中扣除手續費",
        max: "最大值",
        sourceLabel: "來源",
        sending: "送出中...",
        submit: "Sign & broadcast",
        utxosTitle: "UTXOs（偵測到 {{count}} 筆）",
        broadcasted: "已廣播",
        errors: {
          mnemonicMissing: "請先輸入助記詞",
          amountInvalid: "請輸入正確的金額",
          amountTooLow: "最低轉帳金額為 {{min}} PEPEW",
          amountUnderFee: "金額必須大於手續費",
          feeInvalid: "請輸入正確的手續費",
          insufficientBalance: "餘額不足（含手續費）",
          insufficientUtxo: "可用 UTXO 不足",
          txRawFailed: "無法取得原始交易: {{txid}}",
          txRawNotFound: "找不到原始交易（節點可能未啟用 txindex 或交易不可查）：{{txid}}",
          broadcastFailed: "廣播失敗",
          utxoFailed: "UTXO 取得失敗",
          utxoApiError: "UTXO API 錯誤",
          feeEstimateFailed: "手續費估算失敗"
        }
      },
      history: {
        title: "紀錄",
        emptyAddress: "請先在首頁設定你的地址。",
        emptyTxs: "尚無交易紀錄。",
        goReceive: "前往收款",
        goSend: "前往發送",
        refresh: "Refresh",
        debugTitle: "API 除錯資訊",
        errorLabel: "錯誤",
        loading: "讀取中...",
        readFailed: "讀取失敗",
        confirmations: "確認數",
        utxosTitle: "UTXOs（進階）",
        utxosEmpty: "沒有可用的 UTXO"
      },
      mini: {
        title: "PEPEPOW Mini App",
        authorizing: "授權中...",
        openInTelegram: "請在 Telegram 內開啟 Mini App",
        missingInitData: "缺少 Telegram initData",
        authFailed: "授權失敗",
        loggedIn: "已登入，可使用迷你錢包功能。",
        tokenReady: "JWT 已取得"
      }
    }
  },
  en: {
    translation: {
      title: "PEPEPOW Wallet",
      address: "Address",
      balance: "Balance",
      receive: "Receive",
      createPayLink: "Create Payment Link",
      amount: "Amount",
      memo: "Memo",
      generate: "Generate",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed",
      show: "Show",
      hide: "Hide",
      dark: "Dark",
      light: "Light",
      nav: {
        home: "Home",
        send: "Send",
        history: "History",
        mini: "Mini"
      },
      lang: {
        en: "EN",
        zh: "中文"
      },
      api: {
        base: "API_BASE",
        status: "API Status",
        ok: "OK",
        fail: "FAIL",
        checking: "CHECKING"
      },
      errors: {
        apiUnreachable: "Unable to reach API"
      },
      home: {
        save: "Save",
        localWallet: "Local wallet (mnemonic stored in browser only)",
        createWallet: "Generate mnemonic & address",
        useMnemonic: "Import mnemonic to derive address",
        mnemonicPlaceholder: "Mnemonic (paste here)",
        amountLabel: "Amount (PEPEW)",
        balanceFailed: "Balance lookup failed",
        priceFailed: "Price lookup failed",
        paylinkFailed: "Payment link creation failed",
        walletCreateFailed: "Wallet creation failed",
        mnemonicMissing: "Enter mnemonic first",
        mnemonicInvalid: "Invalid mnemonic or unable to derive address",
        usdLabel: "USD",
        usdNote: "CoinMarketCap",
        usdUnavailable: "CMC unavailable",
        usdNetworkError: "network error",
        payUrlLabel: "URL"
      },
      send: {
        title: "Send (full signing flow)",
        yourAddress: "Your address (change returns here):",
        saveAddress: "Save address",
        mnemonicLabel: "Mnemonic (stored in browser localStorage):",
        signingSource: "Signing key source: Local wallet (browser-only)",
        pathLabel: "Derivation Path (read-only):",
        pathNote: "(Update to PEPEPOW official path)",
        saveMnemonic: "Save mnemonic",
        toLabel: "Recipient address",
        recentRecipients: "Recent recipients",
        noRecentRecipients: "No recent recipients yet.",
        amountLabel: "Amount (PEPEW)",
        feeLabel: "Fee (PEPEW)",
        feeEstimate: "Estimated fee (API):",
        feeFallbackNotice: "Fee estimate failed; using fallback {{fee}} PEPEW.",
        feeSummary: "Fee",
        totalCost: "Total cost",
        recipientReceives: "Recipient will receive",
        subtractFee: "Subtract fee from amount",
        max: "Max",
        sourceLabel: "Source",
        sending: "Sending...",
        submit: "Sign & broadcast",
        utxosTitle: "UTXOs ({{count}} found)",
        broadcasted: "Broadcasted",
        errors: {
          mnemonicMissing: "Enter mnemonic first",
          amountInvalid: "Enter a valid amount",
          amountTooLow: "Minimum send amount is {{min}} PEPEW",
          amountUnderFee: "Amount must be greater than the fee",
          feeInvalid: "Enter a valid fee",
          insufficientBalance: "Insufficient balance (including fee)",
          insufficientUtxo: "Insufficient UTXOs",
          txRawFailed: "Unable to fetch raw tx: {{txid}}",
          txRawNotFound: "Raw transaction not found (node may have txindex disabled): {{txid}}",
          broadcastFailed: "Broadcast failed",
          utxoFailed: "Failed to fetch UTXOs",
          utxoApiError: "UTXO API error",
          feeEstimateFailed: "Fee estimate failed"
        }
      },
      history: {
        title: "History",
        emptyAddress: "Set your address on Home first.",
        emptyTxs: "No transactions yet.",
        goReceive: "Go to Receive",
        goSend: "Go to Send",
        refresh: "Refresh",
        debugTitle: "API Debug",
        errorLabel: "Error",
        loading: "Loading...",
        readFailed: "Failed to load",
        confirmations: "Confirmations",
        utxosTitle: "UTXOs (Advanced)",
        utxosEmpty: "No UTXOs available"
      },
      mini: {
        title: "PEPEPOW Mini App",
        authorizing: "Authorizing...",
        openInTelegram: "Open inside Telegram Mini App",
        missingInitData: "Missing Telegram initData",
        authFailed: "Authorization failed",
        loggedIn: "Logged in. Mini wallet ready.",
        tokenReady: "JWT acquired"
      }
    }
  }
};

const storedLang = typeof localStorage === "undefined" ? null : localStorage.getItem(LANG_STORAGE_KEY);
const initialLang = normalizeLang(storedLang);

i18n.use(initReactI18next).init({
  resources,
  lng: initialLang,
  fallbackLng: DEFAULT_LANG,
  supportedLngs: ["en", "zh-TW"],
  interpolation: { escapeValue: false }
});

i18n.on("languageChanged", (lng) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LANG_STORAGE_KEY, normalizeLang(lng));
});

export { normalizeLang };
export default i18n;
