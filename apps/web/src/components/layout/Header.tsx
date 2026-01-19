import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { normalizeLang, SUPPORTED_LANGS } from "../../i18n";

type HeaderProps = {
  compact?: boolean;
};

type NavItem = {
  to: string;
  label: string;
  short: string;
};

export default function Header({ compact }: HeaderProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const currentLang = normalizeLang(i18n.language);
  const currentIndex = SUPPORTED_LANGS.indexOf(currentLang);
  const nextLang = SUPPORTED_LANGS[(currentIndex + 1) % SUPPORTED_LANGS.length];
  const langKey = nextLang === "zh-TW" ? "zh" : nextLang;
  const langLabel = t(`lang.${langKey}`);

  const navItems: NavItem[] = [
    { to: "/", label: t("nav.home"), short: t("nav.homeShort") },
    { to: "/send", label: t("nav.send"), short: t("nav.sendShort") },
    { to: "/history", label: t("nav.history"), short: t("nav.historyShort") },
  ];

  const visibleItems = navItems;

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <header className={`app-header${compact ? " compact" : ""}`}>
      <div className="app-header-inner">
        <Link to="/" className="brand" aria-label={t("title")}>
          <img src="/brand/logo.png" alt="PEPEPOW" className="brand-logo" />
          <span className="brand-text">
            <span className="brand-name">PEPEPOW</span>
            <span className="brand-sub">{t("header.wallet")}</span>
          </span>
        </Link>
        <nav className="nav-links" aria-label={t("header.primaryNav")}>
          {visibleItems.map((item) => {
            const active = isActive(item.to);
            const shortLabel = compact
              ? item.label
              : item.label.length <= 3
                ? item.label
                : item.short;
            return (
              <Link
                key={item.to}
                className={`nav-link${active ? " is-active" : ""}`}
                to={item.to}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
              >
                <span className="nav-label">{item.label}</span>
                <span className="nav-short">{shortLabel}</span>
              </Link>
            );
          })}
        </nav>
        <div className="nav-actions">
          <button
            className="btn ghost small"
            onClick={() => {
              const d = document.documentElement;
              d.dataset.theme = d.dataset.theme === "light" ? "" : "light";
            }}
            aria-label={t("header.toggleTheme")}
          >
            🌓
          </button>
          <button className="btn secondary small" onClick={() => i18n.changeLanguage(nextLang)}>
            {langLabel}
          </button>
        </div>
      </div>
    </header>
  );
}
