import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { ru } from "./locales/ru";

export type Lang = "en" | "zh-TW" | "ru";
export const SUPPORTED_LANGS: Lang[] = ["en", "zh-TW", "ru"];
export const LANG_STORAGE_KEY = "lang";
const DEFAULT_LANG: Lang = "en";

const resolveLang = (value?: string | null): Lang | null => {
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (lowered.startsWith("zh")) return "zh-TW";
  if (lowered.startsWith("ru")) return "ru";
  if (lowered.startsWith("en")) return "en";
  return null;
};

const normalizeLang = (value?: string | null): Lang => {
  return resolveLang(value) ?? DEFAULT_LANG;
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
      loading: "讀取中...",
      viewInExplorer: "在區塊瀏覽器查看",
      header: {
        wallet: "錢包",
        primaryNav: "主要導覽",
        toggleTheme: "切換主題"
      },
      nav: {
        home: "首頁",
        send: "發送",
        history: "紀錄",
        mini: "Mini",
        homeShort: "主",
        sendShort: "發",
        historyShort: "紀"
      },
      lang: {
        en: "EN",
        zh: "中文",
        ru: "RU"
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
        apiNotFound: "API endpoint 不存在",
        networkError: "網路錯誤",
        unexpected: "未預期的錯誤",
        generic: "錯誤",
        unknown: "未知錯誤"
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
        defaultSyncTelegramOnly: "請在 Telegram Mini App 內開啟錢包以綁定地址。",
        defaultSetFailed: "設定預設地址失敗",
        telegramReopenTip: "設定已儲存，請關閉並重新開啟 Telegram Mini App 使其生效",
        debugTitle: "除錯資訊",
        hideDebug: "隱藏除錯"
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
        utilitiesTitle: "工具",
        consolidate: "Consolidate UTXOs",
        consolidateHint: "將多筆小額合併成一筆，避免出錯。",
        consolidateConfirmTitle: "確認整理",
        consolidateConfirmCount: "合併 UTXO 數量：{{count}}",
        consolidateConfirmFee: "預估手續費",
        consolidateConfirmAction: "確認送出",
        consolidateCancel: "取消",
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
          telegramResolveBlocked: "對方尚未完成 Telegram 綁定，無法直接轉帳",
          requestCreateFailed: "建立請求失敗",
          requestNetworkError: "建立請求時網路錯誤",
          utxoLoading: "UTXO 資料仍在載入...",
          utxoFetchFailed: "UTXO 取得失敗：{{error}}",
          utxoEmpty: "沒有可用的 UTXO（餘額為 0 或 API 回傳空值）",
          utxoIncomplete: "UTXO 資料不完整：偵測到 {{count}} 筆無效 UTXO（缺少 scriptHex/txid/vout）。請重新整理。",
          txBuildMissingOutput: "建立交易失敗：輸出為空",
          txBuildInvalidHex: "建立交易失敗：HEX 輸出無效",
          consolidateTooLarge: "交易過大，請分批整理。"
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
        requestLink: "請分享此連結給對方：",
        defaultMemo: "來自錢包的付款"
      },
      claim: {
        processing: "領取中...",
        success: "領取成功！",
        title: "領取付款",
        missingId: "缺少請求 ID",
        status: "狀態",
        expires: "到期",
        yourAddress: "你的收款地址",
        button: "領取 PEPEW",
        alreadyProcessed: "此請求已處理或已過期。",
        fetchFailed: "取得請求失敗",
        failed: "領取失敗"
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
        utxosEmpty: "沒有可用的 UTXO",
        debug: {
          historyLabel: "紀錄",
          utxosLabel: "UTXOs",
          lastRequestPath: "最後請求路徑",
          lastRequestUrl: "最後請求 URL",
          status: "狀態",
          responseSnippet: "回應（前 200 字元）",
          error: "錯誤"
        }
      },
      mini: {
        title: "PEPEPOW Mini App",
        authorizing: "授權中...",
        openInTelegram: "請在 Telegram 內開啟 Mini App",
        missingInitData: "缺少 Telegram initData",
        authFailed: "授權失敗",
        loggedIn: "已登入，可使用迷你錢包功能。",
        tokenReady: "JWT 已取得",
        routeLoaded: "[Mini 路由已載入]",
        debugLabel: "除錯",
        initDataHint: "偵測到 Telegram WebApp，但缺少 initData。請在 Telegram 手機版測試。"
      },
      pay: {
        title: "付款",
        linkInvalid: "連結無效。",
        apiUnreachable: "無法連線 API。",
        addressLabel: "地址",
        amountLabel: "金額",
        memoLabel: "備註"
      },
      errorBoundary: {
        title: "發生錯誤",
        description: "請重新整理頁面或稍後再試。",
        reload: "重新整理"
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
      loading: "Loading...",
      viewInExplorer: "View in Explorer",
      header: {
        wallet: "Wallet",
        primaryNav: "Primary",
        toggleTheme: "Toggle theme"
      },
      nav: {
        home: "Home",
        send: "Send",
        history: "History",
        mini: "Mini",
        homeShort: "H",
        sendShort: "S",
        historyShort: "Tx"
      },
      lang: {
        en: "EN",
        zh: "中文",
        ru: "RU"
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
        apiNotFound: "API endpoint not found",
        networkError: "Network error",
        unexpected: "Unexpected error",
        generic: "Error",
        unknown: "Unknown error"
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
        defaultSyncTelegramOnly: "Open this wallet in Telegram Mini App to link your address.",
        defaultSetFailed: "Failed to set default",
        telegramReopenTip: "Setting saved. Please close and reopen the Telegram Mini App to take effect.",
        debugTitle: "Debug Info",
        hideDebug: "Hide Debug"
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
        utilitiesTitle: "Utilities",
        consolidate: "Consolidate UTXOs",
        consolidateHint: "Merge many small coins into one transaction to avoid errors.",
        consolidateConfirmTitle: "Confirm consolidation",
        consolidateConfirmCount: "UTXOs to merge: {{count}}",
        consolidateConfirmFee: "Estimated fee",
        consolidateConfirmAction: "Confirm & broadcast",
        consolidateCancel: "Cancel",
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
          telegramResolveBlocked: "Telegram user has no linked address. Resolve or create a payment request.",
          requestCreateFailed: "Failed to create request",
          requestNetworkError: "Network error creating request",
          utxoLoading: "UTXO data is still loading...",
          utxoFetchFailed: "UTXO fetch failed: {{error}}",
          utxoEmpty: "No UTXOs available (Balance is 0 or API returned empty)",
          utxoIncomplete: "UTXO data incomplete: {{count}} invalid UTXOs detected (missing scriptHex/txid/vout). Please refresh.",
          txBuildMissingOutput: "Failed to build transaction: output is undefined",
          txBuildInvalidHex: "Failed to build transaction: invalid hex output",
          consolidateTooLarge: "Transaction too large. Try consolidating in smaller batches."
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
        requestLink: "Share this link with them:",
        defaultMemo: "Payment from Wallet"
      },
      claim: {
        processing: "Claiming...",
        success: "Claimed successfully!",
        title: "Claim Payment",
        missingId: "Missing Request ID",
        status: "Status",
        expires: "Expires",
        yourAddress: "Your Receiving Address",
        button: "Claim PEPEW",
        alreadyProcessed: "This request has already been processed or expired.",
        fetchFailed: "Failed to fetch request",
        failed: "Claim failed"
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
        utxosEmpty: "No UTXOs available",
        debug: {
          historyLabel: "History",
          utxosLabel: "UTXOs",
          lastRequestPath: "Last request path",
          lastRequestUrl: "Last request URL",
          status: "Status",
          responseSnippet: "Response (200 chars)",
          error: "Error"
        }
      },
      mini: {
        title: "PEPEPOW Mini App",
        authorizing: "Authorizing...",
        openInTelegram: "Open inside Telegram Mini App",
        missingInitData: "Missing Telegram initData",
        authFailed: "Authorization failed",
        loggedIn: "Logged in. Mini wallet ready.",
        tokenReady: "JWT acquired",
        routeLoaded: "[Mini route loaded]",
        debugLabel: "debug",
        initDataHint: "Telegram WebApp detected but initData missing. Test on Telegram mobile app."
      },
      pay: {
        title: "Payment",
        linkInvalid: "Link invalid.",
        apiUnreachable: "Unable to reach API.",
        addressLabel: "Address",
        amountLabel: "Amount",
        memoLabel: "Memo"
      },
      errorBoundary: {
        title: "Something went wrong",
        description: "Please reload the page or try again later.",
        reload: "Reload"
      }
    }
  },
  ru
};

const storedLang = typeof localStorage === "undefined" ? null : localStorage.getItem(LANG_STORAGE_KEY);
const queryLang = resolveLang(
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("lang")
);
const telegramLang = resolveLang(
  typeof window === "undefined"
    ? null
    : (window as any)?.Telegram?.WebApp?.initDataUnsafe?.user?.language_code
);
const initialLang = queryLang ?? resolveLang(storedLang) ?? telegramLang ?? DEFAULT_LANG;

if (queryLang && typeof localStorage !== "undefined") {
  localStorage.setItem(LANG_STORAGE_KEY, queryLang);
}

i18n.use(initReactI18next).init({
  resources,
  lng: initialLang,
  fallbackLng: DEFAULT_LANG,
  supportedLngs: SUPPORTED_LANGS,
  interpolation: { escapeValue: false }
});

i18n.on("languageChanged", (lng) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LANG_STORAGE_KEY, normalizeLang(lng));
});

export { normalizeLang };
export default i18n;
