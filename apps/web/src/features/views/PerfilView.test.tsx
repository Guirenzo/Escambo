import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ClientProfile,
  FreelancerProfile,
  MyProfiles,
  Paginated,
  Review,
} from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { PerfilView } from './PerfilView';

/**
 * Tela de Perfil: o formulário do freelancer (dados, agenda, localização), o do cliente, as
 * avaliações recebidas com resposta, e o que é enviado à API em cada "Salvar".
 */

// A tela inteira é renderizada a cada tecla: com a suíte toda em paralelo, 5 s ficam curtos.
vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  profilesMe: vi.fn(),
  putFreelancerProfile: vi.fn(),
  putClientProfile: vi.fn(),
  reviews: vi.fn(),
  respondReview: vi.fn(),
  uploadMedia: vi.fn(),
  // Cartões irmãos do Perfil (moderação, portfólio, e-mails, avisos, privacidade): só carregam.
  myModeration: vi.fn(),
  myPortfolio: vi.fn(),
  pushStatus: vi.fn(),
  exportRequests: vi.fn(),
  consents: vi.fn(),
  deletionRequests: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

const auth = vi.hoisted(() => ({
  user: {
    id: 7,
    ulid: 'u-marina',
    email: 'marina@escambo.test',
    role: 'freelancer',
    emailVerified: true,
    emailFrequency: 'instant',
    digestHour: 8,
    timezone: 'America/Manaus',
    timezoneChosen: true,
    quietHours: null,
    quietPass: null,
  },
  refreshUser: async () => undefined,
  logout: () => undefined,
}));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const freelancer = (o: Partial<FreelancerProfile> = {}): FreelancerProfile => ({
  fullName: 'Marina Alves',
  avatarUrl: null,
  bio: 'Marcas para pequenos negócios.',
  headline: 'Designer de marcas',
  city: 'Joinville',
  state: 'SC',
  latitude: -26.3045,
  longitude: -48.8487,
  isAvailable: true,
  availableDays: [3, 1],
  availablePeriods: { '1': ['morning'], '5': ['evening'] },
  availableNow: false,
  timezone: 'America/Manaus',
  responseTimeHours: 2,
  avgRating: 4.8,
  totalReviews: 12,
  totalContracts: 30,
  escamboScore: {
    score: 87,
    tier: 'top',
    breakdown: { quality: 96, experience: 81, socialProof: 72, responsiveness: 64 },
  },
  ...o,
});

const client = (o: Partial<ClientProfile> = {}): ClientProfile => ({
  fullName: 'Carlos Lima',
  avatarUrl: null,
  bio: null,
  city: 'Curitiba',
  state: 'PR',
  ...o,
});

const review = (o: Partial<Review> = {}): Review => ({
  id: 12,
  contractId: 40,
  reviewerId: 3,
  revieweeId: 7,
  rating: 4,
  comment: 'Bom trabalho, entregou no prazo.',
  response: null,
  createdAt: '2026-09-20T15:30:00.000Z',
  removedAt: null,
  ...o,
});

const reviews = (items: Review[]): Paginated<Review> => ({ items, page: 1, limit: 50 });

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PerfilView />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Os dois formulários repetem "Nome", "Cidade" e a foto: cada um é achado pelo seu botão. */
const formOf = (submit: string) =>
  within(screen.getByRole('button', { name: submit }).closest('form')!);
const freelancerForm = () => formOf('Salvar freelancer');
const clientForm = () => formOf('Salvar cliente');
/**
 * Espera o formulário já preenchido com o perfil: o preenchimento vem num efeito logo depois de o
 * formulário aparecer, e olhar os campos antes disso dá corrida (todo perfil de teste tem nome).
 */
const loaded = (form: typeof freelancerForm) =>
  waitFor(() => {
    const f = form();
    expect(f.getByLabelText('Nome')).not.toHaveValue('');
    return f;
  });

