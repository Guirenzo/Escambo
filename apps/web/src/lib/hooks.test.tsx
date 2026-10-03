import { QueryClient, QueryClientProvider, type DefaultOptions } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PortfolioItem } from '@escambo/types';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api } from './api';
import * as hooks from './hooks';

/**
 * A camada de dados das telas (TanStack Query): cada consulta guarda o que a API devolve na chave
 * certa, e cada gravação chama a API com o que a tela mandou e marca como velho exatamente o que
 * mudou. Chave errada ou invalidação esquecida não quebra nada na hora: a tela só mostra dado
 * velho — por isso o teste confere as duas.
 */

vi.mock('./api');

type ApiMethod = keyof typeof api;
/** O método de lib/api trocado por um mock (o módulo inteiro é automockado). */
const mocked = (method: ApiMethod): Mock => (api as unknown as Record<ApiMethod, Mock>)[method];

/** Clientes criados no teste: limpos no fim, para nenhum timer de coleta do cache ficar pendurado. */
const clients: QueryClient[] = [];

function setup(queries: DefaultOptions['queries'] = {}) {
  // gcTime infinito: o cache não agenda coleta (só a consulta que fixa o próprio gcTime agenda).
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, ...queries },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  clients.push(client);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  /** As chaves invalidadas até agora, em ordem estável (a ordem das chamadas não é regra). */
  const invalidated = (): string[] =>
    invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey)).sort();
  return { client, wrapper, invalidated };
}

const keys = (...list: unknown[][]): string[] => list.map((k) => JSON.stringify(k)).sort();

