import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("BLACK-GOAT UI runtime error", error, info);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <main className="app-shell">
          <section className="page-content">
            <article className="simulation-empty">
              <h1>BLACK-GOAT</h1>
              <h2>Erreur interface</h2>
              <p>La page a rencontré une erreur runtime au lieu d’afficher un écran noir.</p>
              <p>{this.state.error.message}</p>
              <button onClick={() => window.location.reload()} type="button">
                Recharger
              </button>
            </article>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
