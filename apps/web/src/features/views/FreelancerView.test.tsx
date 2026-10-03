import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Favorite,
  Paginated,
  PortfolioItem,
  PublicFreelancerProfile,
  Review,
  Service,
} from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { FreelancerView } from './FreelancerView';

/**
 * Perfil público do freelancer: o que quem visita vê (reputação, agenda, portfólio, serviços e
 * avaliações) e o que pode fazer dali (favoritar, denunciar, contratar, propor troca, moderar).
 */

// Tela inteira com modais: com a suíte toda em paralelo, 5 s ficam curtos.
vi.setConfig({ testTimeout: 20_000 });

const api = vi.hoisted(() => ({
  publicFreelancer: vi.fn(),
  listServices: vi.fn(),
  reviews: vi.fn(),
  favorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  createReport: vi.fn(),
  adminModerateUser: vi.fn(),
  publicSettings: vi.fn(),
  wallet: vi.fn(),
  boostPlans: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api }));

interface Viewer {
  id: number;
  role: 'client' | 'freelancer' | 'admin';
  timezone: string;
}
const auth = vi.hoisted(() => ({ user: null as Viewer | null }));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

const MARINA = 7;
const VISITOR = 3;

const profile = (o: Partial<PublicFreelancerProfile> = {}): PublicFreelancerProfile => ({
  userId: MARINA,
  userUlid: 'u-marina',
  level: 4,
  levelName: 'Especialista',
  portfolio: [],
  fullName: 'Marina Alves',
  avatarUrl: null,
  bio: 'Marcas para pequenos negócios de Joinville.',
  headline: 'Designer de marcas',
  city: 'Joinville',
  state: 'SC',
  latitude: null,
  longitude: null,
  isAvailable: true,
  availableDays: [1, 2, 3, 4, 5],
  availablePeriods: null,
  availableNow: false,
  timezone: 'America/Sao_Paulo',
  responseTimeHours: null,
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

const service = (o: Partial<Service> = {}): Service => ({
  id: 21,
  categoryId: 1,
  ownerId: MARINA,
  title: 'Identidade visual',
  description: 'Logo, paleta e manual de uso.',
  priceType: 'fixed',
  price: 800,
  deliveryDays: 10,
  isRemote: true,
  isActive: true,
  createdAt: '2026-09-01T12:00:00.000Z',
  ...o,
});

const review = (o: Partial<Review> = {}): Review => ({
  id: 1,
  contractId: 40,
  reviewerId: VISITOR,
  revieweeId: MARINA,
  rating: 5,
  comment: 'Entregou antes do prazo.',
  response: null,
  createdAt: '2026-09-20T15:30:00.000Z',
  removedAt: null,
  ...o,
});

const page = <T,>(items: T[]): Paginated<T> => ({ items, page: 1, limit: 50 });

const work = (o: Partial<PortfolioItem>): PortfolioItem => ({
  id: 31,
  title: 'Logo Café Aurora',
  description: null,
  imageUrl: 'https://img.test/aurora.jpg',
  externalUrl: null,
  sortOrder: 0,
  ...o,
});

/** A rota em que o app está: o que o "voltar", a galeria e o "propor troca" mudam. */
function Where() {
  const l = useLocation();
  return <p data-testid="rota">{l.pathname + l.search}</p>;
}
/** A navegação do roteador é uma transição: a rota nova pode chegar um instante depois do clique. */
const expectRoute = (path: string) =>
  waitFor(() => expect(screen.getByTestId('rota').textContent).toBe(path));

function renderAt(entries: string[] = ['/freelancers/u-marina']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <Routes>
            <Route
              path="/freelancers/:ulid"
              element={
                <>
                  <FreelancerView />
                  <Where />
                </>
              }
            />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  auth.user = { id: VISITOR, role: 'client', timezone: 'America/Sao_Paulo' };
  api.publicFreelancer.mockResolvedValue(profile());
  api.listServices.mockResolvedValue(page([service()]));
  api.reviews.mockResolvedValue(page<Review>([]));
  api.favorites.mockResolvedValue([]);
  api.addFavorite.mockResolvedValue(undefined);
  api.removeFavorite.mockResolvedValue(undefined);
  api.createReport.mockResolvedValue({});
  api.adminModerateUser.mockResolvedValue(undefined);
  api.publicSettings.mockResolvedValue({ platformFeePercentage: 15, barterEnabled: true });
  api.wallet.mockResolvedValue({ balance: 1000, balancePending: 0, credits: 50 });
  api.boostPlans.mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe('FreelancerView: carregamento do perfil', () => {
  it('enquanto o perfil não chega, mostra o esqueleto e pede o perfil do ulid da rota', () => {
    api.publicFreelancer.mockReturnValue(new Promise(() => undefined));
    renderAt();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(api.publicFreelancer).toHaveBeenCalledWith('u-marina');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.title).toBe('Freelancer · Escambo');
    // Sem saber de quem é o perfil, ainda não há de quem buscar avaliações.
    expect(api.reviews).not.toHaveBeenCalled();
  });

  it.todo(
    'enquanto o perfil não chega, não busca serviços (defeito: useServices(undefined) não fica desligado e FreelancerView.tsx:50 lista os serviços de todo mundo sem filtro de dono)',
  );

  it('perfil que a API não acha: mostra o erro e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup({ delay: null });
    api.publicFreelancer.mockRejectedValueOnce(new Error('Freelancer não encontrado'));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Freelancer não encontrado');
    expect(screen.queryByRole('button', { name: 'Favoritar' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Marina Alves' })).toBeVisible();
    expect(api.publicFreelancer).toHaveBeenCalledTimes(2);
  });

  it('"Voltar" devolve a pessoa para a tela de onde ela veio', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt(['/servicos', '/freelancers/u-marina']);
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    await expectRoute('/servicos');
    expect(screen.queryByRole('heading', { name: 'Marina Alves' })).toBeNull();
  });
});

describe('FreelancerView: o que o visitante lê', () => {
  it('mostra nome, chamada, nível, cidade, contratos, nota, score e bio, e põe o nome na aba', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { level: 1, name: 'Marina Alves' })).toBeVisible();
    expect(screen.getByText('Designer de marcas')).toBeInTheDocument();
    expect(screen.getByText('Nível 4 · Especialista')).toBeInTheDocument();
    expect(screen.getByText('Joinville, SC')).toBeInTheDocument();
    expect(screen.getByText('30 contratos concluídos')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '4.8 de 5, 12 avaliações' })).toBeInTheDocument();
    expect(screen.getByText('Marcas para pequenos negócios de Joinville.')).toBeInTheDocument();
    // O selo aparece no topo e, detalhado, no cartão do Escambo Score.
    expect(screen.getAllByText('87')).toHaveLength(2);
    expect(screen.getAllByText('Top')).toHaveLength(2);
    const quality = screen.getByText('Qualidade').closest('li')!;
    expect(within(quality).getByText('96')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Marina Alves · Escambo'));
  });

  it('agenda: dias no fuso do freelancer só ganham a nota de fuso quando ele difere do de quem vê', async () => {
    api.publicFreelancer.mockResolvedValue(
      profile({
        timezone: 'America/Manaus',
        availablePeriods: {
          '1': ['morning', 'afternoon'],
          '2': ['morning', 'afternoon'],
          '3': ['morning', 'afternoon'],
          '4': ['morning', 'afternoon'],
          '5': ['morning', 'afternoon'],
        },
        availableNow: true,
        responseTimeHours: 2,
        isAvailable: false,
      }),
    );
    const { unmount } = renderAt();
    expect(
      await screen.findByText('atende seg a sex · manhã e tarde (horário de Manaus)'),
    ).toBeInTheDocument();
    expect(screen.getByText('atende agora')).toBeInTheDocument();
    expect(screen.getByText('responde em 2 h')).toBeInTheDocument();
    expect(screen.getByText('indisponível')).toBeInTheDocument();
    unmount();

    auth.user = { id: VISITOR, role: 'client', timezone: 'America/Manaus' };
    renderAt();
    expect(await screen.findByText('atende seg a sex · manhã e tarde')).toBeInTheDocument();
  });

  it('sem agenda, sem tempo de resposta, sem cidade e sem bio, essas linhas não aparecem', async () => {
    api.publicFreelancer.mockResolvedValue(
      // Lista de dias vazia conta como sem agenda.
      profile({ availableDays: [], city: null, state: null, bio: null, headline: null }),
    );
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Marina Alves' });
    expect(screen.queryByText(/^atende/)).toBeNull();
    expect(screen.queryByText(/responde em/)).toBeNull();
    expect(screen.queryByText('indisponível')).toBeNull();
    expect(screen.queryByText('Joinville, SC')).toBeNull();
    expect(screen.queryByText('Designer de marcas')).toBeNull();
    expect(screen.queryByText('Marcas para pequenos negócios de Joinville.')).toBeNull();
  });

  it('só a UF, sem cidade, ainda mostra onde o freelancer está', async () => {
    api.publicFreelancer.mockResolvedValue(profile({ city: null, state: 'SC' }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Marina Alves' });
    expect(screen.getByText('SC')).toBeInTheDocument();
  });

  it.todo(
    'sem serviços publicados, diz "Este freelancer ainda não publicou serviços." (defeito: FreelancerView.tsx:297 passa `empty` ao QueryState sem `isEmpty`, então o aviso nunca aparece e o cartão fica em branco)',
  );

  it.todo(
    'sem avaliações, diz "Nenhuma avaliação ainda." (defeito: FreelancerView.tsx:342 passa `empty` ao QueryState sem `isEmpty`, então o aviso nunca aparece e o cartão fica em branco)',
  );

  it('lista só os serviços do dono do perfil, sem repetir o nome dele no cartão', async () => {
    renderAt();
    expect(await screen.findByText('Identidade visual')).toBeInTheDocument();
    expect(api.listServices).toHaveBeenLastCalledWith({ ownerId: MARINA, limit: 50 });
    expect(screen.getByText('Logo, paleta e manual de uso.')).toBeInTheDocument();
    expect(screen.getByText('10 dias')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Marina Alves' })).toBeNull();
  });

  it('serviços que não carregam: o erro fica no cartão e dá para tentar de novo', async () => {
    const user = userEvent.setup({ delay: null });
    api.listServices.mockRejectedValue(new Error('Busca indisponível'));
    renderAt();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Busca indisponível');
    // O resto do perfil continua na tela.
    expect(screen.getByRole('heading', { level: 1, name: 'Marina Alves' })).toBeVisible();

    api.listServices.mockResolvedValue(page([service()]));
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Identidade visual')).toBeInTheDocument();
    expect(api.listServices).toHaveBeenLastCalledWith({ ownerId: MARINA, limit: 50 });
  });

  it('avaliações: nota, data, comentário (ou "Sem comentário.") e a resposta do freelancer', async () => {
    api.reviews.mockResolvedValue(
      page([
        review({ id: 1, response: 'Foi um prazer!' }),
        review({ id: 2, rating: 3, comment: null, createdAt: '2026-08-02T10:00:00.000Z' }),
      ]),
    );
    renderAt();
    const first = (await screen.findByText('Entregou antes do prazo.')).closest('li')!;
    expect(api.reviews).toHaveBeenCalledWith(MARINA);
    expect(within(first).getByRole('img', { name: '5.0 de 5' })).toBeInTheDocument();
    expect(within(first).getByText(dtm('2026-09-20T15:30:00.000Z'))).toBeInTheDocument();
    expect(within(first).getByText('Resposta do freelancer')).toBeInTheDocument();
    expect(within(first).getByText('Foi um prazer!')).toBeInTheDocument();

    const second = screen.getByText('Sem comentário.').closest('li')!;
    expect(within(second).getByRole('img', { name: '3.0 de 5' })).toBeInTheDocument();
    expect(within(second).queryByText('Resposta do freelancer')).toBeNull();
  });

  it('avaliações que não carregam: o erro fica no cartão e dá para tentar de novo', async () => {
    const user = userEvent.setup({ delay: null });
    api.reviews.mockRejectedValueOnce(new Error('Avaliações indisponíveis'));
    api.reviews.mockResolvedValue(page([review()]));
    renderAt();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Avaliações indisponíveis');
    // Os serviços, que carregaram, continuam na tela.
    expect(screen.getByText('Identidade visual')).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Entregou antes do prazo.')).toBeInTheDocument();
    expect(api.reviews).toHaveBeenCalledTimes(2);
    expect(api.reviews).toHaveBeenLastCalledWith(MARINA);
  });
});

describe('FreelancerView: favoritar', () => {
  it('favoritar manda o freelancer para os favoritos e o botão passa a "Favorito"', async () => {
    const user = userEvent.setup({ delay: null });
    const saved: Favorite = {
      id: 1,
      targetType: 'freelancer',
      targetId: MARINA,
      createdAt: '2026-10-01T12:00:00.000Z',
    };
    api.favorites.mockResolvedValueOnce([]).mockResolvedValue([saved]);
    renderAt();
    const button = await screen.findByRole('button', { name: 'Favoritar', pressed: false });
    await user.click(button);
    expect(api.addFavorite).toHaveBeenCalledWith({ targetType: 'freelancer', targetId: MARINA });
    expect(api.removeFavorite).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Favorito', pressed: true })).toBeVisible();
  });

  it('quem já favoritou vê "Favorito" e o clique desfaz', async () => {
    const user = userEvent.setup({ delay: null });
    api.favorites.mockResolvedValue([
      // Favorito de serviço com o mesmo número não conta como favorito do freelancer.
      { id: 1, targetType: 'service', targetId: MARINA, createdAt: '2026-10-01T12:00:00.000Z' },
      { id: 2, targetType: 'freelancer', targetId: MARINA, createdAt: '2026-10-01T12:00:00.000Z' },
    ]);
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Favorito', pressed: true }));
    expect(api.removeFavorite).toHaveBeenCalledWith('freelancer', MARINA);
    expect(api.addFavorite).not.toHaveBeenCalled();
  });

  it('enquanto o favorito é gravado, o botão fica desabilitado (sem clique duplo)', async () => {
    const user = userEvent.setup({ delay: null });
    let finish: () => void = () => undefined;
    api.addFavorite.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    renderAt();
    const button = await screen.findByRole('button', { name: 'Favoritar' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(api.addFavorite).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(button).toBeEnabled());
  });

  it.todo(
    'favoritar recusado pela API mostra o motivo (defeito: FreelancerView.tsx:148 chama toggleFav.mutate sem onError e useToggleFavorite não avisa: a falha é silenciosa)',
  );

  it('favorito de serviço com o mesmo id não marca o freelancer como favorito', async () => {
    api.favorites.mockResolvedValue([
      { id: 1, targetType: 'service', targetId: MARINA, createdAt: '2026-10-01T12:00:00.000Z' },
    ]);
    renderAt();
    expect(await screen.findByRole('button', { name: 'Favoritar', pressed: false })).toBeVisible();
  });

  it('no próprio perfil não há favoritar nem denunciar, e o serviço ganha "Impulsionar"', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: MARINA, role: 'freelancer', timezone: 'America/Sao_Paulo' };
    api.publicFreelancer.mockResolvedValue(
      profile({ avatarUrl: 'https://img.test/marina.jpg', portfolio: [work({})] }),
    );
    renderAt();
    await screen.findByText('Identidade visual');
    expect(screen.queryByRole('button', { name: /^Favorit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Denunciar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Contratar' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Impulsionar' }));
    const dialog = screen.getByRole('dialog', { name: 'Impulsionar: Identidade visual' });
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('FreelancerView: denúncia', () => {
  it('sem foto, denuncia o perfil com o motivo e os detalhes informados', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Denunciar' }));
    const dialog = screen.getByRole('dialog', { name: 'Denunciar' });
    // Um alvo só: não há o que escolher.
    expect(within(dialog).queryByRole('radio')).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('Motivo'), 'Fraude ou golpe');
    await user.type(within(dialog).getByLabelText('Detalhes da denúncia'), ' Pede Pix por fora ');
    await user.click(within(dialog).getByRole('button', { name: 'Enviar denúncia' }));

    expect(api.createReport).toHaveBeenCalledWith({
      targetType: 'user',
      targetId: MARINA,
      reason: 'fraud',
      description: 'Pede Pix por fora',
    });
    expect(
      await screen.findByText(
        'Denúncia registrada. Obrigado por ajudar a manter o Escambo seguro.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('com foto, quem denuncia escolhe entre o perfil e a foto do perfil', async () => {
    const user = userEvent.setup({ delay: null });
    api.publicFreelancer.mockResolvedValue(profile({ avatarUrl: 'https://img.test/marina.jpg' }));
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Denunciar' }));
    const dialog = screen.getByRole('dialog', { name: 'Denunciar' });
    expect(within(dialog).getByRole('radio', { name: /^O perfil/ })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: /^A foto do perfil/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar denúncia' }));

    expect(api.createReport).toHaveBeenCalledWith({
      targetType: 'avatar',
      targetId: MARINA,
      reason: 'offensive',
      description: null,
    });
    expect(
      await screen.findByText('Denúncia registrada. A moderação vai analisar a imagem.'),
    ).toBeInTheDocument();
  });

  it('denúncia recusada pela API: mostra o motivo e o diálogo continua aberto', async () => {
    const user = userEvent.setup({ delay: null });
    api.createReport.mockRejectedValue(new Error('Você já denunciou este perfil.'));
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Denunciar' }));
    await user.click(screen.getByRole('button', { name: 'Enviar denúncia' }));
    expect(await screen.findByText('Você já denunciou este perfil.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Denunciar' })).toBeInTheDocument();
  });
});

describe('FreelancerView: portfólio', () => {
  const portfolio = [
    work({
      id: 31,
      title: 'Logo Café Aurora',
      description: 'Identidade completa',
      externalUrl: 'https://behance.test/aurora',
    }),
    work({ id: 32, title: 'Site Padaria', imageUrl: null, externalUrl: 'https://padaria.test' }),
    work({ id: 33, title: 'Cartaz Festa', imageUrl: 'https://img.test/cartaz.jpg' }),
  ];

  beforeEach(() => {
    api.publicFreelancer.mockResolvedValue(profile({ portfolio }));
  });

  it('sem trabalhos, o cartão do portfólio não aparece', async () => {
    api.publicFreelancer.mockResolvedValue(profile({ portfolio: [] }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Marina Alves' });
    expect(screen.queryByRole('heading', { name: 'Portfólio' })).toBeNull();
  });

  it('conta os trabalhos no singular e no plural', async () => {
    const { unmount } = renderAt();
    expect(await screen.findByText('3 trabalhos')).toBeInTheDocument();
    unmount();
    api.publicFreelancer.mockResolvedValue(profile({ portfolio: [portfolio[0]!] }));
    renderAt();
    expect(await screen.findByText('1 trabalho')).toBeInTheDocument();
  });

  it('trabalho com imagem amplia; trabalho só com link mostra o link externo em nova aba', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'Portfólio' });
    expect(screen.getByText('Identidade completa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ampliar Logo Café Aurora' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ampliar Cartaz Festa' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ampliar Site Padaria' })).toBeNull();
    // Sem imagem não há o que denunciar.
    expect(screen.queryByRole('button', { name: 'Denunciar imagem de Site Padaria' })).toBeNull();

    const links = screen.getAllByRole('link', { name: 'Ver trabalho' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://behance.test/aurora',
      'https://padaria.test',
    ]);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('ampliar abre a galeria e põe o trabalho na URL; fechar volta para a página sem ele', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Ampliar Logo Café Aurora' }));
    const gallery = screen.getByRole('dialog', { name: 'Logo Café Aurora' });
    expect(within(gallery).getByText('1 de 2')).toBeInTheDocument();
    await expectRoute('/freelancers/u-marina?trabalho=31');

    await user.click(within(gallery).getByRole('button', { name: 'Fechar galeria' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await expectRoute('/freelancers/u-marina');
    expect(screen.getByRole('heading', { level: 1, name: 'Marina Alves' })).toBeVisible();
  });

  it('a galeria não deixa rastro no histórico: depois de fechar, "Voltar" sai do perfil', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt(['/servicos', '/freelancers/u-marina']);
    await user.click(await screen.findByRole('button', { name: 'Ampliar Logo Café Aurora' }));
    // Passar de trabalho troca o endereço no lugar, sem empilhar uma entrada por foto.
    await user.click(screen.getByRole('button', { name: 'Próximo trabalho' }));
    await expectRoute('/freelancers/u-marina?trabalho=33');
    // Fechar é o mesmo que o "voltar" do celular: tira a galeria do histórico.
    await user.click(screen.getByRole('button', { name: 'Fechar galeria' }));
    await expectRoute('/freelancers/u-marina');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    await expectRoute('/servicos');
  });

  it('link direto (?trabalho=ID) já abre a galeria; trocar de trabalho troca o ID na URL', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt(['/freelancers/u-marina?trabalho=33']);
    const gallery = await screen.findByRole('dialog', { name: 'Cartaz Festa' });
    expect(within(gallery).getByText('2 de 2')).toBeInTheDocument();

    await user.click(within(gallery).getByRole('button', { name: 'Próximo trabalho' }));
    expect(await screen.findByRole('dialog', { name: 'Logo Café Aurora' })).toBeInTheDocument();
    await expectRoute('/freelancers/u-marina?trabalho=31');

    // Quem chegou pelo link não tem histórico para voltar: fechar só tira o trabalho da URL.
    await user.click(screen.getByRole('button', { name: 'Fechar galeria' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await expectRoute('/freelancers/u-marina');
    expect(screen.getByRole('heading', { level: 1, name: 'Marina Alves' })).toBeVisible();
  });

  it('denunciar a imagem pelo cartão manda o trabalho para a moderação', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(
      await screen.findByRole('button', { name: 'Denunciar imagem de Cartaz Festa' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Denunciar imagem' });
    expect(within(dialog).getByText('Imagem de “Cartaz Festa”')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Enviar denúncia' }));
    expect(api.createReport).toHaveBeenCalledWith({
      targetType: 'portfolio_item',
      targetId: 33,
      reason: 'offensive',
      description: null,
    });
  });

  it('denunciar de dentro da galeria fecha a galeria e abre a denúncia daquele trabalho', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Ampliar Logo Café Aurora' }));
    const gallery = screen.getByRole('dialog', { name: 'Logo Café Aurora' });
    await user.click(
      within(gallery).getByRole('button', { name: 'Denunciar imagem de Logo Café Aurora' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Denunciar imagem' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Logo Café Aurora' })).toBeNull(),
    );
    await expectRoute('/freelancers/u-marina');

    await user.click(within(dialog).getByRole('button', { name: 'Enviar denúncia' }));
    expect(api.createReport).toHaveBeenCalledWith({
      targetType: 'portfolio_item',
      targetId: 31,
      reason: 'offensive',
      description: null,
    });
  });

  it('o dono do perfil amplia os trabalhos, mas não vê botão de denunciar imagem', async () => {
    const user = userEvent.setup({ delay: null });
    auth.user = { id: MARINA, role: 'freelancer', timezone: 'America/Sao_Paulo' };
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Ampliar Logo Café Aurora' }));
    expect(screen.getByRole('dialog', { name: 'Logo Café Aurora' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Denunciar imagem/ })).toBeNull();
  });
});

describe('FreelancerView: contratar, trocar e moderar', () => {
  it('"Contratar" abre o modal de contratação daquele serviço', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Contratar' }));
    const dialog = screen.getByRole('dialog', { name: 'Contratar: Identidade visual' });
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cliente não vê "Propor troca"; freelancer vê e é levado às trocas com o serviço escolhido', async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = renderAt();
    await screen.findByRole('button', { name: 'Contratar' });
    expect(screen.queryByRole('button', { name: 'Propor troca' })).toBeNull();
    unmount();

    auth.user = { id: VISITOR, role: 'freelancer', timezone: 'America/Sao_Paulo' };
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Propor troca' }));
    await expectRoute('/trocas?propor=21');
  });

  it('só o admin vê a moderação; banir pede confirmação e manda o ulid do perfil', async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Marina Alves' });
    expect(screen.queryByRole('button', { name: 'Banir' })).toBeNull();
    unmount();

    auth.user = { id: 1, role: 'admin', timezone: 'America/Sao_Paulo' };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    renderAt();
    // Sem confirmar, nada é enviado.
    await user.click(await screen.findByRole('button', { name: 'Banir' }));
    expect(confirm).toHaveBeenCalledWith('Banir este usuário?');
    expect(api.adminModerateUser).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Banir' }));
    expect(api.adminModerateUser).toHaveBeenCalledWith('u-marina', 'ban');
    expect(await screen.findByText('Usuário banido.')).toBeInTheDocument();
  });

  it('admin no próprio perfil não vê botões para moderar a si mesmo', async () => {
    auth.user = { id: MARINA, role: 'admin', timezone: 'America/Sao_Paulo' };
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Marina Alves' });
    expect(screen.queryByRole('button', { name: 'Banir' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suspender' })).toBeNull();
  });
});