/** Promessa que o teste resolve quando quiser (para olhar o meio do caminho). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  // Desmonta antes de limpar: a consulta que sai de tela agenda a coleta, e o clear a cancela.
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

describe('consultas: chave do cache e método da API', () => {
  type QueryCase = [
    name: string,
    use: () => { data: unknown },
    key: unknown[],
    method: ApiMethod,
    args: unknown[],
  ];
  const finance = { from: '2026-09-01', to: '2026-09-30', granularity: 'day' as const };
  const cases: QueryCase[] = [
    ['useWallet', () => hooks.useWallet(), ['wallet'], 'wallet', []],
    ['useGamification', () => hooks.useGamification(), ['gamification'], 'gamification', []],
    ['useLeaderboard', () => hooks.useLeaderboard(), ['leaderboard'], 'leaderboard', []],
    ['useCategories', () => hooks.useCategories(), ['categories'], 'categories', []],
    [
      'useServices com filtros',
      () => hooks.useServices({ q: 'logo', categoryId: 2 }),
      ['services', { q: 'logo', categoryId: 2 }],
      'listServices',
      [{ q: 'logo', categoryId: 2 }],
    ],
    [
      'useServices sem filtros',
      () => hooks.useServices(),
      ['services', {}],
      'listServices',
      [undefined],
    ],
    ['useContracts', () => hooks.useContracts(), ['contracts'], 'contracts', []],
    ['useContractDetail', () => hooks.useContractDetail(7), ['contract', 7], 'contractDetail', [7]],
    ['useChatHistory', () => hooks.useChatHistory(7), ['chat', 7], 'chatHistory', [7]],
    ['useWithdrawals', () => hooks.useWithdrawals(), ['withdrawals'], 'withdrawals', []],
    [
      'useWalletTransactions',
      () => hooks.useWalletTransactions(),
      ['walletTransactions'],
      'walletTransactions',
      [],
    ],
    ['useDeposits', () => hooks.useDeposits(), ['deposits'], 'deposits', []],
    ['useDeposit', () => hooks.useDeposit(3, false), ['deposit', 3], 'deposit', [3]],
    ['useNotifications', () => hooks.useNotifications(), ['notifications'], 'notifications', []],
    ['useBarters', () => hooks.useBarters(), ['barters'], 'barters', []],
    ['useProfilesMe', () => hooks.useProfilesMe(), ['profiles'], 'profilesMe', []],
    [
      'useAttachmentBlob',
      () => hooks.useAttachmentBlob('/api/messaging/attachments/9', 'foto.png'),
      ['attachment', '/api/messaging/attachments/9'],
      'attachmentBlob',
      ['/api/messaging/attachments/9', 'foto.png'],
    ],
    [
      'useCreditTransactions',
      () => hooks.useCreditTransactions(),
      ['creditTransactions'],
      'creditTransactions',
      [],
    ],
    ['useBoostPlans', () => hooks.useBoostPlans(), ['boostPlans'], 'boostPlans', []],
    ['useMyBoosts', () => hooks.useMyBoosts(), ['myBoosts'], 'myBoosts', []],
    ['useFreelancerReviews', () => hooks.useFreelancerReviews(9), ['reviews', 9], 'reviews', [9]],
    [
      'usePublicFreelancer',
      () => hooks.usePublicFreelancer('01J8ZQ'),
      ['publicFreelancer', '01J8ZQ'],
      'publicFreelancer',
      ['01J8ZQ'],
    ],
    ['useFavorites', () => hooks.useFavorites(), ['favorites'], 'favorites', []],
    ['useMyDisputes', () => hooks.useMyDisputes(), ['disputes'], 'disputes', []],
    ['useConsents', () => hooks.useConsents(), ['consents'], 'consents', []],
    [
      'useExportRequests',
      () => hooks.useExportRequests(),
      ['exportRequests'],
      'exportRequests',
      [],
    ],
    [
      'useDeletionRequests',
      () => hooks.useDeletionRequests(),
      ['deletionRequests'],
      'deletionRequests',
      [],
    ],
    ['usePortfolio', () => hooks.usePortfolio(), ['portfolio'], 'myPortfolio', []],
    [
      'useAdminFinance',
      () => hooks.useAdminFinance(finance),
      ['adminFinance', finance],
      'adminFinance',
      [finance],
    ],
    ['useAdminMetrics', () => hooks.useAdminMetrics(), ['adminMetrics'], 'adminMetrics', []],
    ['useAdminStorage', () => hooks.useAdminStorage(), ['adminStorage'], 'adminStorage', []],
    [
      'useModerationHealth',
      () => hooks.useModerationHealth(30),
      ['moderationHealth', 30],
      'adminModerationHealth',
      [30],
    ],
    ['useAdminSettings', () => hooks.useAdminSettings(), ['adminSettings'], 'adminSettings', []],
    [
      'usePublicSettings',
      () => hooks.usePublicSettings(),
      ['publicSettings'],
      'publicSettings',
      [],
    ],
    ['useAdminDisputes', () => hooks.useAdminDisputes(), ['adminDisputes'], 'adminDisputes', []],
    // O painel pede sempre os 50 e-mails mais recentes.
    ['useAdminEmails', () => hooks.useAdminEmails(), ['adminEmails'], 'adminEmails', [50]],
    [
      'useAdminDeletionRequests',
      () => hooks.useAdminDeletionRequests('all'),
      ['adminDeletions', 'all'],
      'adminDeletionRequests',
      ['all'],
    ],
    [
      'useAdminWithdrawals',
      () => hooks.useAdminWithdrawals('open'),
      ['adminWithdrawals', 'open'],
      'adminWithdrawals',
      ['open'],
    ],
    [
      'useAdminReports',
      () => hooks.useAdminReports('resolved'),
      ['adminReports', 'resolved'],
      'adminReports',
      ['resolved'],
    ],
    ['useMyModeration', () => hooks.useMyModeration(), ['myModeration'], 'myModeration', []],
    [
      'useAdminAppeals',
      () => hooks.useAdminAppeals('decided'),
      ['adminAppeals', 'decided'],
      'adminAppeals',
      ['decided'],
    ],
    ['useSavedSearches', () => hooks.useSavedSearches(), ['savedSearches'], 'savedSearches', []],
  ];

  it.each(cases)('%s', async (_name, use, key, method, args) => {
    const data = { vindoDe: method };
    mocked(method).mockResolvedValue(data);
    const { client, wrapper } = setup();

    const { result } = renderHook(use, { wrapper });

    await waitFor(() => expect(result.current.data).toBe(data));
    expect(mocked(method)).toHaveBeenCalledTimes(1);
    expect(mocked(method)).toHaveBeenCalledWith(...args);
    expect(client.getQueryData(key)).toBe(data);
  });

  it('as chaves de qk são as que as telas e o tempo real invalidam', () => {
    expect(hooks.qk.services()).toEqual(['services', {}]);
    expect(hooks.qk.services({ q: 'logo' })).toEqual(['services', { q: 'logo' }]);
    expect(hooks.qk.contract(7)).toEqual(['contract', 7]);
    expect(hooks.qk.chat(7)).toEqual(['chat', 7]);
    expect(hooks.qk.deposit(3)).toEqual(['deposit', 3]);
    expect(hooks.qk.reviews(9)).toEqual(['reviews', 9]);
    expect(hooks.qk.publicFreelancer('u1')).toEqual(['publicFreelancer', 'u1']);
    expect(hooks.qk.moderationHealth(7)).toEqual(['moderationHealth', 7]);
    expect(hooks.qk.adminReports('pending')).toEqual(['adminReports', 'pending']);
    expect(hooks.qk.adminAppeals('pending')).toEqual(['adminAppeals', 'pending']);
  });

  it('useAppealImage guarda só o blob da imagem, na chave da contestação', async () => {
    const blob = new Blob(['img'], { type: 'image/webp' });
    mocked('adminAppealImage').mockResolvedValue({ blob, fileName: 'contestacao-2' });
    const { client, wrapper } = setup();

    const { result } = renderHook(() => hooks.useAppealImage(2, true), { wrapper });

    await waitFor(() => expect(result.current.data).toBe(blob));
    expect(mocked('adminAppealImage')).toHaveBeenCalledWith(2);
    expect(client.getQueryData(['appealImage', 2])).toBe(blob);
  });

  it('useAppealImage não insiste quando a imagem falha (a rota não tem cache)', async () => {
    mocked('adminAppealImage').mockRejectedValue(new Error('Imagem indisponível'));
    // Mesmo num cliente que repete consultas, esta não repete.
    const { wrapper } = setup({ retry: 2, retryDelay: 0 });

    const { result } = renderHook(() => hooks.useAppealImage(2, true), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Imagem indisponível');
    expect(mocked('adminAppealImage')).toHaveBeenCalledTimes(1);
  });

  it('consulta que depende de um dado ainda ausente fica parada, sem chamar a API', () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => ({
        deposit: hooks.useDeposit(null, true),
        reviews: hooks.useFreelancerReviews(undefined),
        freelancer: hooks.usePublicFreelancer(undefined),
        attachment: hooks.useAttachmentBlob('/api/messaging/attachments/9', 'a.png', false),
        appealImage: hooks.useAppealImage(2, false),
      }),
      { wrapper },
    );

    for (const query of Object.values(result.current)) {
      expect(query.fetchStatus).toBe('idle');
      expect(query.data).toBeUndefined();
    }
    expect(mocked('deposit')).not.toHaveBeenCalled();
    expect(mocked('reviews')).not.toHaveBeenCalled();
    expect(mocked('publicFreelancer')).not.toHaveBeenCalled();
    expect(mocked('attachmentBlob')).not.toHaveBeenCalled();
    expect(mocked('adminAppealImage')).not.toHaveBeenCalled();
  });

  it('consulta recusada entrega a mensagem da API para a tela', async () => {
    mocked('wallet').mockRejectedValue(new Error('Carteira indisponível'));
    const { wrapper } = setup();
    const { result } = renderHook(() => hooks.useWallet(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Carteira indisponível');
  });
});

describe('consultas que se repetem sozinhas', () => {
  const flush = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('cobrança pendente é consultada de novo a cada 3 s', async () => {
    vi.useFakeTimers();
    mocked('deposit').mockResolvedValue({ id: 3, status: 'pending' });
    const { wrapper } = setup();
    renderHook(() => hooks.useDeposit(3, true), { wrapper });

    await flush(0);
    expect(mocked('deposit')).toHaveBeenCalledTimes(1);
    await flush(2999);
    expect(mocked('deposit')).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(mocked('deposit')).toHaveBeenCalledTimes(2);
    await flush(3000);
    expect(mocked('deposit')).toHaveBeenCalledTimes(3);
  });

  it('cobrança já resolvida (sem poll) não fica consultando', async () => {
    vi.useFakeTimers();
    mocked('deposit').mockResolvedValue({ id: 3, status: 'paid' });
    const { wrapper } = setup();
    renderHook(() => hooks.useDeposit(3, false), { wrapper });

    await flush(0);
    await flush(10_000);
    expect(mocked('deposit')).toHaveBeenCalledTimes(1);
  });

  it('notificações são conferidas de novo a cada 30 s (rede de segurança do tempo real)', async () => {
    vi.useFakeTimers();
    mocked('notifications').mockResolvedValue({ items: [], unreadCount: 0 });
    const { wrapper } = setup();
    renderHook(() => hooks.useNotifications(), { wrapper });

    await flush(0);
    expect(mocked('notifications')).toHaveBeenCalledTimes(1);
    await flush(29_999);
    expect(mocked('notifications')).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(mocked('notifications')).toHaveBeenCalledTimes(2);
  });
});

describe('o que já veio da API e outra tela reaproveita', () => {
  const NOON = new Date('2026-10-03T12:00:00.000Z').getTime();
  /** Só o relógio é de mentira: a validade do cache é medida por Date.now(). */
  const clockAt = (ms: number) => vi.setSystemTime(new Date(NOON + ms));
  /** Deixa a montagem nova disparar a recarga, se ela for disparar. */
  const settle = () => act(async () => undefined);

  it.each<[string, () => { data: unknown }, ApiMethod]>([
    ['useCategories', () => hooks.useCategories(), 'categories'],
    ['useBoostPlans', () => hooks.useBoostPlans(), 'boostPlans'],
    ['usePublicSettings', () => hooks.usePublicSettings(), 'publicSettings'],
  ])(
    '%s vale por 5 min: outra tela nesse prazo usa o que veio; depois, pede de novo',
    async (_name, use, method) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      clockAt(0);
      const data = { vindoDe: method };
      mocked(method).mockResolvedValue(data);
      const { wrapper } = setup();

      const first = renderHook(use, { wrapper });
      await waitFor(() => expect(first.result.current.data).toBe(data));

      clockAt(5 * 60_000 - 1);
      const second = renderHook(use, { wrapper });
      await settle();
      expect(second.result.current.data).toBe(data);
      expect(mocked(method)).toHaveBeenCalledTimes(1);

      clockAt(5 * 60_000 + 1);
      renderHook(use, { wrapper });
      await waitFor(() => expect(mocked(method)).toHaveBeenCalledTimes(2));
    },
  );

  it('consentimentos: uma consulta por carga do app, por mais que outras telas montem depois', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clockAt(0);
    mocked('consents').mockResolvedValue([]);
    const { wrapper } = setup();

    const shell = renderHook(() => hooks.useConsents(), { wrapper });
    await waitFor(() => expect(shell.result.current.data).toEqual([]));

    clockAt(24 * 60 * 60_000);
    const profile = renderHook(() => hooks.useConsents(), { wrapper });
    await settle();

    expect(profile.result.current.data).toEqual([]);
    expect(mocked('consents')).toHaveBeenCalledTimes(1);
  });

  it('dado comum (a carteira) é conferido de novo quando outra tela o mostra', async () => {
    mocked('wallet').mockResolvedValue({ balance: 10 });
    const { wrapper } = setup();

    const header = renderHook(() => hooks.useWallet(), { wrapper });
    await waitFor(() => expect(header.result.current.data).toEqual({ balance: 10 }));
    renderHook(() => hooks.useWallet(), { wrapper });

    await waitFor(() => expect(mocked('wallet')).toHaveBeenCalledTimes(2));
  });

  it('anexo baixado: reabrir a Sala em até 30 min não baixa de novo; passado isso, sai da memória', async () => {
    vi.useFakeTimers();
    const url = '/api/messaging/attachments/9';
    const file = { blob: new Blob(['img']), fileName: 'foto.png' };
    mocked('attachmentBlob').mockResolvedValue(file);
    const { client, wrapper } = setup();
    const flush = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const useIt = () => hooks.useAttachmentBlob(url, 'foto.png');

    const room = renderHook(useIt, { wrapper });
    await flush(0);
    expect(room.result.current.data).toBe(file);
    room.unmount();

    // 29 min fora de tela (o padrão do cache já teria jogado fora): ainda serve, sem novo download.
    await flush(29 * 60_000);
    const again = renderHook(useIt, { wrapper });
    expect(again.result.current.data).toBe(file);
    await flush(0);
    expect(mocked('attachmentBlob')).toHaveBeenCalledTimes(1);
    again.unmount();

    await flush(30 * 60_000 - 1);
    expect(client.getQueryData(['attachment', url])).toBe(file);
    await flush(1);
    expect(client.getQueryData(['attachment', url])).toBeUndefined();
  });
});

