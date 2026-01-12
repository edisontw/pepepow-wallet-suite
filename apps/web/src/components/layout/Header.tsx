import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { normalizeLang } from "../../i18n";

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
  const nextLang = currentLang === "en" ? "zh-TW" : "en";
  const langLabel = currentLang === "en" ? t("lang.zh") : t("lang.en");

  const navItems: NavItem[] = [
    { to: "/", label: t("nav.home"), short: "H" },
    { to: "/send", label: t("nav.send"), short: "S" },
    { to: "/history", label: t("nav.history"), short: "Tx" },
  ];

  const visibleItems = compact
    ? navItems.filter((item) => item.to === "/" || item.to === "/send")
    : navItems;

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <header className={`app-header${compact ? " compact" : ""}`}>
      <div className="app-header-inner">
        <Link to="/" className="brand" aria-label="PEPEPOW Wallet">
          <img src="/brand/logo.png" alt="PEPEPOW" className="brand-logo" />
          <span className="brand-text">
            <span className="brand-name">PEPEPOW</span>
            <span className="brand-sub">Wallet</span>
          </span>
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {visibleItems.map((item) => {
            const active = isActive(item.to);
            const shortLabel = item.label.length <= 3 ? item.label : item.short;
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
            aria-label="Toggle theme"
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
