import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Consent, MyProfiles, PublicUser } from '@escambo/types';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { LEGAL_VERSIONS } from '../legal/content';
import { Shell } from './Shell';

/**
 * O app shell: navegação lateral, quem está logado, o contador de não lidas e a faixa do topo
 * (uma por vez, ADR 54). As consultas passam pelo TanStack Query de verdade; só a API, a sessão, o
 * socket e o fuso do aparelho são de mentira.
 */

const profilesMe = vi.fn();
const notifications = vi.fn();
const consents = vi.fn();
const resendVerification = vi.fn();
const updateEmailPreference = vi.fn();
const recordConsent = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    profilesMe: () => profilesMe(),
    notifications: () => notifications(),
    consents: () => consents(),
    resendVerification: () => resendVerification(),
    updateEmailPreference: (body: unknown) => updateEmailPreference(body),
    recordConsent: (body: unknown) => recordConsent(body),
  },
}));

const auth = {
  user: null as PublicUser | null,
  logout: vi.fn(),
  refreshUser: vi.fn(),
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

/** O socket da sala do usuário: o teste dispara o evento que o servidor mandaria. */
const socket = { on: vi.fn(), off: vi.fn() };
vi.mock('../../lib/socket', () => ({ getSocket: () => socket }));

const account = (o: Partial<PublicUser> = {}): PublicUser => ({
  id: 1,
  ulid: '01J0000000000000000000USER',
  email: 'conta@escambo.test',
  role: 'client',
  emailVerified: true,
  emailFrequency: 'instant',
  digestHour: 8,
  timezone: 'America/Sao_Paulo',
  timezoneChosen: true,
  quietHours: null,
  quietPass: null,
  ...o,
});

const consent = (type: Consent['type'], version: string): Consent => ({
  type,
  version,
  accepted: true,
  at: '2026-09-29T12:00:00.000Z',
});

/** Quem já respondeu às versões vigentes dos dois documentos: nenhuma faixa legal. */
const upToDate = (): Consent[] => [
  consent('privacy_policy', LEGAL_VERSIONS.privacidade),
  consent('terms_of_use', LEGAL_VERSIONS.termos),
];

const profiles = (o: {
  freelancer?: { fullName: string | null; avatarUrl?: string | null } | null;
  client?: { fullName: string | null; avatarUrl?: string | null } | null;
}): MyProfiles =>
  ({ freelancer: o.freelancer ?? null, client: o.client ?? null }) as unknown as MyProfiles;

const unread = (unreadCount: number) => ({ items: [], unreadCount, page: 1, limit: 20 });

/** O fuso que o navegador informa (a borda é o Intl, não a nossa tabela de fusos). */
let zoneSpy: MockInstance | null = null;
function deviceZone(timeZone: string): void {
  zoneSpy?.mockRestore();
  zoneSpy = vi
    .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);
}

function renderShell(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<p>conteúdo da home</p>} />
              <Route path="/carteira" element={<p>conteúdo da carteira</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  /** Espera uma consulta terminar (com dados ou com erro). */
  const querySettled = (
    key: 'consents' | 'notifications' | 'profiles',
    status: 'success' | 'error' = 'success',
  ) => waitFor(() => expect(client.getQueryState([key])?.status).toBe(status));
  const consentsSettled = (status: 'success' | 'error' = 'success') =>
    querySettled('consents', status);
  return { ...view, querySettled, consentsSettled };
}