describe('busca paginada de serviços ("Carregar mais")', () => {
  const page = (number: number, size: number) => ({
    items: Array.from({ length: size }, (_, i) => ({ id: number * 100 + i })),
    page: number,
    limit: hooks.SERVICES_PAGE,
    total: 40,
  });

  it('pede a primeira página com 12 por vez e, com página cheia, oferece a próxima', async () => {
    mocked('listServices').mockResolvedValueOnce(page(1, 12)).mockResolvedValueOnce(page(2, 5));
    const { client, wrapper } = setup();

    const { result } = renderHook(() => hooks.useServicesInfinite({ q: 'logo' }), { wrapper });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(mocked('listServices')).toHaveBeenLastCalledWith({ q: 'logo', page: 1, limit: 12 });
    expect(result.current.hasNextPage).toBe(true);
    expect(client.getQueryData(['services', 'infinite', { q: 'logo' }])).toBeDefined();

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(mocked('listServices')).toHaveBeenLastCalledWith({ q: 'logo', page: 2, limit: 12 });
    await waitFor(() =>
      expect(result.current.data?.pages.map((p) => p.items.length)).toEqual([12, 5]),
    );
    // Página incompleta é a última: o botão de carregar mais some.
    expect(result.current.hasNextPage).toBe(false);
  });

  it('sem filtros a busca vale para a chave vazia e uma página curta já encerra', async () => {
    mocked('listServices').mockResolvedValueOnce(page(1, 3));
    const { client, wrapper } = setup();

    const { result } = renderHook(() => hooks.useServicesInfinite(), { wrapper });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(mocked('listServices')).toHaveBeenCalledWith({ page: 1, limit: 12 });
    expect(result.current.hasNextPage).toBe(false);
    expect(client.getQueryData(['services', 'infinite', {}])).toBeDefined();
  });
});

