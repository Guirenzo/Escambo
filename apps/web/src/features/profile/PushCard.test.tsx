import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PushCard } from './PushCard';
import { ToastProvider } from '../../lib/toast';

/**
 * Avisos no navegador (ADR 52): o que o cartão afirma sobre o servidor. Canal desligado e consulta
 * que falhou parecem iguais na resposta (sem chave pública), e afirmar "desligado" numa falha
 * seria mentir sobre a configuração de quem está do outro lado. O jsdom não tem PushManager: aqui
 * o cartão está sempre em "sem suporte" (o aparelho com push está em PushCard.device.test.tsx).
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

/** Frase que só aparece depois que a consulta ao servidor volta (sem push no jsdom). */
const SEM_SUPORTE =
  'Este navegador não recebe avisos do Escambo. Os e-mails e a lista de notificações continuam funcionando normalmente.';

const quietGroup = (): Promise<HTMLElement> => screen.findByRole('group', { name: 'Não perturbe' });
const passGroup = (): Promise<HTMLElement> =>
  screen.findByRole('group', { name: 'Mesmo no silêncio, sai na hora' });
const quietToggle = (bloco: HTMLElement): HTMLElement =>
  within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' });

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

    expect(
      await screen.findByText(
        'Os avisos no navegador estão desligados neste servidor. As notificações aqui dentro e os e-mails continuam funcionando normalmente.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Avisos no navegador' })).toBeInTheDocument();
    expect(screen.queryByText(/aparelhos? ligados?/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ligar avisos/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Não perturbe' })).not.toBeInTheDocument();
  });

  it('consulta que falha não vira "desligado no servidor": o cartão segue contando aparelhos', async () => {
    pushStatus.mockRejectedValue(new Error('rede fora do ar'));
    render(wrap(<PushCard />));

    // Sem suporte a push no jsdom, o cartão cai no texto de "este navegador não recebe avisos" —
    // e essa frase só sai depois que a falha da consulta foi tratada.
    expect(await screen.findByText(SEM_SUPORTE)).toBeInTheDocument();
    expect(pushStatus).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText(/desligados neste servidor/)).not.toBeInTheDocument();
    expect(screen.getByText('0 aparelhos ligados')).toBeInTheDocument();
  });

  it('"não perturbe" não aparece sem aparelho ligado e sem janela gravada', async () => {
    status({ devices: 0 });
    render(wrap(<PushCard />));

    expect(await screen.findByText(SEM_SUPORTE)).toBeInTheDocument();
    expect(screen.getByText('0 aparelhos ligados')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Não perturbe' })).not.toBeInTheDocument();
  });

  it('com um aparelho ligado na conta, o "não perturbe" aparece desligado e explica o que faz', async () => {
    status({ devices: 1 });
    render(wrap(<PushCard />));

    const bloco = await quietGroup();
    expect(screen.getByText('1 aparelho ligado')).toBeInTheDocument();
    expect(quietToggle(bloco)).not.toBeChecked();
    expect(quietToggle(bloco)).toHaveAccessibleDescription(
      'Escolha um horário em que os avisos ficam guardados. Ao fim dele chega um aviso só com o que ficou por ver; as notificações aqui dentro e os e-mails não mudam.',
    );
    expect(within(bloco).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('marcar liga a noite (22h às 7h), grava a janela inteira, relê a sessão e confirma', async () => {
    const user = userEvent.setup();
    status();
    render(wrap(<PushCard />));

    await user.click(quietToggle(await quietGroup()));

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    expect(
      await screen.findByText(
        'Pronto: silêncio das 22:00 às 07:00, horário de Brasília. Ao fim chega um aviso só com o que ficou por ver.',
      ),
    ).toBeInTheDocument();
    expect(authUser.refreshUser).toHaveBeenCalledTimes(1);
    // Quem só contrata não lê a escolha do que sai no silêncio.
    expect(emailPreference).not.toHaveBeenCalled();
  });

  it('com a janela gravada: seleções sem a hora do outro lado, "(do dia seguinte)" e a dica completa', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    status();
    render(wrap(<PushCard />));
    const bloco = await quietGroup();
    const inicio = within(bloco).getByRole('combobox', { name: 'Início do silêncio' });
    const fim = within(bloco).getByRole('combobox', { name: 'Fim do silêncio' });
    expect(quietToggle(bloco)).toBeChecked();
    expect(inicio).toHaveValue('22');
    expect(fim).toHaveValue('7');
    expect(within(inicio).getAllByRole('option')).toHaveLength(23);
    expect(within(inicio).queryByRole('option', { name: '07:00' })).not.toBeInTheDocument();
    expect(within(fim).queryByRole('option', { name: '22:00' })).not.toBeInTheDocument();
    expect(bloco).toHaveTextContent('(do dia seguinte)');
    expect(inicio).toHaveAccessibleDescription(
      'Horário de Brasília (o fuso se troca no cartão E-mails do Escambo). Das 22:00 às 07:00 os avisos ficam guardados; a partir das 07:00 chega um aviso só com o que ficou por ver, com os avisos de prazo primeiro. As notificações aqui dentro e os e-mails não mudam, e o aviso de teste sai na hora. O não perturbe do próprio aparelho vale por cima deste.',
    );

    await user.selectOptions(fim, '6');

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 6 } });
    expect(
      await screen.findByText('Pronto: silêncio das 22:00 às 06:00, horário de Brasília.'),
    ).toBeInTheDocument();
  });

  it('desmarcar desliga (null); a janela diurna não mostra "(do dia seguinte)"', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 13, end: 14 };
    status();
    render(wrap(<PushCard />));
    const bloco = await quietGroup();
    expect(bloco).not.toHaveTextContent('(do dia seguinte)');

    await user.click(quietToggle(bloco));

    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: null });
    expect(
      await screen.findByText('Pronto: os avisos voltam a bater a qualquer hora.'),
    ).toBeInTheDocument();
  });
});