type Locate = (
  ok: (pos: { coords: { latitude: number; longitude: number } }) => void,
  fail: () => void,
  options: { timeout: number },
) => void;
const stubGeolocation = (getCurrentPosition: Locate): void => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  });
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.profilesMe.mockResolvedValue({ freelancer: freelancer(), client: null } satisfies MyProfiles);
  api.putFreelancerProfile.mockResolvedValue(freelancer());
  api.putClientProfile.mockResolvedValue(client());
  api.reviews.mockResolvedValue(reviews([]));
  api.respondReview.mockResolvedValue({ ok: true });
  api.myModeration.mockResolvedValue({ removals: [], strikes: {} });
  api.myPortfolio.mockResolvedValue([]);
  api.pushStatus.mockResolvedValue({
    publicKey: '',
    devices: 0,
    subscribed: false,
    held: 0,
    deliversWork: false,
  });
  api.exportRequests.mockResolvedValue([]);
  api.consents.mockResolvedValue([]);
  api.deletionRequests.mockResolvedValue([]);
});

afterEach(() => {
  delete (navigator as { geolocation?: unknown }).geolocation;
});

describe('PerfilView: carregamento', () => {
  it('enquanto o perfil não chega, mostra o título da tela e o esqueleto, sem formulário', () => {
    api.profilesMe.mockReturnValue(new Promise(() => undefined));
    renderView();
    expect(screen.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
    expect(screen.getByText('Como você aparece para clientes e freelancers.')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar freelancer' })).toBeNull();
    expect(document.title).toBe('Perfil · Escambo');
  });

  it('falha ao carregar: mostra o erro e "Tentar de novo" busca o perfil outra vez', async () => {
    const user = userEvent.setup({ delay: null });
    api.profilesMe.mockRejectedValueOnce(new Error('Sessão expirada'));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Sessão expirada');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('button', { name: 'Salvar freelancer' })).toBeVisible();
    expect(api.profilesMe).toHaveBeenCalledTimes(2);
  });
});

describe('PerfilView: o que a tela mostra para cada tipo de conta', () => {
  it('freelancer: o formulário chega preenchido com o perfil salvo, com score e portfólio', async () => {
    renderView();
    const form = await loaded(freelancerForm);
    expect(form.getByLabelText('Nome')).toHaveValue('Marina Alves');
    expect(form.getByLabelText('Headline')).toHaveValue('Designer de marcas');
    expect(form.getByLabelText('Bio')).toHaveValue('Marcas para pequenos negócios.');
    expect(form.getByLabelText('Cidade')).toHaveValue('Joinville');
    expect(form.getByLabelText('Estado (UF)')).toHaveValue('SC');
    expect(form.getByLabelText(/^Foto \(URL da imagem\)/)).toHaveValue('');
    expect(form.getByRole('switch', { name: 'Aceitando novos pedidos' })).toBeChecked();
    expect(form.getByText('Definida (-26.3045, -48.8487)')).toBeInTheDocument();

    const days = form.getByRole('group', { name: 'Dias em que você atende' });
    const pressed = within(days)
      .getAllByRole('button', { pressed: true })
      .map((b) => b.textContent);
    expect(pressed).toEqual(['seg', 'qua']);
    expect(within(days).getAllByRole('button')).toHaveLength(7);

    // Reputação: nota e contratos no cabeçalho, score detalhado por dimensão.
    const score = screen.getByRole('heading', { name: 'Escambo Score' }).closest('section')!;
    expect(within(score).getByRole('img', { name: '4.8 de 5, 12 avaliações' })).toBeVisible();
    expect(within(score).getByText(/· 30 contratos/)).toBeInTheDocument();
    expect(within(score).getByText('87')).toBeInTheDocument();
    expect(within(score).getByText('Responsividade').closest('li')).toHaveTextContent('64');

    expect(screen.getByRole('region', { name: 'Portfólio' })).toBeInTheDocument();
    // Sem perfil de cliente, o cartão do cliente não diz "ativo".
    expect(screen.queryByText('ativo')).toBeNull();
  });

  it('só cliente: preenche pelo perfil de cliente e não mostra score, avaliações nem portfólio', async () => {
    api.profilesMe.mockResolvedValue({ freelancer: null, client: client() });
    renderView();
    const form = await loaded(clientForm);
    expect(form.getByLabelText('Nome')).toHaveValue('Carlos Lima');
    expect(form.getByLabelText('Cidade')).toHaveValue('Curitiba');
    expect(screen.getByText('ativo')).toBeInTheDocument();

    expect(screen.queryByRole('heading', { name: 'Escambo Score' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Avaliações recebidas' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Portfólio' })).toBeNull();
    expect(api.reviews).not.toHaveBeenCalled();
    // O formulário de freelancer segue disponível para quem quiser virar freelancer.
    expect(freelancerForm().getByLabelText('Headline')).toHaveValue('');
    expect(freelancerForm().getByText('Não definida')).toBeInTheDocument();
  });

  it('com os dois perfis, o nome e a cidade que valem são os do perfil de freelancer', async () => {
    api.profilesMe.mockResolvedValue({ freelancer: freelancer(), client: client() });
    renderView();
    const form = await loaded(clientForm);
    expect(form.getByLabelText('Nome')).toHaveValue('Marina Alves');
    expect(form.getByLabelText('Cidade')).toHaveValue('Joinville');
    expect(screen.getByText('ativo')).toBeInTheDocument();
  });
});

describe('PerfilView: salvar o perfil de freelancer', () => {
  it('manda o que está na tela: UF em maiúsculas, URL da foto sem espaços e só os dias marcados', async () => {
    const user = userEvent.setup({ delay: null });
    renderView();
    const form = await loaded(freelancerForm);

    await user.clear(form.getByLabelText('Nome'));
    await user.type(form.getByLabelText('Nome'), 'Marina Lima');
    await user.type(form.getByLabelText(/^Foto \(URL da imagem\)/), ' https://img.test/m.jpg ');
    await user.clear(form.getByLabelText('Headline'));
    await user.type(form.getByLabelText('Headline'), 'Embalagens');
    await user.clear(form.getByLabelText('Bio'));
    await user.type(form.getByLabelText('Bio'), 'Rótulos.');
    await user.clear(form.getByLabelText('Cidade'));
    await user.type(form.getByLabelText('Cidade'), 'Curitiba');
    await user.clear(form.getByLabelText('Estado (UF)'));
    await user.type(form.getByLabelText('Estado (UF)'), 'pr');

    const days = form.getByRole('group', { name: 'Dias em que você atende' });
    await user.click(within(days).getByRole('button', { name: 'ter' })); // liga terça
    await user.click(within(days).getByRole('button', { name: 'qua' })); // desliga quarta
    await user.click(form.getByRole('button', { name: 'seg tarde' })); // liga
    await user.click(form.getByRole('button', { name: 'seg manhã' })); // desliga
    await user.click(form.getByRole('switch', { name: 'Aceitando novos pedidos' }));
    expect(
      form.getByText('Agenda pausada: você não aparece em "atende agora"'),
    ).toBeInTheDocument();

    await user.click(form.getByRole('button', { name: 'Salvar freelancer' }));

    expect(api.putFreelancerProfile).toHaveBeenCalledTimes(1);
    expect(api.putFreelancerProfile).toHaveBeenCalledWith({
      fullName: 'Marina Lima',
      avatarUrl: 'https://img.test/m.jpg',
      headline: 'Embalagens',
      bio: 'Rótulos.',
      city: 'Curitiba',
      state: 'PR',
      latitude: -26.3045,
      longitude: -48.8487,
      availableDays: [1, 2],
      // O período guardado da sexta (dia não marcado) não vai; terça sem período = o dia todo.
      availablePeriods: { '1': ['afternoon'], '2': [] },
      isAvailable: false,
    });
    expect(api.putClientProfile).not.toHaveBeenCalled();
    expect(await screen.findByText('Perfil de freelancer salvo!')).toBeInTheDocument();
  });

  it('depois de salvar, o perfil é buscado de novo e o formulário mostra o que o servidor guardou', async () => {
    const user = userEvent.setup({ delay: null });
    api.profilesMe
      .mockResolvedValueOnce({ freelancer: freelancer(), client: null })
      // O servidor normaliza o que recebeu (aqui, a chamada sem espaços duplicados).
      .mockResolvedValue({
        freelancer: freelancer({ headline: 'Designer de embalagens' }),
        client: null,
      });
    renderView();
    const form = await loaded(freelancerForm);
    await user.clear(form.getByLabelText('Headline'));
    await user.type(form.getByLabelText('Headline'), 'Designer  de   embalagens');
    await user.click(form.getByRole('button', { name: 'Salvar freelancer' }));

    await waitFor(() =>
      expect(form.getByLabelText('Headline')).toHaveValue('Designer de embalagens'),
    );
    expect(api.profilesMe).toHaveBeenCalledTimes(2);
  });

  it('UF e foto em branco vão como null', async () => {
    const user = userEvent.setup({ delay: null });
    renderView();
    const form = await loaded(freelancerForm);
    await user.clear(form.getByLabelText('Estado (UF)'));
    await user.type(form.getByLabelText('Estado (UF)'), ' ');
    await user.type(form.getByLabelText(/^Foto \(URL da imagem\)/), '  ');
    await user.click(form.getByRole('button', { name: 'Salvar freelancer' }));
    expect(api.putFreelancerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ state: null, avatarUrl: null, fullName: 'Marina Alves' }),
    );
  });

  it('recusa da API: mostra a mensagem dela e não diz que salvou', async () => {
    const user = userEvent.setup({ delay: null });
    api.putFreelancerProfile.mockRejectedValue(new Error('Estado inválido'));
    renderView();
    const form = await loaded(freelancerForm);
    await user.click(form.getByRole('button', { name: 'Salvar freelancer' }));
    expect(await screen.findByText('Estado inválido')).toBeInTheDocument();
    expect(screen.queryByText('Perfil de freelancer salvo!')).toBeNull();
  });

  it('enquanto salva, o botão fica desabilitado', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (p: FreelancerProfile) => void = () => undefined;
    api.putFreelancerProfile.mockReturnValue(
      new Promise<FreelancerProfile>((resolve) => {
        finish = resolve;
      }),
    );
    renderView();
    const form = await loaded(freelancerForm);
    const save = form.getByRole('button', { name: 'Salvar freelancer' });
    await user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await act(async () => finish(freelancer()));
    await waitFor(() => expect(save).toBeEnabled());
  });
});

