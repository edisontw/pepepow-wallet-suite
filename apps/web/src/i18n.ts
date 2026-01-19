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
        apiUnreachable: "無法連線 API",
        apiNotFound: "API endpoint 不存在"
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
        mnemonicHint: "請輸入 12 或 24 個有效助記詞。",
        usdLabel: "USD",
        usdNote: "CoinMarketCap",
        usdUnavailable: "CMC 無法取得",
        usdNetworkError: "網路錯誤",
        pendingSpend: "待確認支出",
        payUrlLabel: "URL",
        setDefault: "設為預設收款地址",
        defaultAddressSet: "預設地址已設定！",
        defaultAddressConfirmed: "已綁定 Telegram ✅",
        defaultSyncHint: "建立/匯入錢包後，請按「設為預設收款地址」綁定 Telegram。",
        defaultSyncTelegramOnly: "請在 Telegram Mini App 內開啟錢包以綁定地址。"
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
        newTransfer: "新的轉帳",
        alreadyBroadcast: "已廣播，請等待 UTXO 更新。",
        errors: {
          mnemonicMissing: "請先輸入助記詞",
          amountInvalid: "請輸入正確的金額",
          amountTooLow: "最低轉帳金額為 {{min}} PEPEW",
          amountUnderFee: "金額必須大於手續費",
          amountDust: "金額過小（dust），請提高金額。",
          feeInvalid: "請輸入正確的手續費",
          feeTooLow: "手續費過低，請提高。",
          insufficientBalance: "餘額不足（含手續費）",
          insufficientUtxo: "可用 UTXO 不足",
          utxoPending: "UTXO 尚未更新，請稍候再試",
          txRawFailed: "無法取得原始交易: {{txid}}",
          txRawNotFound: "找不到原始交易（節點可能未啟用 txindex 或交易不可查）：{{txid}}",
          broadcastFailed: "廣播失敗",
          utxoFailed: "UTXO 取得失敗",
          utxoApiError: "UTXO API 錯誤",
          feeEstimateFailed: "手續費估算失敗",
          recipientMissing: "請輸入收款地址",
          recipientInvalid: "收款地址格式不正確",
          senderAddressMissing: "請先設定你的地址",
          senderAddressInvalid: "你的地址格式不正確",
          telegramResolveBlocked: "對方尚未完成 Telegram 綁定，無法直接轉帳"
        },
        tgTransfer: "發送給 Telegram 使用者",
        resolve: "解析",
        notResolved: "對方尚未設定地址。",
        tgUserNotFound: "對方尚未 /start 與機器人建立連結",
        tgNoDefaultAddress: "對方尚未設定預設地址",
        tgInvalidDefaultAddress: "對方預設地址無效，請對方更新",
        resolveNotFound: "找不到使用者，請嘗試 @username 或 Telegram ID。",
        resolveAuthExpired: "Telegram 授權已過期，請關閉並重新開啟 Mini App。",
        resolveUnavailable: "解析服務暫時無法使用。",
        createRequest: "建立付款邀請",
        requestLink: "請分享此連結給對方："
      },
      claim: {
        processing: "領取中...",
        success: "領取成功！"
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
        apiUnreachable: "Unable to reach API",
        apiNotFound: "API endpoint not found"
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
        mnemonicHint: "Enter 12 or 24 valid words.",
        usdLabel: "USD",
        usdNote: "CoinMarketCap",
        usdUnavailable: "CMC unavailable",
        usdNetworkError: "network error",
        pendingSpend: "Pending spend",
        payUrlLabel: "URL",
        setDefault: "Set as Default Receive Address",
        defaultAddressSet: "Default address set!",
        defaultAddressConfirmed: "Linked to Telegram ✅",
        defaultSyncHint: "After creating/importing a wallet, tap Set as Default to link this address to Telegram.",
        defaultSyncTelegramOnly: "Open this wallet in Telegram Mini App to link your address."
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
        newTransfer: "New transfer",
        alreadyBroadcast: "Already broadcast. Please wait for UTXOs to update.",
        errors: {
          mnemonicMissing: "Enter mnemonic first",
          amountInvalid: "Enter a valid amount",
          amountTooLow: "Minimum send amount is {{min}} PEPEW",
          amountUnderFee: "Amount must be greater than the fee",
          amountDust: "Amount too small (dust). Increase amount.",
          feeInvalid: "Enter a valid fee",
          feeTooLow: "Fee too low. Try higher fee.",
          insufficientBalance: "Insufficient balance (including fee)",
          insufficientUtxo: "Insufficient UTXOs",
          utxoPending: "UTXO not updated yet. Please wait and try again.",
          txRawFailed: "Unable to fetch raw tx: {{txid}}",
          txRawNotFound: "Raw transaction not found (node may have txindex disabled): {{txid}}",
          broadcastFailed: "Broadcast failed",
          utxoFailed: "Failed to fetch UTXOs",
          utxoApiError: "UTXO API error",
          feeEstimateFailed: "Fee estimate failed",
          recipientMissing: "Recipient address required",
          recipientInvalid: "Recipient address is invalid",
          senderAddressMissing: "Your address is required",
          senderAddressInvalid: "Your address is invalid",
          telegramResolveBlocked: "Telegram user has no linked address. Resolve or create a payment request."
        },
        tgTransfer: "Send to Telegram User",
        resolve: "Resolve",
        notResolved: "User hasn't set an address.",
        tgUserNotFound: "User hasn't started the bot yet. Ask them to /start.",
        tgNoDefaultAddress: "User hasn't set a default address.",
        tgInvalidDefaultAddress: "User's default address is invalid; ask them to update it.",
        resolveNotFound: "User not found. Try @username or Telegram ID.",
        resolveAuthExpired: "Telegram auth expired. Please close and reopen the Mini App.",
        resolveUnavailable: "Resolve service temporarily unavailable.",
        createRequest: "Create Payment Request",
        requestLink: "Share this link with them:"
      },
      claim: {
        processing: "Claiming...",
        success: "Claimed successfully!"
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