describe('cartão de avisos: o cabeçalho durante e depois do silêncio', () => {
  it.each([
    [23, 2, 'silêncio até as 07:00 · 2 avisos guardados'],
    [3, 1, 'silêncio até as 07:00 · 1 aviso guardado'],
    [22, 0, 'silêncio até as 07:00'],
    [7, 1, '1 aviso sai em instantes'],
    [12, 3, '3 avisos saem em instantes'],
  ])('às %i h, com %i aviso(s) retido(s), o cabeçalho diz "%s"', async (hora, held, texto) => {
    authUser.user.quietHours = { start: 22, end: 7 };
    horaAgora = hora;
    status({ devices: 2, held });
    render(wrap(<PushCard />));

    // A contagem que veio da API, seguida do que o silêncio está fazendo agora.
    expect(await screen.findByText('2 aparelhos ligados ·')).toBeInTheDocument();
    expect(screen.getByText(texto)).toBeInTheDocument();
  });

  it('fora da janela e sem avisos retidos, o cabeçalho só conta os aparelhos', async () => {
    authUser.user.quietHours = { start: 22, end: 7 };
    horaAgora = 12;
    status({ devices: 2, held: 0 });
    render(wrap(<PushCard />));

    expect(await screen.findByText('2 aparelhos ligados')).toBeInTheDocument();
    expect(screen.queryByText(/silêncio até|em instantes/)).not.toBeInTheDocument();
  });
});