describe('PerfilView: agenda de atendimento', () => {
  it('sem dia marcado, avisa que fica fora do filtro e não mostra períodos', async () => {
    const user = userEvent.setup({ delay: null });
    api.profilesMe.mockResolvedValue({
      freelancer: freelancer({ availableDays: null, availablePeriods: null }),
      client: null,
    });
    renderView();
    const form = await loaded(freelancerForm);
    const hint = 'Sem dias marcados, você fica fora do filtro "atende no dia" da busca.';
    expect(form.getByText(hint)).toBeInTheDocument();
    expect(form.queryByRole('button', { name: /manhã$/ })).toBeNull();

    await user.click(form.getByRole('button', { name: 'sáb' }));
    expect(form.queryByText(hint)).toBeNull();
    expect(form.getByRole('button', { name: 'sáb', pressed: true })).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'sáb noite', pressed: false })).toBeInTheDocument();
  });

  it('os períodos aparecem por dia, na ordem da semana, e dizem em que fuso valem', async () => {
    const user = userEvent.setup({ delay: null });
    renderView();
    const form = await loaded(freelancerForm);
    // O perfil salvo traz [qua, seg]: a grade mostra segunda antes de quarta.
    expect(form.getAllByRole('button', { name: / manhã$/ }).map((b) => b.ariaLabel)).toEqual([
      'seg manhã',
      'qua manhã',
    ]);
    expect(form.getByRole('button', { name: 'seg manhã' })).toHaveAttribute('aria-pressed', 'true');
    expect(form.getByRole('button', { name: 'qua manhã' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(
      form.getByText(/no horário de Manaus, o fuso da sua conta \(muda em "E-mails do Escambo"\)/),
    ).toBeInTheDocument();

    await user.click(form.getByRole('button', { name: 'qua noite' }));
    expect(form.getByRole('button', { name: 'qua noite' })).toHaveAttribute('aria-pressed', 'true');
    // Marcar um período de quarta não mexe nos de segunda.
    expect(form.getByRole('button', { name: 'seg noite' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('PerfilView: localização', () => {
  it('navegador sem geolocalização: avisa e não muda nada', async () => {
    const user = userEvent.setup({ delay: null });
    renderView();
    const form = await loaded(freelancerForm);
    await user.click(form.getByRole('button', { name: 'Usar minha localização' }));
    expect(await screen.findByText('Seu navegador não oferece geolocalização')).toBeVisible();
    expect(form.getByText('Definida (-26.3045, -48.8487)')).toBeInTheDocument();
  });

  it('pede a posição com limite de 8 s, mostra "Localizando…" e salva a posição obtida', async () => {
    const user = userEvent.setup({ delay: null });
    const locate = vi.fn<Locate>();
    stubGeolocation(locate);
    renderView();
    const form = await loaded(freelancerForm);
    await user.click(form.getByRole('button', { name: 'Usar minha localização' }));

    expect(locate).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      timeout: 8000,
    });
    expect(form.getByRole('button', { name: 'Localizando…' })).toBeDisabled();

    act(() => locate.mock.calls[0]![0]({ coords: { latitude: -25.42841, longitude: -49.27329 } }));
    expect(form.getByText('Definida (-25.4284, -49.2733)')).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Usar minha localização' })).toBeEnabled();

    await user.click(form.getByRole('button', { name: 'Salvar freelancer' }));
    expect(api.putFreelancerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: -25.42841, longitude: -49.27329 }),
    );
  });

  it('posição negada: avisa, libera o botão e mantém "Não definida"', async () => {
    const user = userEvent.setup({ delay: null });
    stubGeolocation((_ok, fail) => fail());
    api.profilesMe.mockResolvedValue({
      freelancer: freelancer({ latitude: null, longitude: null }),
      client: null,
    });
    renderView();
    const form = await loaded(freelancerForm);
    expect(form.getByText('Não definida')).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Usar minha localização' }));
    expect(await screen.findByText('Não consegui obter sua localização')).toBeVisible();
    expect(form.getByRole('button', { name: 'Usar minha localização' })).toBeEnabled();
    expect(form.getByText('Não definida')).toBeInTheDocument();
  });
});

describe('PerfilView: perfil de cliente e foto', () => {
  it('salvar cliente manda só nome, cidade e foto', async () => {
    const user = userEvent.setup({ delay: null });
    api.profilesMe.mockResolvedValue({ freelancer: null, client: client() });
    renderView();
    const form = await loaded(clientForm);
    await user.clear(form.getByLabelText('Cidade'));
    await user.type(form.getByLabelText('Cidade'), 'Londrina');
    await user.type(
      form.getByLabelText(/^Foto \(URL da imagem\)/),
      ' https://img.test/carlos.jpg ',
    );
    await user.click(form.getByRole('button', { name: 'Salvar cliente' }));

    expect(api.putClientProfile).toHaveBeenCalledWith({
      fullName: 'Carlos Lima',
      city: 'Londrina',
      avatarUrl: 'https://img.test/carlos.jpg',
    });
    expect(api.putFreelancerProfile).not.toHaveBeenCalled();
    expect(await screen.findByText('Perfil de cliente salvo!')).toBeInTheDocument();
  });

  it('nome, cidade e foto são os mesmos nos dois formulários', async () => {
    const user = userEvent.setup({ delay: null });
    renderView();
    const form = await loaded(clientForm);
    await user.clear(form.getByLabelText('Nome'));
    await user.type(form.getByLabelText('Nome'), 'Marina Souza');
    expect(freelancerForm().getByLabelText('Nome')).toHaveValue('Marina Souza');
  });

  it('recusa da API no perfil de cliente: mostra a mensagem dela', async () => {
    const user = userEvent.setup({ delay: null });
    api.putClientProfile.mockRejectedValue(new Error('Nome muito curto'));
    renderView();
    const form = await loaded(clientForm);
    await user.click(form.getByRole('button', { name: 'Salvar cliente' }));
    expect(await screen.findByText('Nome muito curto')).toBeInTheDocument();
    expect(screen.queryByText('Perfil de cliente salvo!')).toBeNull();
  });

  it('enquanto o perfil de cliente é salvo, o botão fica desabilitado', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: (p: ClientProfile) => void = () => undefined;
    api.putClientProfile.mockReturnValue(
      new Promise<ClientProfile>((resolve) => {
        finish = resolve;
      }),
    );
    api.profilesMe.mockResolvedValue({ freelancer: null, client: client() });
    renderView();
    const form = await loaded(clientForm);
    const save = form.getByRole('button', { name: 'Salvar cliente' });
    await user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    // O formulário do freelancer é outro envio: não trava junto.
    expect(freelancerForm().getByRole('button', { name: 'Salvar freelancer' })).toBeEnabled();
    await act(async () => finish(client()));
    await waitFor(() => expect(save).toBeEnabled());
    expect(await screen.findByText('Perfil de cliente salvo!')).toBeInTheDocument();
  });

  it('foto enviada do aparelho preenche o campo da URL e só vale depois de salvar', async () => {
    const user = userEvent.setup({ delay: null });
    api.uploadMedia.mockResolvedValue({ url: '/api/media/2026/10/foto.webp' });
    renderView();
    const form = await loaded(freelancerForm);
    const photo = new File(['png'], 'foto.png', { type: 'image/png' });
    await user.upload(form.getByTestId('avatar-upload'), photo);

    expect(api.uploadMedia).toHaveBeenCalledWith(photo, 'foto.png', 'avatar');
    expect(await screen.findByText('Foto enviada. Salve o perfil para aplicar.')).toBeVisible();
    expect(form.getByLabelText(/^Foto \(URL da imagem\)/)).toHaveValue(
      '/api/media/2026/10/foto.webp',
    );
    expect(api.putFreelancerProfile).not.toHaveBeenCalled();

    await user.click(form.getByRole('button', { name: 'Salvar freelancer' }));
    expect(api.putFreelancerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: '/api/media/2026/10/foto.webp' }),
    );
  });

  it('foto enviada pelo formulário de cliente também preenche a URL', async () => {
    const user = userEvent.setup({ delay: null });
    api.uploadMedia.mockResolvedValue({ url: '/api/media/2026/10/cliente.webp' });
    api.profilesMe.mockResolvedValue({ freelancer: null, client: client() });
    renderView();
    const form = await loaded(clientForm);
    await user.upload(
      form.getByTestId('avatar-upload'),
      new File(['jpg'], 'eu.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByText('Foto enviada. Salve o perfil para aplicar.')).toBeVisible();
    await user.click(form.getByRole('button', { name: 'Salvar cliente' }));
    expect(api.putClientProfile).toHaveBeenCalledWith({
      fullName: 'Carlos Lima',
      city: 'Curitiba',
      avatarUrl: '/api/media/2026/10/cliente.webp',
    });
  });
});

describe('PerfilView: avaliações recebidas', () => {
  const received = () =>
    within(screen.getByRole('heading', { name: 'Avaliações recebidas' }).closest('section')!);

  it('busca as avaliações do usuário logado e mostra nota, data, comentário e a resposta já dada', async () => {
    api.reviews.mockResolvedValue(
      reviews([
        review({ id: 11, rating: 5, response: 'Obrigada pela confiança!' }),
        review({ id: 12, rating: 2, comment: null }),
      ]),
    );
    renderView();
    const answered = (await screen.findByText('Bom trabalho, entregou no prazo.')).closest('li')!;
    expect(api.reviews).toHaveBeenCalledWith(7);
    expect(within(answered).getByRole('img', { name: '5.0 de 5' })).toBeInTheDocument();
    expect(within(answered).getByText(dtm('2026-09-20T15:30:00.000Z'))).toBeInTheDocument();
    expect(within(answered).getByText('Sua resposta')).toBeInTheDocument();
    expect(within(answered).getByText('Obrigada pela confiança!')).toBeInTheDocument();
    // Respondida: não há como responder de novo.
    expect(within(answered).queryByRole('button', { name: 'Responder' })).toBeNull();

    const open = received().getByText('Sem comentário.').closest('li')!;
    expect(within(open).getByRole('img', { name: '2.0 de 5' })).toBeInTheDocument();
    expect(within(open).getByRole('button', { name: 'Responder' })).toBeDisabled();
  });

  it('responder publica o texto sem espaços nas pontas; em branco o botão não libera', async () => {
    const user = userEvent.setup({ delay: null });
    api.reviews.mockResolvedValue(reviews([review({ id: 12 })]));
    renderView();
    const input = await screen.findByLabelText('Resposta à avaliação');
    const button = received().getByRole('button', { name: 'Responder' });
    expect(button).toBeDisabled();
    await user.type(input, '   ');
    expect(button).toBeDisabled();
    await user.type(input, 'Obrigada! ');
    expect(button).toBeEnabled();
    await user.click(button);

    expect(api.respondReview).toHaveBeenCalledWith(12, 'Obrigada!');
    expect(await screen.findByText('Resposta publicada')).toBeInTheDocument();
  });

  it('enquanto publica, "Responder" trava; publicada, a resposta aparece no lugar do campo', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: () => void = () => undefined;
    api.respondReview.mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        finish = () => resolve({ ok: true });
      }),
    );
    api.reviews
      .mockResolvedValueOnce(reviews([review({ id: 12 })]))
      .mockResolvedValue(reviews([review({ id: 12, response: 'Obrigada!' })]));
    renderView();
    await user.type(await screen.findByLabelText('Resposta à avaliação'), 'Obrigada!');
    const button = received().getByRole('button', { name: 'Responder' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(api.respondReview).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(await received().findByText('Sua resposta')).toBeVisible();
    expect(received().getByText('Obrigada!')).toBeVisible();
    expect(received().queryByLabelText('Resposta à avaliação')).toBeNull();
  });

  it.todo(
    'sem avaliações, explica que elas chegam quando clientes aprovam as entregas (defeito: PerfilView.tsx:52 passa `empty` ao QueryState sem `isEmpty`, então o aviso nunca aparece e o cartão fica em branco)',
  );

  it('o rascunho é de cada avaliação: escrever numa não libera nem envia a outra', async () => {
    const user = userEvent.setup({ delay: null });
    api.reviews.mockResolvedValue(
      reviews([review({ id: 12, comment: 'Primeira' }), review({ id: 13, comment: 'Segunda' })]),
    );
    renderView();
    const first = (await screen.findByText('Primeira')).closest('li')!;
    const second = screen.getByText('Segunda').closest('li')!;
    await user.type(within(second).getByLabelText('Resposta à avaliação'), 'Valeu!');
    expect(within(first).getByRole('button', { name: 'Responder' })).toBeDisabled();
    expect(within(first).getByLabelText('Resposta à avaliação')).toHaveValue('');

    await user.keyboard('{Enter}');
    expect(api.respondReview).toHaveBeenCalledTimes(1);
    expect(api.respondReview).toHaveBeenCalledWith(13, 'Valeu!');
  });

  it('resposta recusada pela API: mostra o motivo', async () => {
    const user = userEvent.setup({ delay: null });
    api.reviews.mockResolvedValue(reviews([review({ id: 12 })]));
    api.respondReview.mockRejectedValue(new Error('Esta avaliação já foi respondida.'));
    renderView();
    await user.type(await screen.findByLabelText('Resposta à avaliação'), 'Obrigada!');
    await user.click(received().getByRole('button', { name: 'Responder' }));
    expect(await screen.findByText('Esta avaliação já foi respondida.')).toBeInTheDocument();
    expect(screen.queryByText('Resposta publicada')).toBeNull();
  });

  it('avaliações que não carregam: o erro fica no cartão, o formulário segue na tela e dá para tentar de novo', async () => {
    const user = userEvent.setup({ delay: null });
    api.reviews.mockRejectedValueOnce(new Error('Avaliações indisponíveis'));
    api.reviews.mockResolvedValue(reviews([review({ id: 12 })]));
    renderView();
    await screen.findByRole('heading', { name: 'Avaliações recebidas' });
    const alert = await received().findByRole('alert');
    expect(alert).toHaveTextContent('Avaliações indisponíveis');
    expect(screen.getByRole('button', { name: 'Salvar freelancer' })).toBeVisible();

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await received().findByText('Bom trabalho, entregou no prazo.')).toBeVisible();
    expect(api.reviews).toHaveBeenCalledTimes(2);
    expect(api.reviews).toHaveBeenLastCalledWith(7);
  });
});
