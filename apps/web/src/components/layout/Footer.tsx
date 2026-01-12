import ApiStatusBar from "../ApiStatusBar";

type FooterProps = {
  compact?: boolean;
};

export default function Footer({ compact }: FooterProps) {
  return (
    <footer className={`app-footer${compact ? " compact" : ""}`}>
      <ApiStatusBar />
    </footer>
  );
}
