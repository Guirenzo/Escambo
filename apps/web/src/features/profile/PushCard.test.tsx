import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PushCard } from './PushCard';
import { ToastProvider } from '../../lib/toast';

/**
 * Avisos no navegador (ADR 52): o que o cartão afirma sobre o servidor. Canal desligado e consulta
 * que falhou parecem iguais na resposta (sem chave pública), e afirmar "desligado" numa falha
 * seria mentir sobre a configuração de quem está do outro lado.
 */

const pushStatus = vi.fn();

/** O cartão lê a janela e o fuso da sessão (ADR 54): sem AuthProvider, um usuário de mentira. */
const authUser = {
  user: {
    id: 1,
    ulid: 'u1',
    email: 'a@escambo.test',
    role: 'freelancer',
    emailVerified: true,
    emailFrequency: 'instant',
    digestHour: 8,
    timezone: 'America/Sao_Paulo',
    timezoneChosen: true,
    quietHours: null as { start: number; end: number } | null,
  },
  refreshUser: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../lib/auth', () => ({ useAuth: () => authUser }));

let horaAgora = 12;
vi.mock('../../lib/push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/push')>();
  return { ...actual, hourNowIn: () => horaAgora };
});

vi.mock('../../lib/api', () => ({
  api: {
    pushStatus: (endpoint?: string) => pushStatus(endpoint),
    pushSubscribe: vi.fn(),
    pushUnsubscribe: vi.fn(),
    pushTest: vi.fn(),
    updateEmailPreference: (body: unknown) => updateEmailPreference(body),
  },
}));

const updateEmailPreference = vi.fn();

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;

beforeEach(() => {
  pushStatus.mockReset();
  updateEmailPreference.mockReset();
  updateEmailPreference.mockResolvedValue(undefined);
  authUser.user.quietHours = null;
  authUser.refreshUser.mockClear();
  horaAgora = 12;
});

const status = (o: Partial<{ devices: number; held: number }> = {}) =>
  pushStatus.mockResolvedValue({
    publicKey: 'BChave',
    devices: 1,
    subscribed: false,
    held: 0,
    ...o,
  });

describe('cartão de avisos no navegador', () => {
  it('canal desligado no servidor: explica e não conta aparelhos', async () => {
    pushStatus.mockResolvedValue({ publicKey: '', devices: 0, subscribed: false, held: 0 });
    render(wrap(<PushCard />));

    expect(await screen.findByText(/desligados neste servidor/)).toBeInTheDocument();
    expect(screen.queryByTestId('push-devices')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ligar avisos/ })).not.toBeInTheDocument();
  });

  it('consulta que falha não vira "desligado no servidor": o botão continua lá', async () => {
    pushStatus.mockRejectedValue(new Error('rede fora do ar'));
    render(wrap(<PushCard />));

    // Sem suporte a push no jsdom, o cartão cai no texto de "este navegador não recebe avisos" —
    // o que importa é não afirmar que o servidor está com o canal desligado.
    expect(await screen.findByTestId('push-card')).toBeInTheDocument();
    expect(screen.queryByText(/desligados neste servidor/)).not.toBeInTheDocument();
  });

  it('"não perturbe" só aparece com aparelho ligado ou janela gravada', async () => {
    status({ devices: 0 });
    render(wrap(<PushCard />));
    await screen.findByTestId('push-card');
    expect(screen.queryByTestId('push-quiet')).not.toBeInTheDocument();
  });

  it('marcar liga a noite (22h às 7h) e grava a janela inteira', async () => {
    const user = userEvent.setup();
    status();
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    expect(bloco).toHaveTextContent('Escolha um horário em que nenhum aparelho desta conta');
    await user.click(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    await waitFor(() => expect(authUser.refreshUser).toHaveBeenCalled());
    expect(
      await screen.findByText(/silêncio das 22:00 às 07:00, horário de Brasília/),
    ).toBeInTheDocument();
  });

  it('com a janela gravada: seleções sem a hora do outro lado, "(do dia seguinte)" e a dica completa', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    status();
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    const inicio = within(bloco).getByRole('combobox', { name: 'Início do silêncio' });
    const fim = within(bloco).getByRole('combobox', { name: 'Fim do silêncio' });
    expect(inicio).toHaveValue('22');
    expect(fim).toHaveValue('7');
    expect(within(inicio).queryByRole('option', { name: '07:00' })).not.toBeInTheDocument();
    expect(within(fim).queryByRole('option', { name: '22:00' })).not.toBeInTheDocument();
    expect(bloco).toHaveTextContent('(do dia seguinte)');
    expect(bloco).toHaveTextContent('Das 22:00 às 07:00 nenhum aparelho desta conta recebe aviso');
    expect(bloco).toHaveTextContent('o aviso de teste sai na hora');

    await user.selectOptions(fim, '6');
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 6 } });
  });

  it('desmarcar desliga (null); a janela diurna não mostra "(do dia seguinte)"', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 13, end: 14 };
    status();
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    expect(bloco).not.toHaveTextContent('(do dia seguinte)');
    await user.click(within(bloco).getByRole('checkbox'));
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: null });
  });

  it('dentro da janela o cabeçalho diz até quando, e quantos avisos ficaram guardados', async () => {
    authUser.user.quietHours = { start: 22, end: 7 };
    horaAgora = 23;
    status({ devices: 2, held: 2 });
    render(wrap(<PushCard />));
    expect(await screen.findByTestId('push-quiet-now')).toHaveTextContent(
      'silêncio até as 07:00 · 2 avisos guardados',
    );
  });

  it('fora da janela, com retidos ainda por resumir, avisa que saem em instantes', async () => {
    authUser.user.quietHours = { start: 22, end: 7 };
    horaAgora = 7;
    status({ held: 1 });
    render(wrap(<PushCard />));
    expect(await screen.findByTestId('push-quiet-now')).toHaveTextContent(
      '1 aviso sai em instantes',
    );
  });

  it('o parágrafo do cartão avisa da transferência para o serviço de push, fora do Brasil', async () => {
    status({ devices: 0 });
    render(wrap(<PushCard />));
    // O jsdom não tem PushManager: o cartão cai em "sem suporte" e o parágrafo não aparece.
    // Ele é conferido no e2e, com o PushManager de mentira (push-navegador.smoke.spec.ts).
    expect(await screen.findByTestId('push-card')).toBeInTheDocument();
  });
});