/** O que sai mesmo no silêncio (ADR 56): só para quem entrega trabalho, com a opção marcada ao ligar. */
describe('cartão de avisos: o que sai no silêncio', () => {
  it('ligar pela primeira vez, entregando trabalho, grava a janela com o prazo marcado e diz isso', async () => {
    const user = userEvent.setup();
    status({ deliversWork: true });
    render(wrap(<PushCard />));

    await user.click(quietToggle(await quietGroup()));

    expect(
      await screen.findByText(
        'Pronto: silêncio das 22:00 às 07:00, horário de Brasília. Ao fim chega um aviso só com o que ficou por ver; prazo vencido num trabalho que você entrega sai na hora (dá para desmarcar logo abaixo).',
      ),
    ).toBeInTheDocument();
    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({
      quietHours: { start: 22, end: 7 },
      quietPass: ['deadline'],
    });
    // A escolha é lida do que está gravado, não da sessão deste aparelho.
    expect(emailPreference).toHaveBeenCalledTimes(1);
  });

  it('com a sessão deste aparelho velha, ligar lê a escolha gravada e não troca um "nada" de outro aparelho', async () => {
    const user = userEvent.setup();
    status({ deliversWork: true });
    emailPreference.mockResolvedValue({ quietPass: [] });
    render(wrap(<PushCard />));

    await user.click(quietToggle(await quietGroup()));

    expect(
      await screen.findByText(
        'Pronto: silêncio das 22:00 às 07:00, horário de Brasília. Ao fim chega um aviso só com o que ficou por ver.',
      ),
    ).toBeInTheDocument();
    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    expect(emailPreference).toHaveBeenCalledTimes(1);
  });

  it('ligar com uma escolha já feita (o prazo) mantém a escolha e diz o que sai', async () => {
    const user = userEvent.setup();
    authUser.user.quietPass = ['deadline'];
    status({ deliversWork: true });
    render(wrap(<PushCard />));

    await user.click(quietToggle(await quietGroup()));

    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    expect(
      await screen.findByText(
        /Ao fim chega um aviso só com o que ficou por ver; prazo vencido num trabalho que você entrega sai na hora \(dá para desmarcar logo abaixo\)\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('quem só contrata não vê o grupo, nem a frase ao ligar', async () => {
    const user = userEvent.setup();
    authUser.user.quietPass = ['deadline'];
    status({ deliversWork: false });
    render(wrap(<PushCard />));

    await user.click(quietToggle(await quietGroup()));

    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 22, end: 7 } });
    expect(
      await screen.findByText(
        'Pronto: silêncio das 22:00 às 07:00, horário de Brasília. Ao fim chega um aviso só com o que ficou por ver.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Mesmo no silêncio, sai na hora' }),
    ).not.toBeInTheDocument();
    expect(emailPreference).not.toHaveBeenCalled();
  });

  it('quem só contrata, com a janela gravada, não vê o grupo nem a ressalva na dica', async () => {
    authUser.user.quietHours = { start: 22, end: 7 };
    status({ deliversWork: false });
    render(wrap(<PushCard />));

    const bloco = await quietGroup();
    expect(bloco).toHaveTextContent('Das 22:00 às 07:00 os avisos ficam guardados;');
    expect(bloco).not.toHaveTextContent('menos o que estiver marcado logo abaixo');
    expect(
      screen.queryByRole('group', { name: 'Mesmo no silêncio, sai na hora' }),
    ).not.toBeInTheDocument();
  });

  it('conta com a janela de antes (escolha nula) vê a caixa desmarcada; marcar grava o prazo', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    status({ deliversWork: true });
    render(wrap(<PushCard />));
    const grupo = await passGroup();
    const caixa = within(grupo).getByRole('checkbox', {
      name: 'Prazo vencido num trabalho que você entrega',
    });
    expect(caixa).not.toBeChecked();
    expect(caixa).toHaveAccessibleDescription(
      'Sai na hora, com a hora-limite para agir antes da mediação automática, e vai ao serviço de push com prioridade alta. O resto espera.',
    );
    expect(await quietGroup()).toHaveTextContent(
      'Das 22:00 às 07:00 os avisos ficam guardados, menos o que estiver marcado logo abaixo;',
    );

    await user.click(caixa);

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietPass: ['deadline'] });
    expect(
      await screen.findByText(
        'Pronto: prazo vencido num trabalho que você entrega sai na hora, mesmo no silêncio.',
      ),
    ).toBeInTheDocument();
    expect(authUser.refreshUser).toHaveBeenCalledTimes(1);
  });

  it('desmarcar grava nada e diz que o prazo vem primeiro no aviso do fim do silêncio', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 6 };
    authUser.user.quietPass = ['deadline'];
    status({ deliversWork: true });
    render(wrap(<PushCard />));
    const caixa = within(await passGroup()).getByRole('checkbox', {
      name: 'Prazo vencido num trabalho que você entrega',
    });
    expect(caixa).toBeChecked();

    await user.click(caixa);

    expect(updateEmailPreference).toHaveBeenCalledWith({ quietPass: [] });
    expect(
      await screen.findByText(
        'Pronto: prazo vencido num trabalho que você entrega também espera, e vem primeiro no aviso das 06:00.',
      ),
    ).toBeInTheDocument();
  });

  it('durante a gravação a caixa, as horas e o grupo ficam desabilitados, e voltam ao terminar', async () => {
    const user = userEvent.setup();
    authUser.user.quietHours = { start: 22, end: 7 };
    status({ deliversWork: true });
    let solta!: () => void;
    updateEmailPreference.mockImplementation(() => new Promise<void>((r) => (solta = r)));
    render(wrap(<PushCard />));
    const grupo = await passGroup();
    const bloco = await quietGroup();

    await user.click(within(grupo).getByRole('checkbox'));

    expect(grupo).toBeDisabled();
    expect(within(grupo).getByRole('checkbox')).toBeDisabled();
    expect(quietToggle(bloco)).toBeDisabled();
    expect(within(bloco).getByRole('combobox', { name: 'Início do silêncio' })).toBeDisabled();
    expect(within(bloco).getByRole('combobox', { name: 'Fim do silêncio' })).toBeDisabled();
    expect(screen.queryByText(/^Pronto:/)).not.toBeInTheDocument();
    expect(authUser.refreshUser).not.toHaveBeenCalled();

    solta();
    await waitFor(() => expect(grupo).not.toBeDisabled());
    expect(quietToggle(bloco)).toBeEnabled();
    expect(within(bloco).getByRole('combobox', { name: 'Início do silêncio' })).toBeEnabled();
  });
});
