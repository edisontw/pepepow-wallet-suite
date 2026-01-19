import type { ReactNode } from "react";
import { useEffect } from "react";
import Header from "./Header";
import Footer from "./Footer";

interface AppLayoutProps {
  children: ReactNode;
  compact?: boolean;
}

export default function AppLayout({ children, compact }: AppLayoutProps) {
  const telegramWebApp = typeof window !== "undefined"
    ? (window as any)?.Telegram?.WebApp
    : undefined;
  const isTelegram = Boolean(telegramWebApp?.initData);
  const isCompact = Boolean(compact || isTelegram);

  useEffect(() => {
    if (!telegramWebApp?.initData) return;
    // Reserved for future Mini App UX integrations.
    // telegramWebApp.expand();
    // telegramWebApp.setHeaderColor("#0b0f14");
  }, []);

  return (
    <div className={`app-shell${isCompact ? " compact" : ""}`}>
      <Header compact={isCompact} />
      <main className="app-main">
        <div className={`container app-content${isCompact ? " compact" : ""}`}>
          {children}
        </div>
      </main>
      <Footer compact={isCompact} />
    </div>
  );
}
