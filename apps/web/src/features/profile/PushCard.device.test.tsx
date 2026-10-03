import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PushStatus, PushSubscriptionRequest } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushCard } from './PushCard';
import { ToastProvider } from '../../lib/toast';

/**
 * Avisos no navegador (ADR 52), a parte que depende do aparelho: ligar, desligar e mandar o aviso
 * de teste. O "não perturbe" está em PushCard.test.tsx. Aqui o navegador é de mentira na borda
 * (service worker, PushManager e Notification) e o lib/push de verdade roda por cima dele; a API de
 * mentira guarda quais aparelhos esta conta ligou.
 */

const ENDPOINT = 'https://push.exemplo.test/aparelho-novo';
const ENDPOINT_KEY = 'escambo.push.endpoint';

const pushStatus = vi.fn();
const pushSubscribe = vi.fn();
const pushUnsubscribe = vi.fn();
const pushTest = vi.fn();
const updateEmailPreference = vi.fn();
const emailPreference = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    pushStatus: (endpoint?: string) => pushStatus(endpoint),
    pushSubscribe: (body: unknown) => pushSubscribe(body),
    pushUnsubscribe: (endpoint: string) => pushUnsubscribe(endpoint),
    pushTest: (...args: unknown[]) => pushTest(...args),
    updateEmailPreference: (body: unknown) => updateEmailPreference(body),
    emailPreference: () => emailPreference(),
  },
}));

const auth = {
  user: {
    id: 1,
    role: 'freelancer',
    timezone: 'America/Sao_Paulo',
    quietHours: null as { start: number; end: number } | null,
    quietPass: null as 'deadline'[] | null,
  },
  refreshUser: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

/** O que a API sabe: a chave para assinar e os aparelhos que esta conta ligou. */
const server = {
  publicKey: 'BChave',
  endpoints: new Set<string>(),
  deliversWork: false,
};

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
}

/** O que o navegador sabe: a permissão, o que a pessoa responde ao pedido e a assinatura dele. */
const device = {
  permission: 'default' as NotificationPermission,
  answer: 'granted' as NotificationPermission,
  subscription: null as FakeSubscription | null,
};

const subscriptionAt = (endpoint: string): FakeSubscription => ({
  endpoint,
  options: { applicationServerKey: null },
  unsubscribe: vi.fn(async () => {
    device.subscription = null;
    return true;
  }),
  toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-de-teste', auth: 'auth-de-teste' } }),
});

const pushManager = {
  getSubscription: vi.fn(async () => device.subscription),
  subscribe: vi.fn(async (_options: unknown) => {
    device.subscription = subscriptionAt(ENDPOINT);
    return device.subscription;
  }),
};
const registration = { pushManager };
const serviceWorker = {
  register: vi.fn(async (_url: string) => registration),
  ready: Promise.resolve(registration),
  getRegistration: vi.fn(async () => registration),
};
const requestPermission = vi.fn(async () => {
  device.permission = device.answer;
  return device.answer;
});

/** Dá ao jsdom o que um navegador com push tem. Sem chamar isto, o cartão cai em "sem suporte". */
function browserWithPush(): void {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    get permission() {
      return device.permission;
    },
    requestPermission,
  });
}

/** Este aparelho já ligado nesta conta: assinatura no navegador e registrada na API. */
function deviceAlreadyOn(): FakeSubscription {
  device.permission = 'granted';
  device.subscription = subscriptionAt(ENDPOINT);
  server.endpoints.add(ENDPOINT);
  localStorage.setItem(ENDPOINT_KEY, ENDPOINT);
  return device.subscription;
}

const wrap = (ui: ReactNode) => <ToastProvider>{ui}</ToastProvider>;

const turnOn = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: 'Ligar avisos neste aparelho' });
const turnOff = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: 'Desligar neste aparelho' });
const sendTest = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: 'Enviar aviso de teste' });
const devices = (): HTMLElement => screen.getByText(/aparelhos? ligados?/);

