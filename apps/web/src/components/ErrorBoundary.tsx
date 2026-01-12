import React from "react";

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
    const message = error instanceof Error ? error.message : "Unexpected error";
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
            <h2>Something went wrong</h2>
            <p>Please reload the page or try again later.</p>
            <p className="error">{this.state.message}</p>
            <button className="btn" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
