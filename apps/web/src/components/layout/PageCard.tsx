import type { ReactNode } from "react";

interface PageCardProps {
  title?: string;
  children: ReactNode;
}

export default function PageCard({ title, children }: PageCardProps) {
  return (
    <section className="page-card card">
      {title && <h2 className="page-card-title">{title}</h2>}
      <div className="page-card-body">{children}</div>
    </section>
  );
}