describe('gravações: o que vai para a API e o que é recarregado depois', () => {
  type MutationLike = { mutateAsync: (variables: never) => Promise<unknown> };
  type MutationCase = [
    name: string,
    use: () => MutationLike,
    variables: unknown,
    method: ApiMethod,
    args: unknown[],
    result: unknown,
    invalidates: unknown[][],
  ];
  const WALLET = [['wallet'], ['walletTransactions'], ['deposits'], ['withdrawals']];
  const file = new File(['x'], 'briefing.pdf', { type: 'application/pdf' });

  const cases: MutationCase[] = [
    [
      'useContractAction',
      () => hooks.useContractAction(),
      { id: 7, action: 'approve' },
      'contractAction',
      [7, 'approve'],
      { id: 7 },
      [['contracts'], ['contract', 7], ['wallet'], ['gamification']],
    ],
    [
      'useCancelContract com o reembolso que a tela mostrou',
      () => hooks.useCancelContract(),
      { id: 7, expectedRefund: 100 },
      'cancelContract',
      [7, { expectedRefund: 100 }],
      { status: 'cancelled' },
      [['contracts'], ['contract', 7], ['wallet']],
    ],
    [
      'useCancelContract sem valor visto manda corpo vazio',
      () => hooks.useCancelContract(),
      { id: 7 },
      'cancelContract',
      [7, {}],
      { status: 'cancelled' },
      [['contracts'], ['contract', 7], ['wallet']],
    ],
    [
      'useCancelContract com reembolso zero ainda manda o zero',
      () => hooks.useCancelContract(),
      { id: 7, expectedRefund: 0 },
      'cancelContract',
      [7, { expectedRefund: 0 }],
      { status: 'cancelled' },
      [['contracts'], ['contract', 7], ['wallet']],
    ],
    [
      'useRequestRevision',
      () => hooks.useRequestRevision(),
      { id: 7, note: 'Falta o logo' },
      'requestRevision',
      [7, 'Falta o logo'],
      { id: 7 },
      [['contracts'], ['contract', 7]],
    ],
    [
      'useRequestExtension',
      () => hooks.useRequestExtension(),
      { id: 7, deadlineAt: '2026-10-20T15:00:00.000Z', reason: 'Imprevisto' },
      'requestExtension',
      [7, { deadlineAt: '2026-10-20T15:00:00.000Z', reason: 'Imprevisto' }],
      { id: 7 },
      [['contracts'], ['contract', 7]],
    ],
    [
      'useResolveExtension',
      () => hooks.useResolveExtension(),
      { id: 7, decision: 'accept', seq: 3 },
      'resolveExtension',
      [7, 'accept', 3],
      { id: 7 },
      [['contracts'], ['contract', 7]],
    ],
    [
      'useDeliverContract',
      () => hooks.useDeliverContract(),
      { id: 7, message: 'Segue o arquivo' },
      'deliverContract',
      [7, 'Segue o arquivo'],
      { id: 7 },
      [['contracts'], ['contract', 7]],
    ],
    [
      'useMilestoneAction',
      () => hooks.useMilestoneAction(7),
      { milestoneId: 2, action: 'deliver', text: 'Primeira parte' },
      'milestoneAction',
      [7, 2, 'deliver', 'Primeira parte'],
      { id: 7, milestones: [] },
      [['contracts'], ['wallet'], ['walletTransactions'], ['gamification']],
    ],
    [
      'useCreateService',
      () => hooks.useCreateService(),
      { categoryId: 2, title: 'Logo', description: 'Marca' },
      'createService',
      [{ categoryId: 2, title: 'Logo', description: 'Marca' }],
      { id: 11 },
      [['services']],
    ],
    [
      'useSendMessage',
      () => hooks.useSendMessage(7),
      'Olá',
      'sendMessage',
      [7, 'Olá'],
      { id: 1 },
      [['chat', 7]],
    ],
    [
      'useSendAttachment',
      () => hooks.useSendAttachment(7),
      { file, content: 'Segue' },
      'sendAttachment',
      [7, file, 'Segue'],
      { id: 2 },
      [['chat', 7]],
    ],
    [
      'useCreateDeposit',
      () => hooks.useCreateDeposit(),
      { amount: 50 },
      'createDeposit',
      [{ amount: 50 }],
      { id: 3 },
      [['deposits']],
    ],
    [
      'useSimulateDeposit',
      () => hooks.useSimulateDeposit(),
      3,
      'simulateDeposit',
      [3],
      { id: 3, status: 'paid' },
      [...WALLET, ['notifications']],
    ],
    [
      'useCancelWithdrawal',
      () => hooks.useCancelWithdrawal(),
      6,
      'cancelWithdrawal',
      [6],
      { id: 6 },
      WALLET,
    ],
    [
      'useRequestWithdrawal',
      () => hooks.useRequestWithdrawal(),
      { amount: 80, method: 'pix', pixKey: 'a@b.com' },
      'requestWithdrawal',
      [{ amount: 80, method: 'pix', pixKey: 'a@b.com' }],
      { id: 6 },
      WALLET,
    ],
    [
      'useMarkNotificationRead',
      () => hooks.useMarkNotificationRead(),
      5,
      'markNotificationRead',
      [5],
      undefined,
      [['notifications']],
    ],
    [
      'useMarkAllNotificationsRead',
      () => hooks.useMarkAllNotificationsRead(),
      undefined,
      'markAllNotificationsRead',
      [],
      { read: 4 },
      [['notifications']],
    ],
    [
      'useProposeBarter',
      () => hooks.useProposeBarter(),
      { receiverId: 8, estimatedValueOffered: 200, estimatedValueRequested: 180 },
      'proposeBarter',
      [{ receiverId: 8, estimatedValueOffered: 200, estimatedValueRequested: 180 }],
      { id: 4 },
      [['barters']],
    ],
    [
      'useBarterAction',
      () => hooks.useBarterAction(),
      { id: 4, action: 'accept' },
      'barterAction',
      [4, 'accept'],
      { id: 4 },
      [['barters'], ['contracts']],
    ],
    [
      'usePutFreelancerProfile',
      () => hooks.usePutFreelancerProfile(),
      { fullName: 'Ana' },
      'putFreelancerProfile',
      [{ fullName: 'Ana' }],
      { fullName: 'Ana' },
      [['profiles']],
    ],
    [
      'usePutClientProfile',
      () => hooks.usePutClientProfile(),
      { fullName: 'Bia' },
      'putClientProfile',
      [{ fullName: 'Bia' }],
      { fullName: 'Bia' },
      [['profiles']],
    ],
    [
      'useCreateContract',
      () => hooks.useCreateContract(),
      { freelancerId: 5, title: 'Site', description: 'Página', price: 300 },
      'createContract',
      [{ freelancerId: 5, title: 'Site', description: 'Página', price: 300 }],
      { id: 7 },
      [['contracts'], ['wallet']],
    ],
    [
      'useCreateBoost',
      () => hooks.useCreateBoost(),
      { serviceId: 11, planId: 2 },
      'createBoost',
      [{ serviceId: 11, planId: 2 }],
      { id: 1 },
      [['services'], ['myBoosts'], ['wallet'], ['creditTransactions']],
    ],
    [
      'useCreateReview recarrega a contratação e as avaliações de quem foi avaliado',
      () => hooks.useCreateReview(),
      { contractId: 7, rating: 5, comment: 'Ótimo' },
      'createReview',
      [{ contractId: 7, rating: 5, comment: 'Ótimo' }],
      { id: 1, contractId: 7, revieweeId: 9 },
      [
        ['contract', 7],
        ['contracts'],
        ['reviews', 9],
        ['profiles'],
        ['gamification'],
        ['leaderboard'],
        ['services'],
      ],
    ],
    [
      'useRespondReview',
      () => hooks.useRespondReview(),
      { id: 12, response: 'Obrigada!' },
      'respondReview',
      [12, 'Obrigada!'],
      { ok: true },
      [['reviews'], ['contract']],
    ],
    [
      'useToggleFavorite ainda não favorito: adiciona',
      () => hooks.useToggleFavorite(),
      { targetType: 'service', targetId: 11, favorited: false },
      'addFavorite',
      [{ targetType: 'service', targetId: 11 }],
      undefined,
      [['favorites']],
    ],
    [
      'useToggleFavorite já favorito: remove',
      () => hooks.useToggleFavorite(),
      { targetType: 'freelancer', targetId: 8, favorited: true },
      'removeFavorite',
      ['freelancer', 8],
      undefined,
      [['favorites']],
    ],
    [
      'useOpenDispute recarrega a contratação da disputa',
      () => hooks.useOpenDispute(),
      { contractId: 7, reason: 'quality', description: 'Veio errado' },
      'openDispute',
      [{ contractId: 7, reason: 'quality', description: 'Veio errado' }],
      { id: 3, contractId: 7 },
      [['disputes'], ['contracts'], ['contract', 7]],
    ],
    [
      'useCreateReport não recarrega nada (a denúncia não aparece para quem denuncia)',
      () => hooks.useCreateReport(),
      { targetType: 'service', targetId: 11, reason: 'spam' },
      'createReport',
      [{ targetType: 'service', targetId: 11, reason: 'spam' }],
      { id: 1 },
      [],
    ],
    [
      'useRequestExport',
      () => hooks.useRequestExport(),
      undefined,
      'requestExport',
      [],
      { id: 1 },
      [['exportRequests']],
    ],
    [
      'useRequestDeletion',
      () => hooks.useRequestDeletion(),
      'Não uso mais',
      'requestDeletion',
      ['Não uso mais'],
      { id: 1 },
      [['deletionRequests']],
    ],
    [
      'useUpdateSetting',
      () => hooks.useUpdateSetting(),
      { key: 'platform_fee', value: 12 },
      'adminUpdateSetting',
      ['platform_fee', 12],
      { key: 'platform_fee', value: 12 },
      [['adminSettings'], ['adminStorage'], ['publicSettings'], ['moderationHealth']],
    ],
    [
      'usePurgeAttachments',
      () => hooks.usePurgeAttachments(),
      undefined,
      'adminPurgeAttachments',
      [],
      { removed: 2 },
      [['adminStorage']],
    ],
    [
      'useResolveDispute',
      () => hooks.useResolveDispute(),
      { id: 3, body: { resolution: 'refund_client', note: 'Não entregou' } },
      'adminResolveDispute',
      [3, { resolution: 'refund_client', note: 'Não entregou' }],
      { id: 3 },
      [['adminDisputes'], ['adminMetrics'], ['disputes'], ['contracts'], ['contract']],
    ],
    [
      'useAdminDeletionAction com nota',
      () => hooks.useAdminDeletionAction(),
      { id: 5, action: 'reject', note: 'Há contrato aberto' },
      'adminDeletionAction',
      [5, 'reject', { note: 'Há contrato aberto' }],
      { id: 5 },
      [['adminDeletions'], ['adminMetrics']],
    ],
    [
      'useAdminDeletionAction com nota em branco manda corpo vazio',
      () => hooks.useAdminDeletionAction(),
      { id: 5, action: 'complete', note: '' },
      'adminDeletionAction',
      [5, 'complete', {}],
      { id: 5 },
      [['adminDeletions'], ['adminMetrics']],
    ],
    [
      'useAdminWithdrawalAction',
      () => hooks.useAdminWithdrawalAction(),
      { id: 6, action: 'fail', body: { reason: 'Chave inválida' } },
      'adminWithdrawalAction',
      [6, 'fail', { reason: 'Chave inválida' }],
      { id: 6 },
      [['adminWithdrawals'], ['adminMetrics']],
    ],
    [
      'useAdminReportAction',
      () => hooks.useAdminReportAction(),
      { id: 9, action: 'remove-image', note: 'Imprópria' },
      'adminReportAction',
      [9, 'remove-image', { note: 'Imprópria' }],
      { status: 'resolved' },
      [['adminReports'], ['adminStorage'], ['moderationHealth']],
    ],
    [
      'useAppealRemoval',
      () => hooks.useAppealRemoval(),
      { id: 2, text: 'A imagem é minha' },
      'appealRemoval',
      [2, 'A imagem é minha'],
      { id: 2 },
      [['myModeration']],
    ],
    [
      'useAdminAppealDecision',
      () => hooks.useAdminAppealDecision(),
      { id: 2, decision: 'overturn', note: null },
      'adminDecideAppeal',
      [2, 'overturn', { note: null }],
      { status: 'overturned' },
      [['adminAppeals'], ['moderationHealth'], ['adminReports']],
    ],
    [
      'useModerateUser não recarrega nada',
      () => hooks.useModerateUser(),
      { ulid: '01J8ZQ', action: 'ban' },
      'adminModerateUser',
      ['01J8ZQ', 'ban'],
      undefined,
      [],
    ],
    [
      'usePortfolioMutation.add',
      () => hooks.usePortfolioMutation().add,
      { title: 'Logo' },
      'addPortfolioItem',
      [{ title: 'Logo' }],
      [],
      [['portfolio']],
    ],
    [
      'usePortfolioMutation.remove',
      () => hooks.usePortfolioMutation().remove,
      4,
      'removePortfolioItem',
      [4],
      [],
      [['portfolio']],
    ],
    [
      'useSavedSearchMutations.create',
      () => hooks.useSavedSearchMutations().create,
      { query: 'logo', alertEnabled: true },
      'createSavedSearch',
      [{ query: 'logo', alertEnabled: true }],
      { id: 4 },
      [['savedSearches']],
    ],
    [
      'useSavedSearchMutations.update separa o id do que muda',
      () => hooks.useSavedSearchMutations().update,
      { id: 4, name: 'Logos', alertEnabled: false },
      'updateSavedSearch',
      [4, { name: 'Logos', alertEnabled: false }],
      { id: 4 },
      [['savedSearches']],
    ],
    [
      'useSavedSearchMutations.remove',
      () => hooks.useSavedSearchMutations().remove,
      4,
      'deleteSavedSearch',
      [4],
      undefined,
      [['savedSearches']],
    ],
  ];

  it.each(cases)('%s', async (_name, use, variables, method, args, apiResult, invalidates) => {
    mocked(method).mockResolvedValue(apiResult);
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(use, { wrapper });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutateAsync(variables as never);
    });

    expect(returned).toBe(apiResult);
    expect(mocked(method)).toHaveBeenCalledTimes(1);
    expect(mocked(method)).toHaveBeenCalledWith(...args);
    expect(invalidated()).toEqual(keys(...invalidates));
  });

  it('useAdminWithdrawalAction sem corpo deixa o padrão por conta do cliente HTTP', async () => {
    mocked('adminWithdrawalAction').mockResolvedValue({ id: 6 });
    const { wrapper } = setup();
    const { result } = renderHook(() => hooks.useAdminWithdrawalAction(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 6, action: 'process' });
    });
    expect(mocked('adminWithdrawalAction')).toHaveBeenCalledWith(6, 'process', undefined);
  });

  it('useMilestoneAction põe a contratação devolvida direto na Sala, sem esperar recarga', async () => {
    const updated = { id: 7, status: 'in_progress', milestones: [{ id: 2, status: 'approved' }] };
    mocked('milestoneAction').mockResolvedValue(updated);
    const { client, wrapper } = setup();
    client.setQueryData(['contract', 7], { id: 7, status: 'velho' });
    const { result } = renderHook(() => hooks.useMilestoneAction(7), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ milestoneId: 2, action: 'approve' });
    });

    expect(mocked('milestoneAction')).toHaveBeenCalledWith(7, 2, 'approve', undefined);
    // O cache reaproveita o que não mudou (compartilhamento estrutural): compara pelo conteúdo.
    expect(client.getQueryData(['contract', 7])).toEqual(updated);
  });

  it('useSimulateDeposit grava a cobrança paga na chave dela (o QR some na hora)', async () => {
    const paid = { id: 3, status: 'paid' };
    mocked('simulateDeposit').mockResolvedValue(paid);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => hooks.useSimulateDeposit(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(3);
    });

    expect(client.getQueryData(['deposit', 3])).toBe(paid);
  });

  describe('quando a API recusa', () => {
    type FailCase = [
      name: string,
      use: () => MutationLike,
      variables: unknown,
      method: ApiMethod,
      invalidates: unknown[][],
    ];
    // ADR 57: um 409 nestas três quer dizer que a Sala está velha, então recarrega mesmo no erro.
    const failing: FailCase[] = [
      [
        'useCancelContract recarrega a contratação (o valor mudou)',
        () => hooks.useCancelContract(),
        { id: 7, expectedRefund: 100 },
        'cancelContract',
        [['contracts'], ['contract', 7], ['wallet']],
      ],
      [
        'useRequestExtension recarrega a Sala',
        () => hooks.useRequestExtension(),
        { id: 7, deadlineAt: '2026-10-20T15:00:00.000Z', reason: 'Imprevisto' },
        'requestExtension',
        [['contracts'], ['contract', 7]],
      ],
      [
        'useResolveExtension recarrega o pedido atual',
        () => hooks.useResolveExtension(),
        { id: 7, decision: 'decline' },
        'resolveExtension',
        [['contracts'], ['contract', 7]],
      ],
      [
        'useContractAction não recarrega nada',
        () => hooks.useContractAction(),
        { id: 7, action: 'accept' },
        'contractAction',
        [],
      ],
      [
        'useDeliverContract não recarrega nada',
        () => hooks.useDeliverContract(),
        { id: 7, message: 'Segue' },
        'deliverContract',
        [],
      ],
      [
        'useRequestWithdrawal não mexe na carteira',
        () => hooks.useRequestWithdrawal(),
        { amount: 80, method: 'pix' },
        'requestWithdrawal',
        [],
      ],
    ];

    it.each(failing)('%s', async (_name, use, variables, method, invalidates) => {
      mocked(method).mockRejectedValue(new Error('Recusado pela API'));
      const { wrapper, invalidated } = setup();
      const { result } = renderHook(use, { wrapper });

      await act(async () => {
        await expect(result.current.mutateAsync(variables as never)).rejects.toThrow(
          'Recusado pela API',
        );
      });

      expect(invalidated()).toEqual(keys(...invalidates));
    });
  });
});

