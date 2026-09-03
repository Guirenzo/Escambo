import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Última linha de defesa: um erro de render vira uma tela amigável, não uma página em branco. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Erro não tratado na UI', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="splash">
        <div className="card" style={{ maxWidth: 420 }}>
          <h3>Algo deu errado 😕</h3>
          <p className="muted">{this.state.error.message}</p>
          <button onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      </main>
    );
  }
}
