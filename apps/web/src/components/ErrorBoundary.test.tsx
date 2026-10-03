import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/** Última linha de defesa: erro de render vira uma tela com a mensagem e o botão de recarregar. */

function Broken(): never {
  throw new Error('Saldo veio sem valor');
}

describe('ErrorBoundary', () => {
  let consoleError: MockInstance<typeof console.error>;
  /** O jsdom imprime todo erro não tratado da janela: o erro aqui é de propósito. */
  const swallow = (e: ErrorEvent): void => e.preventDefault();

  beforeEach(() => {
    // O React também escreve o erro no console; o teste confere só a linha da própria barreira.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.addEventListener('error', swallow);
  });

  afterEach(() => {
    window.removeEventListener('error', swallow);
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it('sem erro, mostra os filhos como estão', () => {
    render(
      <ErrorBoundary>
        <p>Carteira</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Carteira')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recarregar' })).not.toBeInTheDocument();
  });

  it('erro de render vira a tela amigável com a mensagem do erro, no lugar dos filhos', () => {
    render(
      <ErrorBoundary>
        <p>Carteira</p>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Algo deu errado 😕' })).toBeInTheDocument();
    expect(screen.getByText('Saldo veio sem valor')).toBeInTheDocument();
    expect(screen.queryByText('Carteira')).not.toBeInTheDocument();
  });

  it('registra o erro no console com a pilha de componentes', () => {
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    const own = consoleError.mock.calls.find((c) => c[0] === 'Erro não tratado na UI');
    expect(own).toBeDefined();
    expect((own![1] as Error).message).toBe('Saldo veio sem valor');
    expect(own![2]).toContain('Broken');
  });

  it('Recarregar recarrega a página', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
