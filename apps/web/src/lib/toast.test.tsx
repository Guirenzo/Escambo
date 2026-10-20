import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_AUTO_DISMISS_MS, ToastProvider, useToast, type ToastKind } from './toast';

function Trigger({ message, kind }: { message: string; kind: ToastKind }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.push(message, kind)}>
      avisar
    </button>
  );
}

const toastOf = (text: string): HTMLElement => screen.getByText(text).closest('.toast')!;

describe('ToastProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('o aviso de sucesso aparece com o tipo e sai sozinho depois do tempo', () => {
    render(
      <ToastProvider>
        <Trigger message="Proposta enviada" kind="success" />
      </ToastProvider>,
    );

    act(() => screen.getByRole('button', { name: 'avisar' }).click());
    expect(toastOf('Proposta enviada')).toHaveClass('toast', 'toast-success');

    act(() => vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1));
    expect(screen.getByText('Proposta enviada')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Proposta enviada')).not.toBeInTheDocument();
  });

  it('com o mouse em cima ou o foco dentro, o relógio para e continua de onde parou (WCAG 2.2.1)', () => {
    render(
      <ToastProvider>
        <Trigger message="Perfil salvo" kind="info" />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'avisar' }).click());
    act(() => vi.advanceTimersByTime(2000));

    fireEvent.mouseEnter(toastOf('Perfil salvo'));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Perfil salvo')).toBeInTheDocument();
    fireEvent.mouseLeave(toastOf('Perfil salvo'));

    fireEvent.focus(screen.getByRole('button', { name: 'Fechar aviso' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Perfil salvo')).toBeInTheDocument();
    fireEvent.blur(screen.getByRole('button', { name: 'Fechar aviso' }));

    // Faltavam 4 s quando parou: sai nesse tempo, não no tempo inteiro de novo.
    act(() => vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 2000 - 1));
    expect(screen.getByText('Perfil salvo')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Perfil salvo')).not.toBeInTheDocument();
  });

  it('o aviso de erro fica até a pessoa fechar', () => {
    render(
      <ToastProvider>
        <Trigger message="Saldo insuficiente" kind="error" />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'avisar' }).click());
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Saldo insuficiente');

    act(() => screen.getByRole('button', { name: 'Fechar aviso' }).click());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sucesso e informação vão para a região viva educada; erro vira alerta, fora dela', () => {
    render(
      <ToastProvider>
        <Trigger message="Proposta enviada" kind="success" />
        <Trigger message="Saldo insuficiente" kind="error" />
      </ToastProvider>,
    );
    const [ok, fail] = screen.getAllByRole('button', { name: 'avisar' });
    act(() => ok!.click());
    act(() => fail!.click());
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Proposta enviada');
    expect(status).not.toHaveTextContent('Saldo insuficiente');
    expect(screen.getByRole('alert')).toHaveTextContent('Saldo insuficiente');
    expect(screen.getByRole('alert')).toHaveClass('toast', 'toast-error');
  });

  it('no máximo cinco avisos na tela: o mais antigo sai', () => {
    render(
      <ToastProvider>
        <Trigger message="Falhou" kind="error" />
      </ToastProvider>,
    );
    for (let i = 0; i < 7; i++) act(() => screen.getByRole('button', { name: 'avisar' }).click());
    expect(screen.getAllByRole('alert')).toHaveLength(5);
  });

  it('ao desmontar, nenhum timer de saída fica pendente (não atualiza estado depois de sair da tela)', () => {
    const { unmount } = render(
      <ToastProvider>
        <Trigger message="Salvo" kind="success" />
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