/** Promessa que o teste solta quando quiser: para ver o shell enquanto a consulta está no ar. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const verifyReminder = () => screen.queryByText(/Confirme seu e-mail: enviamos um link para/);

beforeEach(() => {
  auth.user = account();
  auth.logout.mockReset();
  auth.refreshUser.mockReset();
  auth.refreshUser.mockResolvedValue(undefined);
  profilesMe.mockReset();
  profilesMe.mockResolvedValue(profiles({}));
  notifications.mockReset();
  notifications.mockResolvedValue(unread(0));
  consents.mockReset();
  consents.mockResolvedValue(upToDate());
  resendVerification.mockReset();
  resendVerification.mockResolvedValue({ sent: true });
  updateEmailPreference.mockReset();
  updateEmailPreference.mockResolvedValue({});
  recordConsent.mockReset();
  recordConsent.mockResolvedValue({});
  socket.on.mockReset();
  socket.off.mockReset();
  deviceZone('America/Sao_Paulo');
});

afterEach(() => {
  zoneSpy?.mockRestore();
  zoneSpy = null;
});

describe('Shell: navegação', () => {
  it('mostra as sete áreas do app, na ordem, cada uma com o seu endereço, e a tela da rota', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Início', '/'],
      ['Serviços', '/servicos'],
      ['Trocas', '/trocas'],
      ['Ranking', '/ranking'],
      ['Carteira', '/carteira'],
      ['Notificações', '/notificacoes'],
      ['Perfil', '/perfil'],
    ]);
    // Com a barra recolhida só o ícone aparece: a dica (title) repete o nome da área.
    expect(links.map((a) => a.getAttribute('title'))).toEqual([
      'Início',
      'Serviços',
      'Trocas',
      'Ranking',
      'Carteira',
      'Notificações',
      'Perfil',
    ]);
    expect(screen.getByRole('link', { name: 'Escambo' })).toHaveAttribute('href', '/');
    expect(screen.getByText('conteúdo da home')).toBeInTheDocument();
  });

  it('"Admin" só aparece para a conta de administrador: nem cliente nem freelancer veem', () => {
    const asClient = renderShell();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    asClient.unmount();

    auth.user = account({ role: 'freelancer' });
    renderShell();
    expect(screen.getByText('Freelancer')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('administrador vê o link do painel e o papel "Admin"', () => {
    auth.user = account({ role: 'admin' });
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    // Fora da navegação, "Admin" é o papel ao lado do nome.
    expect(screen.getAllByText('Admin').filter((el) => !nav.contains(el))).toHaveLength(1);
    expect(screen.queryByText('Cliente')).not.toBeInTheDocument();
  });

  it('marca a área da rota atual; "Início" só na raiz', () => {
    renderShell('/carteira');
    expect(screen.getByText('conteúdo da carteira')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Carteira' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Início' })).not.toHaveAttribute('aria-current');
    // A marca também leva à raiz, e também não se marca fora dela.
    expect(screen.getByRole('link', { name: 'Escambo' })).not.toHaveAttribute('aria-current');
  });

  it('na raiz, "Início" e a marca ficam marcados como a página atual, e só eles', () => {
    renderShell('/');
    expect(screen.getByRole('link', { name: 'Início' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Escambo' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Carteira' })).not.toHaveAttribute('aria-current');
    expect(
      screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page'),
    ).toHaveLength(2);
  });
});

describe('Shell: quem está logado', () => {
  it('enquanto o perfil não chega (ou sem nome), usa o começo do e-mail e a inicial dele', async () => {
    const pending = deferred<MyProfiles>();
    profilesMe.mockReturnValue(pending.promise);
    const { container, querySettled } = renderShell();
    await waitFor(() => expect(profilesMe).toHaveBeenCalledTimes(1));
    expect(screen.getByText('conta')).toHaveAttribute('title', 'conta@escambo.test');
    expect(screen.getByText('Cliente')).toBeInTheDocument();
    // Avatar decorativo (aria-hidden): sem foto, mostra a inicial.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('C')).toBeInTheDocument();

    // O perfil chega sem nome (cadastro recém-criado): continua o começo do e-mail.
    pending.resolve(profiles({ client: { fullName: null, avatarUrl: null } }));
    await querySettled('profiles');
    expect(screen.getByText('conta')).toHaveAttribute('title', 'conta@escambo.test');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('com perfil de freelancer, mostra o primeiro nome e a foto dele (vence o de cliente)', async () => {
    auth.user = account({ role: 'freelancer' });
    profilesMe.mockResolvedValue(
      profiles({
        freelancer: { fullName: 'Ana Souza Lima', avatarUrl: 'https://fotos.test/ana.png' },
        client: { fullName: 'Outra Pessoa', avatarUrl: 'https://fotos.test/outra.png' },
      }),
    );
    const { container } = renderShell();
    const name = await screen.findByText('Ana');
    expect(name).toHaveAttribute('title', 'conta@escambo.test');
    expect(screen.getByText('Freelancer')).toBeInTheDocument();
    expect(screen.queryByText('Outra')).not.toBeInTheDocument();
    // A foto é decorativa (alt vazio, aria-hidden): não tem papel acessível para procurar.
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://fotos.test/ana.png');
  });

  it('só com perfil de cliente, o nome e a foto vêm dele', async () => {
    profilesMe.mockResolvedValue(
      profiles({ client: { fullName: 'Bruno Lima', avatarUrl: 'https://fotos.test/bruno.png' } }),
    );
    const { container } = renderShell();
    expect(await screen.findByText('Bruno')).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://fotos.test/bruno.png');
  });

  it('"Sair" encerra a sessão, e só quando a pessoa clica', async () => {
    const user = userEvent.setup();
    const { querySettled } = renderShell();
    await querySettled('profiles');
    expect(auth.logout).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sair' }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('perfil e notificações fora do ar: o shell segue de pé, com o nome do e-mail e sem contador', async () => {
    profilesMe.mockRejectedValue(new Error('rede fora do ar'));
    notifications.mockRejectedValue(new Error('rede fora do ar'));
    const { container, querySettled } = renderShell();
    await querySettled('profiles', 'error');
    await querySettled('notifications', 'error');

    expect(screen.getByText('conta')).toHaveAttribute('title', 'conta@escambo.test');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByLabelText(/não lida/)).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getAllByRole('link')).toHaveLength(7);
    expect(screen.getByText('conteúdo da home')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sair' })).toBeEnabled();
  });
});

describe('Shell: contador de notificações', () => {
  it('sem não lidas, não há contador', async () => {
    renderShell();
    await waitFor(() => expect(notifications).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/não lida/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notificações' })).toBeInTheDocument();
  });

  it('uma não lida: singular', async () => {
    notifications.mockResolvedValue(unread(1));
    renderShell();
    expect(await screen.findByLabelText('1 não lida')).toHaveTextContent(/^1$/);
  });

  it('várias: plural, dentro do link de Notificações', async () => {
    notifications.mockResolvedValue(unread(7));
    renderShell();
    const badge = await screen.findByLabelText('7 não lidas');
    expect(badge).toHaveTextContent(/^7$/);
    // O leitor de tela ouve o contador junto do nome do link.
    expect(screen.getByRole('link', { name: /^Notificações\s*7 não lidas$/ })).toContainElement(
      badge,
    );
  });

  it('acima de 99 mostra "99+", mas o leitor de tela ouve o número certo', async () => {
    notifications.mockResolvedValue(unread(150));
    renderShell();
    expect(await screen.findByLabelText('150 não lidas')).toHaveTextContent(/^99\+$/);
  });

  it('o corte do "99+" é exato: 99 ainda aparece por extenso, 100 já vira "99+"', async () => {
    notifications.mockResolvedValue(unread(99));
    const first = renderShell();
    expect(await screen.findByLabelText('99 não lidas')).toHaveTextContent(/^99$/);
    first.unmount();

    notifications.mockResolvedValue(unread(100));
    renderShell();
    expect(await screen.findByLabelText('100 não lidas')).toHaveTextContent(/^99\+$/);
  });

  it('aviso que chega pelo socket vira toast e atualiza o contador sem esperar o polling', async () => {
    renderShell();
    await waitFor(() => expect(notifications).toHaveBeenCalledTimes(1));
    expect(socket.on).toHaveBeenCalledTimes(1);
    expect(socket.on).toHaveBeenCalledWith('notification:new', expect.any(Function));
    const onNotification = socket.on.mock.calls[0]![1] as (n: {
      type: string;
      title: string;
    }) => void;

    notifications.mockResolvedValue(unread(2));
    act(() => onNotification({ type: 'contract_created', title: 'Nova contratação recebida' }));

    expect(await screen.findByText('Nova contratação recebida')).toBeInTheDocument();
    expect(await screen.findByLabelText('2 não lidas')).toHaveTextContent(/^2$/);
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it('ao sair da tela, o shell para de ouvir o socket com a mesma função que registrou', () => {
    const { unmount } = renderShell();
    const onNotification = socket.on.mock.calls[0]![1] as unknown;
    expect(socket.off).not.toHaveBeenCalled();
    unmount();
    expect(socket.off).toHaveBeenCalledTimes(1);
    expect(socket.off).toHaveBeenCalledWith('notification:new', onNotification);
  });
});

describe('Shell: faixa do topo (uma por vez)', () => {
  it('tudo respondido, fuso escolhido e e-mail confirmado: nenhuma faixa', async () => {
    const { consentsSettled } = renderShell();
    await consentsSettled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(verifyReminder()).not.toBeInTheDocument();
  });

  it('e-mail não confirmado: lembra com o endereço da conta e oferece reenviar', async () => {
    auth.user = account({ emailVerified: false });
    const { consentsSettled } = renderShell();
    await consentsSettled();
    expect(verifyReminder()).toHaveTextContent(
      'Confirme seu e-mail: enviamos um link para conta@escambo.test.',
    );
    expect(screen.getByRole('button', { name: 'Reenviar e-mail' })).toBeEnabled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('"Reenviar e-mail" pede o reenvio uma vez, mostra "Reenviando…" e confirma com o endereço', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: false });
    let release!: (v: { sent: boolean }) => void;
    resendVerification.mockImplementation(
      () => new Promise<{ sent: boolean }>((r) => (release = r)),
    );
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail' }));

    const busy = screen.getByRole('button', { name: 'Reenviando…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(resendVerification).toHaveBeenCalledTimes(1);
    expect(resendVerification).toHaveBeenCalledWith();

    release({ sent: true });
    expect(await screen.findByText('Link reenviado para conta@escambo.test.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar e-mail' })).toBeEnabled();
  });

  it('reenvio recusado: mostra a mensagem da API e libera o botão', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: false });
    resendVerification.mockRejectedValue(new Error('Aguarde 1 minuto para reenviar.'));
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail' }));
    expect(await screen.findByText('Aguarde 1 minuto para reenviar.')).toBeInTheDocument();
    expect(screen.queryByText(/^Link reenviado para/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar e-mail' })).toBeEnabled();
  });

  it('reenvio que falha sem mensagem (não é um Error) cai no texto padrão', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: false });
    resendVerification.mockRejectedValue('offline');
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Reenviar e-mail' }));
    expect(await screen.findByText('Não foi possível reenviar')).toBeInTheDocument();
  });

  it('Política desatualizada vem primeiro: só a faixa dela, mesmo com fuso e e-mail pendentes', async () => {
    auth.user = account({ emailVerified: false, timezoneChosen: false });
    deviceZone('America/Manaus');
    consents.mockResolvedValue([consent('terms_of_use', LEGAL_VERSIONS.termos)]);
    renderShell();
    expect(
      await screen.findByRole('region', { name: 'Atualização da Política de Privacidade' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(verifyReminder()).not.toBeInTheDocument();
  });

  it('respondida a Política, o registro vai na versão vigente e a próxima faixa da fila (o fuso) toma o lugar', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: false, timezoneChosen: false });
    deviceZone('America/Manaus');
    consents.mockResolvedValueOnce([consent('terms_of_use', LEGAL_VERSIONS.termos)]);
    renderShell();
    const legal = await screen.findByRole('region', {
      name: 'Atualização da Política de Privacidade',
    });

    await user.click(within(legal).getByRole('button', { name: 'Li e aceito' }));
    expect(recordConsent).toHaveBeenCalledTimes(1);
    expect(recordConsent).toHaveBeenCalledWith({
      type: 'privacy_policy',
      version: LEGAL_VERSIONS.privacidade,
      accepted: true,
    });

    // A resposta invalida os consentimentos; a lista nova (padrão do teste: tudo em dia) chega e
    // a faixa legal dá lugar à seguinte, sem empilhar com o lembrete de e-mail.
    expect(
      await screen.findByRole('region', { name: 'Sugestão de fuso horário' }),
    ).toBeInTheDocument();
    expect(consents).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('region', { name: 'Atualização da Política de Privacidade' }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(verifyReminder()).not.toBeInTheDocument();
  });

  it('enquanto os consentimentos carregam não há faixa legal; chegando pendentes, a da Política aparece', async () => {
    const pending = deferred<Consent[]>();
    consents.mockReturnValue(pending.promise);
    renderShell();
    await waitFor(() => expect(consents).toHaveBeenCalledTimes(1));
    // Melhor calar do que pedir de novo a quem talvez já tenha respondido.
    expect(screen.queryByRole('region')).not.toBeInTheDocument();

    pending.resolve([]);
    expect(
      await screen.findByRole('region', { name: 'Atualização da Política de Privacidade' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });

  it('Política em dia e Termos desatualizados: a faixa informativa dos Termos', async () => {
    auth.user = account({ emailVerified: false });
    consents.mockResolvedValue([
      consent('privacy_policy', LEGAL_VERSIONS.privacidade),
      consent('terms_of_use', '1.0'),
    ]);
    renderShell();
    expect(
      await screen.findByRole('region', { name: 'Atualização dos Termos de Uso' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(verifyReminder()).not.toBeInTheDocument();
  });

  it('aparelho em outro fuso do Brasil e conta que nunca escolheu: sugere o fuso, antes do lembrete de e-mail', async () => {
    const user = userEvent.setup();
    auth.user = account({ emailVerified: false, timezoneChosen: false });
    deviceZone('America/Porto_Velho'); // marca a hora de Manaus
    const { consentsSettled } = renderShell();
    await consentsSettled();
    const region = screen.getByRole('region', { name: 'Sugestão de fuso horário' });
    expect(region).toHaveTextContent('Seu aparelho está no horário de Manaus');
    expect(verifyReminder()).not.toBeInTheDocument();

    await user.click(within(region).getByRole('button', { name: 'Usar horário de Manaus' }));
    expect(updateEmailPreference).toHaveBeenCalledTimes(1);
    expect(updateEmailPreference).toHaveBeenCalledWith({ timezone: 'America/Manaus' });
    // Gravado: a sessão recarrega (é ela que tira a faixa) e a pessoa lê a confirmação.
    expect(
      await screen.findByText('Pronto: sua conta agora usa o horário de Manaus.'),
    ).toBeInTheDocument();
    expect(auth.refreshUser).toHaveBeenCalledTimes(1);
    expect(auth.refreshUser).toHaveBeenCalledWith();
  });

  it('aparelho no mesmo fuso da conta, ou fora do Brasil: não sugere fuso', async () => {
    auth.user = account({ timezoneChosen: false });
    deviceZone('America/Recife'); // mesma hora de Brasília
    const first = renderShell();
    await first.consentsSettled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    first.unmount();

    deviceZone('Europe/Lisbon');
    const second = renderShell();
    await second.consentsSettled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('conta que já escolheu o fuso não recebe a sugestão, mesmo com o aparelho em outro', async () => {
    auth.user = account({ timezoneChosen: true });
    deviceZone('America/Manaus');
    const { consentsSettled } = renderShell();
    await consentsSettled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('consulta de consentimentos falhou: cala as faixas legais e segue para a próxima', async () => {
    auth.user = account({ emailVerified: false });
    consents.mockRejectedValue(new Error('rede fora do ar'));
    const { consentsSettled } = renderShell();
    await consentsSettled('error');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(verifyReminder()).toBeInTheDocument();
  });

  it('sem sessão (saindo), não há faixa nenhuma', async () => {
    auth.user = null;
    consents.mockResolvedValue([]);
    const { consentsSettled } = renderShell();
    await consentsSettled();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(verifyReminder()).not.toBeInTheDocument();
  });
});
