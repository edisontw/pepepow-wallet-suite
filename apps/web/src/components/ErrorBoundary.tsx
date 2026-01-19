import React from "react";
import i18n from "../i18n";

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : i18n.t("errors.unexpected");
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown) {
    // Keep console signal for debugging without crashing the UI.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
          <div className="container narrow">
          <div className="card">
            <h2>{i18n.t("errorBoundary.title")}</h2>
            <p>{i18n.t("errorBoundary.description")}</p>
            <p className="error">{this.state.message}</p>
            <button className="btn" onClick={() => window.location.reload()}>{i18n.t("errorBoundary.reload")}</button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
