import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicSettings } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_EVENT } from '../lib/api';
import { MaintenanceGate, MaintenanceView } from './MaintenanceGate';

/**
 * Modo de manutenção (ADR 33): o 503 do cliente HTTP troca o app pela tela de manutenção até a
 * API voltar; o admin não é bloqueado e vê só a faixa lembrando de desligar.
 */

const publicSettings = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { publicSettings: () => publicSettings() } };
});

const auth = { user: null as { id: number; role: string } | null };
vi.mock('../lib/auth', () => ({ useAuth: () => auth }));

const settings = (maintenanceMode: boolean): PublicSettings => ({
  platformFeePercentage: 15,
  tacitApprovalDays: 5,
  proposalExpiryHours: 72,
  minServicePrice: 10,
  minWithdrawalAmount: 20,
  barterEnabled: true,
  deadlineGraceHours: 24,
  extensionResponseHours: 48,
  maintenanceMode,
});

function show() {
  // gcTime infinito: desmontar não deixa o relógio de limpeza da consulta pendurado.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MaintenanceGate>
        <p>Início</p>
      </MaintenanceGate>
    </QueryClientProvider>,
  );
}

/** O que o cliente HTTP faz quando a API responde 503 de manutenção. */
const apiSaysMaintenance = (): void => {
  act(() => {
    window.dispatchEvent(new Event(MAINTENANCE_EVENT));
  });
};

beforeEach(() => {
  publicSettings.mockReset();
  publicSettings.mockResolvedValue(settings(false));
  auth.user = { id: 1, role: 'client' };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MaintenanceView', () => {
  it('é um alerta com o aviso de que nada se perde e o botão de tentar de novo', async () => {
    const onRetry = vi.fn();
    render(<MaintenanceView onRetry={onRetry} busy={false} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Estamos em manutenção');
    expect(alert).toHaveTextContent(
      'Voltamos em instantes. Suas contratações, saldo e mensagens continuam guardados; nada se perde enquanto isso.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('verificando: o botão muda de texto e fica desabilitado', () => {
    render(<MaintenanceView onRetry={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Verificando…' })).toBeDisabled();
  });
});

describe('MaintenanceGate', () => {
  it('com a API no ar, mostra o app e nenhuma faixa', async () => {
    show();
    expect(screen.getByText('Início')).toBeInTheDocument();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('o 503 de manutenção troca o app pela tela de manutenção', () => {
    show();
    apiSaysMaintenance();
    expect(screen.getByRole('heading', { level: 1, name: 'Estamos em manutenção' })).toBeVisible();
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
  });

  it('visitante sem sessão também vê a tela de manutenção', () => {
    auth.user = null;
    show();
    apiSaysMaintenance();
    expect(screen.getByRole('alert')).toHaveTextContent('Estamos em manutenção');
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
  });

  it('Tentar de novo com a API de volta devolve o app e relê os parâmetros', async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiSaysMaintenance();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Início')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // 1 da carga, 1 da verificação e 1 da releitura dos parâmetros depois que voltou.
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(3));
  });

  it('enquanto verifica, o botão diz "Verificando…" e não aceita outro clique', async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiSaysMaintenance();
    let release!: (s: PublicSettings) => void;
    publicSettings.mockImplementationOnce(
      () => new Promise<PublicSettings>((resolve) => (release = resolve)),
    );
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(screen.getByRole('button', { name: 'Verificando…' })).toBeDisabled();
    await act(async () => release(settings(true)));
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeEnabled();
  });

  it('API ainda em manutenção: continua na tela, sem reler os parâmetros', async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiSaysMaintenance();
    publicSettings.mockResolvedValue(settings(true));
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Estamos em manutenção');
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
    expect(publicSettings).toHaveBeenCalledTimes(2);
  });

  it('verificação que falha (API fora do ar) continua na tela e libera o botão', async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiSaysMaintenance();
    publicSettings.mockRejectedValue(new Error('Estamos em manutenção'));
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeEnabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
  });

  it('tenta de novo sozinha a cada 30 segundos, e só enquanto está em manutenção', async () => {
    vi.useFakeTimers();
    publicSettings.mockResolvedValue(settings(true));
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(publicSettings).toHaveBeenCalledTimes(1);

    // Fora de manutenção não há verificação periódica.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(publicSettings).toHaveBeenCalledTimes(1);

    apiSaysMaintenance();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(publicSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(publicSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // A API voltou: a próxima verificação devolve o app e o relógio para.
    publicSettings.mockResolvedValue(settings(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText('Início')).toBeInTheDocument();
    const calls = publicSettings.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(publicSettings).toHaveBeenCalledTimes(calls);
  });

  it('desmontado, para de ouvir o aviso de manutenção', () => {
    // Depois de desmontar não há tela para conferir: o que se vê é o ouvinte saindo da janela.
    const listen = vi.spyOn(window, 'addEventListener');
    const unlisten = vi.spyOn(window, 'removeEventListener');
    const { unmount } = show();
    const handler = listen.mock.calls.find(([type]) => type === MAINTENANCE_EVENT)?.[1];
    expect(handler).toBeInstanceOf(Function);
    expect(unlisten).not.toHaveBeenCalledWith(MAINTENANCE_EVENT, handler);
    unmount();
    expect(unlisten).toHaveBeenCalledWith(MAINTENANCE_EVENT, handler);
  });

  it('admin não é bloqueado: mesmo com o 503, continua no app', () => {
    auth.user = { id: 9, role: 'admin' };
    show();
    apiSaysMaintenance();
    expect(screen.getByText('Início')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('admin com o modo ligado vê a faixa lembrando de desligar, junto do app', async () => {
    auth.user = { id: 9, role: 'admin' };
    publicSettings.mockResolvedValue(settings(true));
    show();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Modo de manutenção ligado: só admins acessam. Desligue em Administração › Parâmetros da plataforma.',
    );
    expect(screen.getByText('Início')).toBeInTheDocument();
  });

  it('a faixa é só do admin: quem não é admin não a vê, mesmo com o modo ligado', async () => {
    publicSettings.mockResolvedValue(settings(true));
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Início')).toBeInTheDocument();
  });

  it('admin com o modo desligado não vê faixa', async () => {
    auth.user = { id: 9, role: 'admin' };
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
