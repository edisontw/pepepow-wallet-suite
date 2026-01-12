import type { ReactNode } from "react";
import { useEffect } from "react";
import Header from "./Header";
import Footer from "./Footer";

interface AppLayoutProps {
  children: ReactNode;
  compact?: boolean;
}

export default function AppLayout({ children, compact }: AppLayoutProps) {
  const isTelegram = typeof window !== "undefined" && Boolean((window as any)?.Telegram?.WebApp);
  const isCompact = Boolean(compact || isTelegram);

  useEffect(() => {
    const telegramWebApp = (window as any)?.Telegram?.WebApp;
    if (!telegramWebApp) return;
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