describe('ordem do portfólio (ADR 43): muda na hora, grava em fila e volta se falhar', () => {
  const item = (id: number): PortfolioItem => ({ id, title: `Trabalho ${id}` }) as PortfolioItem;
  const saved = [item(1), item(2), item(3)];
  const order = (client: QueryClient) =>
    client.getQueryData<PortfolioItem[]>(['portfolio'])?.map((i) => i.id);

  it('a lista muda antes de a API responder e, gravada, recarrega o portfólio e o perfil público', async () => {
    const pending = deferred<PortfolioItem[]>();
    mocked('reorderPortfolio').mockReturnValue(pending.promise);
    const { client, wrapper, invalidated } = setup();
    client.setQueryData(['portfolio'], saved);
    const { result } = renderHook(() => hooks.usePortfolioMutation(), { wrapper });

    act(() => result.current.reorder.mutate([3, 1, 2]));

    await waitFor(() => expect(order(client)).toEqual([3, 1, 2]));
    expect(mocked('reorderPortfolio')).toHaveBeenCalledWith([3, 1, 2]);
    expect(invalidated()).toEqual([]);

    await act(async () => {
      pending.resolve([item(3), item(1), item(2)]);
      await pending.promise;
    });

    await waitFor(() => expect(invalidated()).toEqual(keys(['portfolio'], ['publicFreelancer'])));
    expect(order(client)).toEqual([3, 1, 2]);
  });

  it('gravação recusada devolve a lista à ordem de antes', async () => {
    const pending = deferred<PortfolioItem[]>();
    mocked('reorderPortfolio').mockReturnValue(pending.promise);
    const { client, wrapper, invalidated } = setup();
    client.setQueryData(['portfolio'], saved);
    const { result } = renderHook(() => hooks.usePortfolioMutation(), { wrapper });

    act(() => result.current.reorder.mutate([2, 3, 1]));
    await waitFor(() => expect(order(client)).toEqual([2, 3, 1]));

    await act(async () => {
      pending.reject(new Error('Não foi possível mudar a ordem'));
      await pending.promise.catch(() => undefined);
    });

    await waitFor(() => expect(result.current.reorder.isError).toBe(true));
    expect(order(client)).toEqual([1, 2, 3]);
    expect(result.current.reorder.error?.message).toBe('Não foi possível mudar a ordem');
    // Mesmo no erro a lista é conferida com o servidor ao fim da fila.
    expect(invalidated()).toEqual(keys(['portfolio'], ['publicFreelancer']));
  });

  it('dois cliques seguidos: os pedidos saem um por vez e só o último recarrega', async () => {
    const first = deferred<PortfolioItem[]>();
    const second = deferred<PortfolioItem[]>();
    mocked('reorderPortfolio')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { client, wrapper, invalidated } = setup();
    client.setQueryData(['portfolio'], saved);
    const { result } = renderHook(() => hooks.usePortfolioMutation(), { wrapper });

    act(() => {
      result.current.reorder.mutate([2, 1, 3]);
      result.current.reorder.mutate([2, 3, 1]);
    });

    // A tela já mostra a ordem do segundo clique, mas só o primeiro pedido saiu.
    await waitFor(() => expect(order(client)).toEqual([2, 3, 1]));
    expect(mocked('reorderPortfolio')).toHaveBeenCalledTimes(1);
    expect(mocked('reorderPortfolio')).toHaveBeenLastCalledWith([2, 1, 3]);

    await act(async () => {
      first.resolve([]);
      await first.promise;
    });
    await waitFor(() => expect(mocked('reorderPortfolio')).toHaveBeenCalledTimes(2));
    expect(mocked('reorderPortfolio')).toHaveBeenLastCalledWith([2, 3, 1]);
    // Recarregar no meio da fila traria a ordem do primeiro pedido por cima da tela.
    expect(invalidated()).toEqual([]);

    await act(async () => {
      second.resolve([]);
      await second.promise;
    });
    await waitFor(() => expect(invalidated()).toEqual(keys(['portfolio'], ['publicFreelancer'])));
    expect(order(client)).toEqual([2, 3, 1]);
  });

  it('uma leitura do portfólio ainda em andamento não desfaz a ordem nova na tela', async () => {
    const stale = deferred<PortfolioItem[]>();
    const saving = deferred<PortfolioItem[]>();
    const reordered = [item(3), item(1), item(2)];
    mocked('myPortfolio')
      .mockResolvedValueOnce(saved)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(reordered);
    mocked('reorderPortfolio').mockReturnValue(saving.promise);
    const { client, wrapper } = setup();
    const { result } = renderHook(
      () => ({ list: hooks.usePortfolio(), reorder: hooks.usePortfolioMutation().reorder }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.data).toEqual(saved));

    // A tela recarrega a lista e, antes de a resposta chegar, a pessoa muda a ordem.
    act(() => {
      void result.current.list.refetch();
    });
    expect(mocked('myPortfolio')).toHaveBeenCalledTimes(2);
    act(() => result.current.reorder.mutate([3, 1, 2]));
    await waitFor(() => expect(order(client)).toEqual([3, 1, 2]));

    // A leitura velha chega depois e é descartada: a ordem da tela não volta.
    await act(async () => {
      stale.resolve(saved);
      await stale.promise;
    });
    expect(order(client)).toEqual([3, 1, 2]);

    await act(async () => {
      saving.resolve(reordered);
      await saving.promise;
    });
    await waitFor(() => expect(mocked('myPortfolio')).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.list.isFetching).toBe(false));
    expect(order(client)).toEqual([3, 1, 2]);
  });

  it('sem lista carregada e gravação recusada: continua sem lista, com o erro para a tela', async () => {
    mocked('reorderPortfolio').mockRejectedValue(new Error('Não foi possível mudar a ordem'));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => hooks.usePortfolioMutation(), { wrapper });

    await act(async () => {
      await expect(result.current.reorder.mutateAsync([2, 1])).rejects.toThrow(
        'Não foi possível mudar a ordem',
      );
    });

    expect(client.getQueryData(['portfolio'])).toBeUndefined();
  });

  it('sem lista carregada não inventa uma: só grava e recarrega', async () => {
    mocked('reorderPortfolio').mockResolvedValue([]);
    const { client, wrapper, invalidated } = setup();
    const { result } = renderHook(() => hooks.usePortfolioMutation(), { wrapper });

    await act(async () => {
      await result.current.reorder.mutateAsync([2, 1]);
    });

    expect(client.getQueryData(['portfolio'])).toBeUndefined();
    expect(mocked('reorderPortfolio')).toHaveBeenCalledWith([2, 1]);
    expect(invalidated()).toEqual(keys(['portfolio'], ['publicFreelancer']));
  });
});
