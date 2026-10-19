import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublicSettings } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_EVENT, OUTAGE_EVENT } from '../lib/api';
import { MaintenanceGate, MaintenanceView, returnForecast } from './MaintenanceGate';

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

const settings = (
  maintenanceMode: boolean,
  maintenanceReturnAt: string | null = null,
): PublicSettings => ({
  platformFeePercentage: 15,
  tacitApprovalDays: 5,
  proposalExpiryHours: 72,
  counterOfferResponseHours: 48,
  minServicePrice: 10,
  minWithdrawalAmount: 20,
  withdrawalBusinessDays: { pix: 1, bank: 2 },
  barterEnabled: true,
  deadlineGraceHours: 24,
  extensionResponseHours: 48,
  fixedContractRules: {
    includedRevisions: 2,
    maxOffers: 5,
    disputeWaitHours: 48,
    disputeTacitMarginHours: 24,
    dropoutWindowDays: 60,
    dropoutAlertAt: 3,
    dropoutAgreementDays: 7,
  },
  maintenanceMode,
  maintenanceReturnAt,
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

/** O que o cliente HTTP faz quando o proxy responde que a API está fora do ar (RNF-010). */
const apiIsDown = (): void => {
  act(() => {
    window.dispatchEvent(new Event(OUTAGE_EVENT));
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

  it('fora do ar: diz que a equipe já está cuidando e que a tela tenta de novo sozinha', () => {
    render(<MaintenanceView onRetry={vi.fn()} busy={false} kind="outage" />);
    const alert = screen.getByRole('alert');
    expect(
      screen.getByRole('heading', { level: 1, name: 'O Escambo está fora do ar' }),
    ).toBeVisible();
    expect(alert).toHaveTextContent(
      'Já estamos cuidando disso. Suas contratações, saldo e mensagens continuam guardados; nada se perde enquanto isso.',
    );
    expect(alert).toHaveTextContent('Esta tela tenta de novo sozinha a cada 30 segundos.');
    expect(alert).not.toHaveTextContent('manutenção');
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
  it('o aviso de fora do ar troca o app pela tela de fora do ar', () => {
    show();
    apiIsDown();
    expect(
      screen.getByRole('heading', { level: 1, name: 'O Escambo está fora do ar' }),
    ).toBeVisible();
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
  });

  it('fora do ar vale também para o admin: a API não responde para ninguém', () => {
    auth.user = { id: 9, role: 'admin' };
    show();
    apiIsDown();
    expect(screen.getByRole('alert')).toHaveTextContent('O Escambo está fora do ar');
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
  });

  it('API voltou em manutenção: a tela de fora do ar vira a de manutenção', async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiIsDown();
    publicSettings.mockResolvedValue(settings(true));
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Estamos em manutenção' }),
    ).toBeVisible();
    expect(screen.queryByText('Início')).not.toBeInTheDocument();
  });

  it('API voltou em manutenção e quem vê é admin: volta ao app, com a faixa', async () => {
    const user = userEvent.setup();
    auth.user = { id: 9, role: 'admin' };
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiIsDown();
    publicSettings.mockResolvedValue(settings(true));
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Início')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('API de volta e fora de manutenção: o app volta', async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiIsDown();
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Início')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('desmontado, para de ouvir o aviso de fora do ar', () => {
    const listen = vi.spyOn(window, 'addEventListener');
    const unlisten = vi.spyOn(window, 'removeEventListener');
    const { unmount } = show();
    const handler = listen.mock.calls.find(([type]) => type === OUTAGE_EVENT)?.[1];
    expect(handler).toBeInstanceOf(Function);
    unmount();
    expect(unlisten).toHaveBeenCalledWith(OUTAGE_EVENT, handler);
  });
});

describe('previsão de volta da manutenção (RNF-010)', () => {
  const now = new Date(2026, 9, 19, 14, 0);

  it('hoje, amanhã ou com a data, no horário de quem vê', () => {
    expect(returnForecast(new Date(2026, 9, 19, 15, 40).toISOString(), now)).toBe('hoje às 15:40');
    expect(returnForecast(new Date(2026, 9, 20, 1, 10).toISOString(), now)).toBe('amanhã às 01:10');
    expect(returnForecast(new Date(2026, 9, 22, 9, 0).toISOString(), now)).toBe('22/10 às 09:00');
  });

  it('sem previsão, inválida ou que já passou: nada (vale o "Voltamos em instantes")', () => {
    expect(returnForecast(null, now)).toBeNull();
    expect(returnForecast(undefined, now)).toBeNull();
    expect(returnForecast('não é data', now)).toBeNull();
    expect(returnForecast(new Date(2026, 9, 19, 13, 59).toISOString(), now)).toBeNull();
  });

  it('a tela de manutenção diz a previsão no lugar do "Voltamos em instantes"', () => {
    const inOneHour = new Date(Date.now() + 60 * 60_000).toISOString();
    render(<MaintenanceView onRetry={vi.fn()} busy={false} returnAt={inOneHour} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Previsão de volta: (hoje|amanhã) às \d{2}:\d{2}\./);
    expect(alert).not.toHaveTextContent('Voltamos em instantes');
  });

  it('fora do ar não mostra previsão: a queda não foi planejada', () => {
    const inOneHour = new Date(Date.now() + 60 * 60_000).toISOString();
    render(<MaintenanceView onRetry={vi.fn()} busy={false} kind="outage" returnAt={inOneHour} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Previsão de volta');
  });

  it('o portão usa a previsão dos parâmetros e a atualiza a cada verificação', async () => {
    const user = userEvent.setup();
    const first = new Date(Date.now() + 30 * 60_000);
    publicSettings.mockResolvedValue(settings(true, first.toISOString()));
    show();
    await waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1));
    apiSaysMaintenance();
    expect(await screen.findByText(/Previsão de volta: .*\./)).toBeInTheDocument();

    const later = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    publicSettings.mockResolvedValue(settings(true, later.toISOString()));
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    const day = later.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    expect(await screen.findByText(new RegExp(`Previsão de volta: ${day} às`))).toBeInTheDocument();
  });

  it('a previsão que veio no 503 aparece na hora, sem esperar a próxima verificação', () => {
    show();
    const at = new Date(Date.now() + 40 * 60_000).toISOString();
    act(() => {
      window.dispatchEvent(new CustomEvent(MAINTENANCE_EVENT, { detail: { returnAt: at } }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Previsão de volta: (hoje|amanhã) às/);
    expect(publicSettings).toHaveBeenCalledTimes(1);
  });

  it('aviso sem previsão (ou com valor que não é texto) mantém o "Voltamos em instantes"', () => {
    show();
    act(() => {
      window.dispatchEvent(new CustomEvent(MAINTENANCE_EVENT, { detail: { returnAt: 123 } }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Voltamos em instantes');
  });
});
