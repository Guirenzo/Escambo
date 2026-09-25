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
    quietPass: null as 'deadline'[] | null,
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
    emailPreference: () => emailPreference(),
  },
}));

const updateEmailPreference = vi.fn();
/** A preferência gravada, lida ao ligar o silêncio (ADR 56); padrão: nunca escolheu. */
const emailPreference = vi.fn();

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;

beforeEach(() => {
  pushStatus.mockReset();
  updateEmailPreference.mockReset();
  updateEmailPreference.mockResolvedValue(undefined);
  emailPreference.mockReset();
  emailPreference.mockImplementation(async () => ({ quietPass: authUser.user.quietPass }));
  authUser.user.quietHours = null;
  authUser.user.quietPass = null;
  authUser.refreshUser.mockClear();
  horaAgora = 12;
});

const status = (o: Partial<{ devices: number; held: number; deliversWork: boolean }> = {}) =>
  pushStatus.mockResolvedValue({
    publicKey: 'BChave',
    devices: 1,
    subscribed: false,
    held: 0,
    deliversWork: false,
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
    expect(bloco).toHaveTextContent('Escolha um horário em que os avisos ficam guardados');
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
    expect(bloco).toHaveTextContent('Das 22:00 às 07:00 os avisos ficam guardados;');
    expect(bloco).toHaveTextContent('com os avisos de prazo primeiro');
    expect(bloco).toHaveTextContent('O não perturbe do próprio aparelho vale por cima deste');
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

/** O que sai mesmo no silêncio (ADR 56): só para quem entrega trabalho, com a opção marcada ao ligar. */
describe('cartão de avisos: o que sai no silêncio', () => {
  it('ligar pela primeira vez, entregando trabalho, grava a janela com o prazo marcado e diz isso', async () => {
    const user = userEvent.setup();
    status({ deliversWork: true });
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    await user.click(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );
    expect(updateEmailPreference).toHaveBeenCalledWith({
      quietHours: { start: 22, end: 7 },
      quietPass: ['deadline'],
    });
    expect(
      await screen.findByText(
        /prazo vencido num trabalho que você entrega sai na hora \(dá para desmarcar logo abaixo\)/,
      ),
    ).toBeInTheDocument();
  });

  it('com a sessão deste aparelho velha, ligar lê a escolha gravada e não troca um "nada" de outro aparelho', async () => {
    const user = userEvent.setup();
    status({ deliversWork: true });
    emailPreference.mockResolvedValue({ quietPass: [] });
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    await user.click(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );
    await waitFor(() =>
      expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } }),
    );
    expect(emailPreference).toHaveBeenCalledTimes(1);
  });

  it('ligar com uma escolha já feita (nada) não remarca', async () => {
    const user = userEvent.setup();
    authUser.user.quietPass = [];
    status({ deliversWork: true });
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    await user.click(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    expect(
      await screen.findByText(/Ao fim chega um aviso só com o que ficou por ver\.$/),
    ).toBeInTheDocument();
  });

  it('quem só contrata não vê o grupo, nem a frase ao ligar', async () => {
    const user = userEvent.setup();
    status({ deliversWork: false });
    render(wrap(<PushCard />));
    const bloco = await screen.findByTestId('push-quiet');
    await user.click(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    expect(screen.queryByTestId('push-quiet-pass')).not.toBeInTheDocument();
  });

  it('conta com a janela de antes (escolha nula) vê a caixa desmarcada; marcar grava o prazo', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    status({ deliversWork: true });
    render(wrap(<PushCard />));
    const grupo = await screen.findByTestId('push-quiet-pass');
    expect(grupo).toHaveAccessibleName('Mesmo no silêncio, sai na hora');
    const caixa = within(grupo).getByRole('checkbox', {
      name: 'Prazo vencido num trabalho que você entrega',
    });
    expect(caixa).not.toBeChecked();
    expect(caixa).toHaveAccessibleDescription(/prioridade alta/);
    expect(screen.getByTestId('push-quiet')).toHaveTextContent(
      'menos o que estiver marcado logo abaixo',
    );
    await user.click(caixa);
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietPass: ['deadline'] });
    expect(
      await screen.findByText(
        'Pronto: prazo vencido num trabalho que você entrega sai na hora, mesmo no silêncio.',
      ),
    ).toBeInTheDocument();
  });

  it('desmarcar grava nada e diz que o prazo vem primeiro no aviso do fim do silêncio', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    authUser.user.quietPass = ['deadline'];
    status({ deliversWork: true });
    render(wrap(<PushCard />));
    const grupo = await screen.findByTestId('push-quiet-pass');
    await user.click(within(grupo).getByRole('checkbox'));
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietPass: [] });
    expect(
      await screen.findByText(/também espera, e vem primeiro no aviso das 07:00/),
    ).toBeInTheDocument();
  });

  it('durante a gravação o grupo fica desabilitado', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    status({ deliversWork: true });
    let solta!: () => void;
    updateEmailPreference.mockImplementation(() => new Promise<void>((r) => (solta = r)));
    render(wrap(<PushCard />));
    const grupo = await screen.findByTestId('push-quiet-pass');
    await user.click(within(grupo).getByRole('checkbox'));
    expect(grupo).toBeDisabled();
    solta();
    await waitFor(() => expect(grupo).not.toBeDisabled());
  });
});
