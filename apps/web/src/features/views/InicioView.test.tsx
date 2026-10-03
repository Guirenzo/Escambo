import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contract, GamificationProfile, Wallet } from '@escambo/types';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../lib/toast';
import { InicioView } from './InicioView';

/**
 * Início: o resumo de quem entrou (saldo, escrow, créditos, nível), as contratações com o atalho
 * para a Sala e só as ações que avançam o contrato, as conquistas e o aviso de perfil incompleto.
 */

const wallet = vi.fn();
const gamification = vi.fn();
const contracts = vi.fn();
const profilesMe = vi.fn();
const contractAction = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    wallet: () => wallet(),
    gamification: () => gamification(),
    contracts: () => contracts(),
    profilesMe: () => profilesMe(),
    contractAction: (id: number, action: string) => contractAction(id, action),
  },
}));

const auth = {
  user: { id: 1, email: 'bruno@escambo.test', role: 'freelancer' as 'freelancer' | 'client' },
};
vi.mock('../../lib/auth', () => ({ useAuth: () => auth }));

/** Para onde a tela levou: a rota de destino só escreve o próprio caminho. */
function Where() {
  const { pathname } = useLocation();
  return <p>rota: {pathname}</p>;
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<InicioView />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** O cartão de um indicador: o bloco que junta rótulo, valor e dica (não tem papel acessível). */
function kpi(label: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(label);
  while (el && !el.querySelector('strong')) el = el.parentElement;
  if (!el) throw new Error(`indicador "${label}" sem valor`);
  return el;
}

const walletOf = (o: Partial<Wallet> = {}): Wallet => ({
  balance: 1234.56,
  balancePending: 300,
  currency: 'BRL',
  credits: 40,
  creditsPending: 0,
  ...o,
});

const gamificationOf = (o: Partial<GamificationProfile> = {}): GamificationProfile => ({
  totalXp: 950,
  level: 3,
  levelName: 'Profissional',
  progress: {
    level: 3,
    levelName: 'Profissional',
    currentLevelMin: 800,
    nextLevelMin: 1200,
    xpIntoLevel: 150,
    xpToNextLevel: 250,
    percent: 61.6,
  },
  streakDays: 7,
  rank: 3,
  badges: [
    { slug: 'first-contract', name: 'Primeira contratação', awardedAt: '2026-08-01T12:00:00.000Z' },
    { slug: 'five-stars', name: 'Cinco estrelas', awardedAt: '2026-08-10T12:00:00.000Z' },
  ],
  ...o,
});

const contractOf = (o: Partial<Contract> & { id: number }): Contract => ({
  ulid: `c-${o.id}`,
  clientId: 9,
  freelancerId: 1,
  serviceId: null,
  title: `Contratação ${o.id}`,
  description: '',
  price: 200,
  platformFee: 30,
  freelancerNet: 170,
  paymentMode: 'cash',
  status: 'in_progress',
  deadlineAt: null,
  deadlineZone: 'America/Sao_Paulo',
  revisionRequestedAt: null,
  createdAt: '2026-09-10T15:00:00.000Z',
  hasReview: false,
  hasMilestones: false,
  deadlineExtendedAt: null,
  overdueNotifiedAt: null,
  extension: null,
  deadline: {
    state: 'none',
    noticeAt: null,
    mediationAt: null,
    extensionRequestsLeft: 2,
    undeliveredMilestones: 0,
    totalMilestones: 0,
    firstDeliveredAt: null,
  },
  approvalDueAt: null,
  proposalExpiresAt: null,
  ...o,
});

const page = (items: Contract[]) => ({ items, page: 1, limit: 20 });

beforeEach(() => {
  auth.user = { id: 1, email: 'bruno@escambo.test', role: 'freelancer' };
  wallet.mockReset();
  wallet.mockResolvedValue(walletOf());
  gamification.mockReset();
  gamification.mockResolvedValue(gamificationOf());
  contracts.mockReset();
  contracts.mockResolvedValue(page([]));
  profilesMe.mockReset();
  profilesMe.mockResolvedValue({ freelancer: { fullName: 'Bruno Costa' }, client: null });
  contractAction.mockReset();
  contractAction.mockResolvedValue(undefined);
});

describe('InicioView', () => {
  it('enquanto nada chegou: cumprimenta pelo e-mail, indicadores com travessão e esqueleto', () => {
    const never = new Promise(() => undefined);
    wallet.mockReturnValue(never);
    gamification.mockReturnValue(never);
    contracts.mockReturnValue(never);
    profilesMe.mockReturnValue(never);
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: 'Olá, bruno' })).toBeInTheDocument();
    expect(kpi('Saldo disponível')).toHaveTextContent('Saldo disponível—para saque');
    expect(kpi('Em escrow')).toHaveTextContent('Em escrow—retido em contratações');
    expect(kpi('Créditos Escambo')).toHaveTextContent('—para contratar ou impulsionar');
    expect(kpi('Nível')).toHaveTextContent(/^Nível—$/);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByText(/no total$/)).not.toBeInTheDocument();
    // Sem saber se há perfil, o aviso de completar o perfil não aparece.
    expect(screen.queryByRole('link', { name: 'Completar perfil' })).not.toBeInTheDocument();
  });

  it('mostra saldo, escrow, créditos e o nível com o que falta, a posição e a barra', async () => {
    renderView();

    expect(await screen.findByText('R$ 1.234,56')).toBeInTheDocument();
    expect(kpi('Saldo disponível')).toHaveTextContent('R$ 1.234,56');
    expect(kpi('Em escrow')).toHaveTextContent('R$ 300,00');
    expect(kpi('Créditos Escambo')).toHaveTextContent('40para contratar ou impulsionar');

    const level = kpi('Nível 3 · Profissional');
    expect(level).toHaveTextContent('950 XP');
    expect(level).toHaveTextContent('faltam 250 XP · #3 no ranking');
    expect(screen.getByRole('progressbar', { name: 'Progresso de nível' })).toHaveAttribute(
      'aria-valuenow',
      '62',
    );
    expect(document.title).toBe('Início · Escambo');
  });

  it('créditos retidos aparecem na dica; nível máximo e fora do ranking têm texto próprio', async () => {
    wallet.mockResolvedValue(walletOf({ credits: 15, creditsPending: 5 }));
    gamification.mockResolvedValue(
      gamificationOf({
        level: 5,
        levelName: 'Mestre',
        totalXp: 9000,
        rank: 1,
        progress: {
          level: 5,
          levelName: 'Mestre',
          currentLevelMin: 5000,
          nextLevelMin: null,
          xpIntoLevel: 4000,
          xpToNextLevel: null,
          percent: 100,
        },
      }),
    );
    renderView();

    expect(await screen.findByText('5 em escrow')).toBeInTheDocument();
    expect(kpi('Créditos Escambo')).toHaveTextContent('155 em escrow');
    const level = kpi('Nível 5 · Mestre');
    expect(level).toHaveTextContent('9000 XP');
    expect(level).toHaveTextContent('nível máximo');
    expect(level).not.toHaveTextContent('no ranking');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('quem ainda não tem posição vê um travessão no lugar do número do ranking', async () => {
    gamification.mockResolvedValue(gamificationOf({ rank: null }));
    renderView();

    expect(await screen.findByText('faltam 250 XP · #— no ranking')).toBeInTheDocument();
  });

  it('o cumprimento usa o primeiro nome do perfil de freelancer; sem ele, o do perfil de cliente', async () => {
    profilesMe.mockResolvedValue({
      freelancer: { fullName: 'Marina Alves Souza' },
      client: { fullName: 'Carla Dias' },
    });
    const first = renderView();
    expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Marina' })).toBeVisible();
    first.unmount();

    profilesMe.mockResolvedValue({ freelancer: null, client: { fullName: 'Carla Dias' } });
    auth.user = { id: 1, email: 'bruno@escambo.test', role: 'client' };
    renderView();
    expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Carla' })).toBeVisible();
  });

  it('freelancer sem perfil vê o aviso com o link para completar', async () => {
    profilesMe.mockResolvedValue({ freelancer: null, client: null });
    renderView();

    const link = await screen.findByRole('link', { name: 'Completar perfil' });
    expect(link).toHaveAttribute('href', '/perfil');
    expect(link.parentElement).toHaveTextContent(
      'Complete seu perfil de freelancer (nome, cidade e localização) para aparecer em "Perto de mim", ter Escambo Score e mostrar seu nome nos serviços.',
    );
  });

  it('o aviso de perfil não aparece para cliente nem para freelancer com perfil', async () => {
    auth.user = { id: 1, email: 'bruno@escambo.test', role: 'client' };
    profilesMe.mockResolvedValue({ freelancer: null, client: { fullName: 'Carla Dias' } });
    const first = renderView();
    // O nome do perfil na tela garante que os perfis já chegaram antes de conferir a ausência.
    expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Carla' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Completar perfil' })).not.toBeInTheDocument();
    first.unmount();

    auth.user = { id: 1, email: 'bruno@escambo.test', role: 'freelancer' };
    profilesMe.mockResolvedValue({ freelancer: { fullName: 'Bruno Costa' }, client: null });
    renderView();
    expect(await screen.findByRole('heading', { level: 1, name: 'Olá, Bruno' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Completar perfil' })).not.toBeInTheDocument();
  });

  it('sem contratações, diz onde encontrar um serviço e conta zero', async () => {
    renderView();

    expect(
      await screen.findByText('Nenhuma contratação ainda. Encontre um serviço em Serviços.'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 no total')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('lista as contratações com valor na moeda da modalidade e o status em português', async () => {
    contracts.mockResolvedValue(
      page([
        contractOf({ id: 5, title: 'Logo da padaria', price: 200, status: 'in_progress' }),
        contractOf({
          id: 6,
          title: 'Aula de violão',
          price: 30,
          paymentMode: 'credits',
          status: 'completed',
        }),
      ]),
    );
    renderView();

    const logo = await screen.findByRole('row', { name: /Logo da padaria/ });
    expect(screen.getByText('2 no total')).toBeInTheDocument();
    expect(within(logo).getByText(/· Dinheiro$/)).toBeInTheDocument();
    expect(within(logo).getByText('R$ 200,00')).toBeInTheDocument();
    expect(within(logo).getByText('Em andamento')).toBeInTheDocument();

    const lesson = screen.getByRole('row', { name: /Aula de violão/ });
    expect(within(lesson).getByText(/· Créditos$/)).toBeInTheDocument();
    expect(within(lesson).getByText('30 cr')).toBeInTheDocument();
    expect(within(lesson).getByText('Concluído')).toBeInTheDocument();
  });

  it('"Sala" abre a sala daquela contratação', async () => {
    const user = userEvent.setup();
    contracts.mockResolvedValue(
      page([contractOf({ id: 5, title: 'Logo da padaria' }), contractOf({ id: 8 })]),
    );
    renderView();

    const row = await screen.findByRole('row', { name: /Contratação 8/ });
    await user.click(within(row).getByRole('button', { name: 'Sala' }));

    expect(await screen.findByText('rota: /contratos/8')).toBeInTheDocument();
  });

  it('proposta recebida: dá para aceitar daqui, e recusar só na Sala', async () => {
    const user = userEvent.setup();
    contracts.mockResolvedValue(page([contractOf({ id: 5, status: 'pending' })]));
    renderView();

    const row = await screen.findByRole('row', { name: /Contratação 5/ });
    expect(within(row).queryByRole('button', { name: 'Recusar' })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Aceitar' }));

    await waitFor(() => expect(contractAction).toHaveBeenCalledTimes(1));
    expect(contractAction).toHaveBeenCalledWith(5, 'accept');
    expect(await screen.findByText('Contratação atualizada')).toBeInTheDocument();
    // A lista, a carteira e o nível são recarregados depois do aceite.
    await waitFor(() => expect(contracts).toHaveBeenCalledTimes(2));
    expect(wallet).toHaveBeenCalledTimes(2);
    expect(gamification).toHaveBeenCalledTimes(2);
  });

  it('se a API recusa o aceite, a mensagem dela aparece', async () => {
    const user = userEvent.setup();
    contracts.mockResolvedValue(page([contractOf({ id: 5, status: 'pending' })]));
    contractAction.mockRejectedValue(new Error('A proposta expirou.'));
    renderView();

    await user.click(await screen.findByRole('button', { name: 'Aceitar' }));

    expect(await screen.findByText('A proposta expirou.')).toBeInTheDocument();
    expect(screen.queryByText('Contratação atualizada')).not.toBeInTheDocument();
  });

  it('falha ao buscar as contratações: mostra o erro e "Tentar de novo" busca outra vez', async () => {
    const user = userEvent.setup();
    contracts.mockRejectedValueOnce(new Error('Erro ao listar contratações.'));
    contracts.mockResolvedValue(page([contractOf({ id: 5, title: 'Logo da padaria' })]));
    renderView();

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro ao listar contratações.');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByRole('row', { name: /Logo da padaria/ })).toBeInTheDocument();
    expect(contracts).toHaveBeenCalledTimes(2);
  });

  it('conquistas: mostra os badges e os dias seguidos de atividade', async () => {
    renderView();

    expect(await screen.findByText('Primeira contratação')).toBeInTheDocument();
    expect(screen.getByText('Cinco estrelas')).toBeInTheDocument();
    expect(screen.getByText('7 dias ativos')).toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });

  it('sem badge nenhum, diz como ganhar o primeiro', async () => {
    gamification.mockResolvedValue(gamificationOf({ badges: [], streakDays: 0 }));
    renderView();

    expect(await screen.findByText('Conclua contratações para ganhar badges.')).toBeInTheDocument();
    expect(screen.getByText('0 dias ativos')).toBeInTheDocument();
  });
});
