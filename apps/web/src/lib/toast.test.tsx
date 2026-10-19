import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastKind } from './toast';

function Trigger({ message, kind }: { message: string; kind: ToastKind }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.push(message, kind)}>
      avisar
    </button>
  );
}

describe('ToastProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('o aviso aparece com o tipo e sai sozinho depois de 4 segundos', () => {
    render(
      <ToastProvider>
        <Trigger message="Proposta enviada" kind="success" />
      </ToastProvider>,
    );

    act(() => screen.getByRole('button', { name: 'avisar' }).click());
    expect(screen.getByText('Proposta enviada')).toHaveClass('toast', 'toast-success');

    act(() => vi.advanceTimersByTime(3999));
    expect(screen.getByText('Proposta enviada')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Proposta enviada')).not.toBeInTheDocument();
  });

  it('ao desmontar, nenhum timer de saída fica pendente (não atualiza estado depois de sair da tela)', () => {
    const { unmount } = render(
      <ToastProvider>
        <Trigger message="Erro ao salvar" kind="error" />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'avisar' }).click());
    act(() => screen.getByRole('button', { name: 'avisar' }).click());
    expect(vi.getTimerCount()).toBe(2);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('useToast fora do provider é erro de uso', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger message="x" kind="info" />)).toThrow(
      'useToast deve ser usado dentro de <ToastProvider>',
    );
    spy.mockRestore();
  });
});