beforeEach(() => {
  server.publicKey = 'BChave';
  server.endpoints = new Set();
  server.deliversWork = false;
  device.permission = 'default';
  device.answer = 'granted';
  device.subscription = null;
  localStorage.clear();
  auth.user.quietHours = null;
  auth.user.quietPass = null;
  auth.user.timezone = 'America/Sao_Paulo';
  auth.refreshUser.mockClear();
  for (const fn of [
    pushManager.getSubscription,
    pushManager.subscribe,
    serviceWorker.register,
    serviceWorker.getRegistration,
    requestPermission,
  ]) {
    fn.mockClear();
  }
  pushStatus.mockReset();
  pushStatus.mockImplementation(async (endpoint?: string): Promise<PushStatus> => ({
    publicKey: server.publicKey,
    devices: server.endpoints.size,
    subscribed: endpoint !== undefined && server.endpoints.has(endpoint),
    held: 0,
    deliversWork: server.deliversWork,
  }));
  pushSubscribe.mockReset();
  pushSubscribe.mockImplementation(async (body: PushSubscriptionRequest) => {
    server.endpoints.add(body.endpoint);
    return { devices: server.endpoints.size };
  });
  pushUnsubscribe.mockReset();
  pushUnsubscribe.mockImplementation(async (endpoint: string) => {
    server.endpoints.delete(endpoint);
  });
  pushTest.mockReset();
  pushTest.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  updateEmailPreference.mockReset();
  updateEmailPreference.mockResolvedValue(undefined);
  emailPreference.mockReset();
  emailPreference.mockImplementation(async () => ({ quietPass: auth.user.quietPass }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('cartão de avisos: o que cada situação do aparelho mostra', () => {
  it('navegador sem push: explica que ele não recebe avisos e não oferece botão', async () => {
    server.endpoints = new Set([
      'https://push.exemplo.test/outro-1',
      'https://push.exemplo.test/outro-2',
    ]);
    render(wrap(<PushCard />));

    expect(
      await screen.findByText(
        'Este navegador não recebe avisos do Escambo. Os e-mails e a lista de notificações continuam funcionando normalmente.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /neste aparelho|aviso de teste/ })).toBeNull();
    // Os aparelhos da conta que já recebem continuam contados.
    await waitFor(() => expect(devices()).toHaveTextContent('2 aparelhos ligados'));
    // Sem assinatura para consultar, a pergunta vai sem endereço de aparelho.
    expect(pushStatus).toHaveBeenCalledWith(undefined);
  });

  it('navegador com push e sem assinatura: explica o que chega, avisa do serviço de push e oferece ligar', async () => {
    browserWithPush();
    render(wrap(<PushCard />));

    expect(await turnOn()).toBeEnabled();
    expect(
      screen.getByText(
        /Contratações, entregas, disputas e saques chegam neste aparelho, mesmo com a aba fechada\./,
      ),
    ).toHaveTextContent(
      'Os avisos passam pelo serviço de push do seu navegador (Google, Mozilla, Microsoft ou Apple), fora do Brasil',
    );
    expect(devices()).toHaveTextContent('0 aparelhos ligados');
    expect(screen.queryByRole('button', { name: 'Desligar neste aparelho' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar aviso de teste' })).toBeNull();
    // Sem aparelho ligado e sem janela gravada não há o que silenciar.
    expect(screen.queryByRole('group', { name: 'Não perturbe' })).not.toBeInTheDocument();
  });

  it('permissão bloqueada no navegador: manda liberar nas configurações, sem botão', async () => {
    browserWithPush();
    device.permission = 'denied';
    render(wrap(<PushCard />));

    expect(
      await screen.findByText(
        'Os avisos estão bloqueados para o Escambo nas configurações do navegador. Libere a permissão de notificações do site e volte aqui.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ligar avisos neste aparelho' })).toBeNull();
  });

  it('aparelho já ligado nesta conta: oferece desligar e o aviso de teste, e conta o aparelho', async () => {
    browserWithPush();
    deviceAlreadyOn();
    render(wrap(<PushCard />));

    expect(await turnOff()).toBeEnabled();
    expect(await sendTest()).toBeEnabled();
    expect(devices()).toHaveTextContent('1 aparelho ligado');
    expect(screen.queryByRole('button', { name: 'Ligar avisos neste aparelho' })).toBeNull();
    // A consulta leva o endereço deste aparelho, para a API dizer se ele é desta conta.
    expect(pushStatus).toHaveBeenCalledWith(ENDPOINT);
  });

  it('aparelho emprestado (assinatura de outra conta): oferece ligar, não desligar', async () => {
    browserWithPush();
    device.permission = 'granted';
    device.subscription = subscriptionAt('https://push.exemplo.test/de-outra-pessoa');
    render(wrap(<PushCard />));

    expect(await turnOn()).toBeEnabled();
    expect(pushStatus).toHaveBeenCalledWith('https://push.exemplo.test/de-outra-pessoa');
    expect(screen.queryByRole('button', { name: 'Desligar neste aparelho' })).toBeNull();
  });
});

describe('cartão de avisos: ligar neste aparelho', () => {
  it('pede a permissão, assina com a chave da API, registra o aparelho e confirma', async () => {
    const user = userEvent.setup();
    browserWithPush();
    render(wrap(<PushCard />));

    await user.click(await turnOn());

    expect(await screen.findByText('Pronto: este aparelho vai avisar você.')).toBeInTheDocument();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js');
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(pushSubscribe).toHaveBeenCalledTimes(1);
    expect(pushSubscribe).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      p256dh: 'p256dh-de-teste',
      auth: 'auth-de-teste',
    });
    // O cartão passa a oferecer desligar e o teste, e conta o aparelho.
    expect(await turnOff()).toBeEnabled();
    expect(await sendTest()).toBeEnabled();
    expect(devices()).toHaveTextContent('1 aparelho ligado');
    // O endereço fica guardado para o sair da conta avisar a API.
    expect(localStorage.getItem(ENDPOINT_KEY)).toBe(ENDPOINT);
    // Com um aparelho ligado, o "não perturbe" aparece.
    expect(screen.getByRole('group', { name: 'Não perturbe' })).toBeInTheDocument();
  });

  it('enquanto liga, o botão fica travado', async () => {
    const user = userEvent.setup();
    browserWithPush();
    let solta!: (v: { devices: number }) => void;
    pushSubscribe.mockImplementation(
      (body: PushSubscriptionRequest) =>
        new Promise<{ devices: number }>((r) => {
          server.endpoints.add(body.endpoint);
          solta = r;
        }),
    );
    render(wrap(<PushCard />));

    await user.click(await turnOn());

    await waitFor(() => expect(pushSubscribe).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Ligar avisos neste aparelho' })).toBeDisabled();
    expect(screen.queryByText('Pronto: este aparelho vai avisar você.')).not.toBeInTheDocument();

    solta({ devices: 1 });
    expect(await turnOff()).toBeEnabled();
  });

  it('permissão negada na hora: diz que foi negada, não registra nada e passa a mandar liberar', async () => {
    const user = userEvent.setup();
    browserWithPush();
    device.answer = 'denied';
    render(wrap(<PushCard />));

    await user.click(await turnOn());

    expect(await screen.findByText('Permissão de avisos negada no navegador')).toBeInTheDocument();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushSubscribe).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Os avisos estão bloqueados para o Escambo nas configurações/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ligar avisos neste aparelho' })).toBeNull();
  });

  it('canal desligado no servidor na hora de ligar: diz isso sem pedir permissão, e o botão some', async () => {
    const user = userEvent.setup();
    browserWithPush();
    render(wrap(<PushCard />));
    const ligar = await turnOn();
    server.publicKey = '';

    await user.click(ligar);

    expect(
      await screen.findByText('Os avisos no navegador estão desligados no servidor'),
    ).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(pushSubscribe).not.toHaveBeenCalled();
    expect(await screen.findByText(/desligados neste servidor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ligar avisos neste aparelho' })).toBeNull();
  });

  it('consulta que falha na hora de ligar: mostra o erro de verdade e o botão continua lá', async () => {
    const user = userEvent.setup();
    browserWithPush();
    pushStatus.mockRejectedValue(new Error('rede fora do ar'));
    render(wrap(<PushCard />));

    await user.click(await turnOn());

    expect(await screen.findByText('rede fora do ar')).toBeInTheDocument();
    expect(pushSubscribe).not.toHaveBeenCalled();
    expect(screen.queryByText(/desligados neste servidor/)).not.toBeInTheDocument();
    await waitFor(async () => expect(await turnOn()).toBeEnabled());
  });

  it('falha sem mensagem ao ligar cai no texto padrão', async () => {
    const user = userEvent.setup();
    browserWithPush();
    pushSubscribe.mockRejectedValue('sem rede');
    render(wrap(<PushCard />));

    await user.click(await turnOn());

    expect(await screen.findByText('Não foi possível ligar os avisos')).toBeInTheDocument();
  });
});

describe('cartão de avisos: desligar neste aparelho', () => {
  it('avisa a API, desfaz a assinatura do navegador, esquece o endereço e confirma', async () => {
    const user = userEvent.setup();
    browserWithPush();
    const subscription = deviceAlreadyOn();
    render(wrap(<PushCard />));

    await user.click(await turnOff());

    expect(await screen.findByText('Avisos desligados neste aparelho.')).toBeInTheDocument();
    expect(pushUnsubscribe).toHaveBeenCalledTimes(1);
    expect(pushUnsubscribe).toHaveBeenCalledWith(ENDPOINT);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ENDPOINT_KEY)).toBeNull();
    expect(await turnOn()).toBeEnabled();
    expect(devices()).toHaveTextContent('0 aparelhos ligados');
    expect(screen.queryByRole('button', { name: 'Enviar aviso de teste' })).toBeNull();
  });

  it('se a API já não conhece a assinatura, o aparelho para de receber do mesmo jeito', async () => {
    const user = userEvent.setup();
    browserWithPush();
    const subscription = deviceAlreadyOn();
    pushUnsubscribe.mockRejectedValue(new Error('Assinatura não encontrada'));
    render(wrap(<PushCard />));

    await user.click(await turnOff());

    expect(await screen.findByText('Avisos desligados neste aparelho.')).toBeInTheDocument();
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ENDPOINT_KEY)).toBeNull();
    expect(screen.queryByText('Assinatura não encontrada')).not.toBeInTheDocument();
    expect(await turnOn()).toBeEnabled();
  });

  it('se o navegador não desfaz a assinatura, mostra o erro e o aparelho segue ligado', async () => {
    const user = userEvent.setup();
    browserWithPush();
    const subscription = deviceAlreadyOn();
    subscription.unsubscribe.mockRejectedValue(new Error('O navegador não desfez a assinatura'));
    render(wrap(<PushCard />));

    await user.click(await turnOff());

    expect(await screen.findByText('O navegador não desfez a assinatura')).toBeInTheDocument();
    expect(screen.queryByText('Avisos desligados neste aparelho.')).not.toBeInTheDocument();
    // O endereço guardado não é esquecido se a assinatura continua viva.
    expect(localStorage.getItem(ENDPOINT_KEY)).toBe(ENDPOINT);
    await waitFor(async () => expect(await turnOff()).toBeEnabled());
  });

  it('falha sem mensagem ao desligar cai no texto padrão', async () => {
    const user = userEvent.setup();
    browserWithPush();
    const subscription = deviceAlreadyOn();
    subscription.unsubscribe.mockRejectedValue('falhou');
    render(wrap(<PushCard />));

    await user.click(await turnOff());

    expect(await screen.findByText('Não foi possível desligar')).toBeInTheDocument();
  });
});

describe('cartão de avisos: aviso de teste', () => {
  it.each([
    [2, 'Aviso de teste enviado para 2 aparelhos.'],
    [1, 'Aviso de teste enviado para 1 aparelho.'],
    [0, 'Nenhum aparelho ligado para receber o teste.'],
  ])('com %i entregue(s), a confirmação diz "%s"', async (sent, message) => {
    const user = userEvent.setup();
    browserWithPush();
    deviceAlreadyOn();
    pushTest.mockResolvedValue({ sent, removed: 0, failed: 0 });
    render(wrap(<PushCard />));

    await user.click(await sendTest());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(pushTest).toHaveBeenCalledTimes(1);
    expect(pushTest).toHaveBeenCalledWith();
  });

  it('depois do teste, a contagem é relida: aparelho que não recebe mais sai da conta', async () => {
    const user = userEvent.setup();
    browserWithPush();
    deviceAlreadyOn();
    server.endpoints.add('https://push.exemplo.test/aparelho-velho');
    // A API manda o teste e apaga a assinatura que o serviço de push disse que morreu.
    pushTest.mockImplementation(async () => {
      server.endpoints.delete('https://push.exemplo.test/aparelho-velho');
      return { sent: 1, removed: 1, failed: 0 };
    });
    render(wrap(<PushCard />));
    await waitFor(() => expect(devices()).toHaveTextContent('2 aparelhos ligados'));

    await user.click(await sendTest());

    expect(await screen.findByText('Aviso de teste enviado para 1 aparelho.')).toBeInTheDocument();
    expect(devices()).toHaveTextContent('1 aparelho ligado');
  });

  it('enquanto o teste é enviado, desligar e testar ficam travados', async () => {
    const user = userEvent.setup();
    browserWithPush();
    deviceAlreadyOn();
    let solta!: (v: { sent: number; removed: number; failed: number }) => void;
    pushTest.mockImplementation(() => new Promise((r) => (solta = r)));
    render(wrap(<PushCard />));

    await user.click(await sendTest());

    expect(screen.getByRole('button', { name: 'Enviar aviso de teste' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Desligar neste aparelho' })).toBeDisabled();

    solta({ sent: 1, removed: 0, failed: 0 });
    expect(await screen.findByText('Aviso de teste enviado para 1 aparelho.')).toBeInTheDocument();
    await waitFor(async () => expect(await sendTest()).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Desligar neste aparelho' })).toBeEnabled();
  });

  it('recusa da API no teste mostra a mensagem dela e libera os botões', async () => {
    const user = userEvent.setup();
    browserWithPush();
    deviceAlreadyOn();
    pushTest.mockRejectedValue(new Error('Muitos testes em pouco tempo: espere um minuto.'));
    render(wrap(<PushCard />));

    await user.click(await sendTest());

    expect(
      await screen.findByText('Muitos testes em pouco tempo: espere um minuto.'),
    ).toBeInTheDocument();
    await waitFor(async () => expect(await sendTest()).toBeEnabled());
  });

  it('falha sem mensagem no teste cai no texto padrão', async () => {
    const user = userEvent.setup();
    browserWithPush();
    deviceAlreadyOn();
    pushTest.mockRejectedValue('sem rede');
    render(wrap(<PushCard />));

    await user.click(await sendTest());

    expect(await screen.findByText('Não foi possível enviar o teste')).toBeInTheDocument();
  });
});

/** O "não perturbe" (ADR 54 e 56): o que PushCard.test.tsx ainda não confere. */
describe('cartão de avisos: gravar o silêncio', () => {
  const quiet = (): Promise<HTMLElement> => screen.findByRole('group', { name: 'Não perturbe' });

  beforeEach(() => {
    server.endpoints = new Set(['https://push.exemplo.test/outro-aparelho']);
  });

  it('trocar o início grava a janela inteira e confirma com o fuso da conta', async () => {
    const user = userEvent.setup();
    auth.user.quietHours = { start: 22, end: 7 };
    auth.user.timezone = 'America/Manaus';
    render(wrap(<PushCard />));
    const bloco = await quiet();

    expect(bloco).toHaveTextContent(
      'Horário de Manaus (o fuso se troca no cartão E-mails do Escambo).',
    );
    await user.selectOptions(
      within(bloco).getByRole('combobox', { name: 'Início do silêncio' }),
      '21',
    );

    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: { start: 21, end: 7 } });
    expect(
      await screen.findByText('Pronto: silêncio das 21:00 às 07:00, horário de Manaus.'),
    ).toBeInTheDocument();
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);
  });

  it('escolher de novo a mesma hora não grava', async () => {
    const user = userEvent.setup();
    auth.user.quietHours = { start: 22, end: 7 };
    render(wrap(<PushCard />));
    const bloco = await quiet();

    await user.selectOptions(
      within(bloco).getByRole('combobox', { name: 'Início do silêncio' }),
      '22',
    );
    await user.selectOptions(within(bloco).getByRole('combobox', { name: 'Fim do silêncio' }), '7');

    expect(updateEmailPreference).not.toHaveBeenCalled();
  });

  it('desligar o silêncio confirma que os avisos voltam a qualquer hora', async () => {
    const user = userEvent.setup();
    auth.user.quietHours = { start: 22, end: 7 };
    render(wrap(<PushCard />));
    const bloco = await quiet();

    await user.click(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );

    expect(updateEmailPreference).toHaveBeenCalledWith({ quietHours: null });
    expect(
      await screen.findByText('Pronto: os avisos voltam a bater a qualquer hora.'),
    ).toBeInTheDocument();
  });

  it('recusa da API ao gravar o silêncio: mostra a mensagem dela, não relê a sessão e libera a caixa', async () => {
    const user = userEvent.setup();
    updateEmailPreference.mockRejectedValue(new Error('Janela de silêncio inválida'));
    render(wrap(<PushCard />));
    const bloco = await quiet();
    const caixa = within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' });

    await user.click(caixa);

    expect(await screen.findByText('Janela de silêncio inválida')).toBeInTheDocument();
    expect(screen.queryByText(/^Pronto:/)).not.toBeInTheDocument();
    expect(auth.refreshUser).not.toHaveBeenCalled();
    await waitFor(() => expect(caixa).toBeEnabled());
    expect(caixa).not.toBeChecked();
  });

  it('falha sem mensagem ao gravar o silêncio cai no texto padrão', async () => {
    const user = userEvent.setup();
    updateEmailPreference.mockRejectedValue('sem rede');
    render(wrap(<PushCard />));

    await user.click(
      within(await quiet()).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    );

    expect(await screen.findByText('Não foi possível salvar o silêncio')).toBeInTheDocument();
  });

  it('falha sem mensagem ao gravar o que sai no silêncio tem o texto padrão dela', async () => {
    const user = userEvent.setup();
    auth.user.quietHours = { start: 22, end: 7 };
    server.deliversWork = true;
    updateEmailPreference.mockRejectedValue('sem rede');
    render(wrap(<PushCard />));

    const grupo = await screen.findByRole('group', { name: 'Mesmo no silêncio, sai na hora' });
    await user.click(
      within(grupo).getByRole('checkbox', { name: 'Prazo vencido num trabalho que você entrega' }),
    );

    expect(updateEmailPreference).toHaveBeenCalledWith({ quietPass: ['deadline'] });
    expect(
      await screen.findByText('Não foi possível salvar o que sai no silêncio'),
    ).toBeInTheDocument();
  });

  it('janela gravada em outro aparelho aparece mesmo num navegador sem push, para poder desligar', async () => {
    auth.user.quietHours = { start: 22, end: 7 };
    server.endpoints = new Set();
    render(wrap(<PushCard />));

    const bloco = await quiet();
    expect(
      within(bloco).getByRole('checkbox', { name: 'Silenciar os avisos num horário' }),
    ).toBeChecked();
    expect(screen.getByText(/Este navegador não recebe avisos do Escambo/)).toBeInTheDocument();
  });
});
