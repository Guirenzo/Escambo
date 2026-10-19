import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SupportTicketQuery,
  CreateSupportTicketRequest,
  ReplySupportTicketRequest,
  AdminReplySupportTicketRequest,
  UpdateSupportTicketRequest,
  CreateBarterRequest,
  CreateBoostRequest,
  CreateContentReportRequest,
  CreateContractRequest,
  CounterOfferRequest,
  ContractStatus,
  AdminReportAction,
  AppealDecision,
  CreateDepositRequest,
  CreateReviewRequest,
  CreateSavedSearchRequest,
  CreateServiceRequest,
  FavoriteTargetType,
  OpenDisputeRequest,
  PortfolioItem,
  ResolveDisputeRequest,
  UpdateSavedSearchRequest,
  UpdateServiceRequest,
  UpsertClientProfileRequest,
  UpsertFreelancerProfileRequest,
  UpsertPortfolioItemRequest,
  CreateWithdrawalRequest,
} from '@escambo/types';
import { api, type ServiceQuery } from './api';
import { orderByIds } from './reorder';

/** Chaves de cache — centralizadas para invalidação consistente. */
export const qk = {
  support: (admin: boolean) => ['support', admin ? 'admin' : 'own'] as const,
  supportTickets: (admin: boolean, query: SupportTicketQuery) =>
    ['support', admin ? 'admin' : 'own', 'list', query] as const,
  supportTicket: (admin: boolean, id: number | null) =>
    ['support', admin ? 'admin' : 'own', 'ticket', id] as const,
  wallet: ['wallet'] as const,
  gamification: ['gamification'] as const,
  leaderboard: ['leaderboard'] as const,
  categories: ['categories'] as const,
  services: (p?: ServiceQuery) => ['services', p ?? {}] as const,
  creditTransactions: ['creditTransactions'] as const,
  boostPlans: ['boostPlans'] as const,
  myBoosts: ['myBoosts'] as const,
  contracts: ['contracts'] as const,
  contract: (id: number) => ['contract', id] as const,
  chat: (id: number) => ['chat', id] as const,
  withdrawals: ['withdrawals'] as const,
  walletTransactions: ['walletTransactions'] as const,
  deposits: ['deposits'] as const,
  deposit: (id: number) => ['deposit', id] as const,
  adminWithdrawals: (status: string) => ['adminWithdrawals', status] as const,
  adminDeletions: (status: string) => ['adminDeletions', status] as const,
  adminEmails: ['adminEmails'] as const,
  adminReports: (status: string) => ['adminReports', status] as const,
  adminAppeals: (status: string) => ['adminAppeals', status] as const,
  myModeration: ['myModeration'] as const,
  myDropouts: ['myDropouts'] as const,
  adminDropouts: ['adminDropouts'] as const,
  adminUserDropouts: (ulid: string) => ['adminUserDropouts', ulid] as const,
  notifications: ['notifications'] as const,
  barters: ['barters'] as const,
  profiles: ['profiles'] as const,
  favorites: ['favorites'] as const,
  savedSearches: ['savedSearches'] as const,
  disputes: ['disputes'] as const,
  adminMetrics: ['adminMetrics'] as const,
  adminStorage: ['adminStorage'] as const,
  moderationHealth: (days: number) => ['moderationHealth', days] as const,
  adminSettings: ['adminSettings'] as const,
  publicSettings: ['publicSettings'] as const,
  adminDisputes: ['adminDisputes'] as const,
  exportRequests: ['exportRequests'] as const,
  consents: ['consents'] as const,
  deletionRequests: ['deletionRequests'] as const,
  reviews: (freelancerId: number) => ['reviews', freelancerId] as const,
  publicFreelancer: (ulid: string) => ['publicFreelancer', ulid] as const,
};

// ---------- Queries ----------
/** Só consulta periodicamente com a aba visível; TanStack também atualiza ao recuperar o foco. */
export const useSupportTickets = (query: SupportTicketQuery, admin = false) =>
  useQuery({
    queryKey: qk.supportTickets(admin, query),
    queryFn: () => (admin ? api.adminSupportTickets(query) : api.supportTickets(query)),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

/** A primeira janela é a conversa recente; as anteriores são carregadas sem perder as novas. */
export const useSupportTicket = (id: number | null, admin = false) =>
  useInfiniteQuery({
    queryKey: qk.supportTicket(admin, id),
    queryFn: ({ pageParam }) =>
      admin ? api.adminSupportTicket(id!, pageParam) : api.supportTicket(id!, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    enabled: id != null,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

export function useSupportActions(admin = false) {
  const qc = useQueryClient();
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: qk.support(admin) });
    void qc.invalidateQueries({ queryKey: qk.notifications });
  };
  return {
    create: useMutation({
      mutationFn: (body: CreateSupportTicketRequest) => api.createSupportTicket(body),
      onSuccess: refresh,
    }),
    reply: useMutation({
      mutationFn: ({
        id,
        body,
      }: {
        id: number;
        body: ReplySupportTicketRequest | AdminReplySupportTicketRequest;
      }) =>
        admin
          ? api.adminReplySupportTicket(id, body)
          : api.replySupportTicket(id, { message: body.message }),
      onSuccess: refresh,
    }),
    close: useMutation({
      mutationFn: (id: number) => api.closeSupportTicket(id),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: number; body: UpdateSupportTicketRequest }) =>
        api.adminUpdateSupportTicket(id, body),
      onSuccess: refresh,
    }),
  };
}

export const useWallet = () => useQuery({ queryKey: qk.wallet, queryFn: () => api.wallet() });
export const useGamification = () =>
  useQuery({ queryKey: qk.gamification, queryFn: () => api.gamification() });
export const useLeaderboard = () =>
  useQuery({ queryKey: qk.leaderboard, queryFn: () => api.leaderboard() });
export const useCategories = () =>
  useQuery({ queryKey: qk.categories, queryFn: () => api.categories(), staleTime: 5 * 60_000 });
export const useServices = (p?: ServiceQuery) =>
  useQuery({ queryKey: qk.services(p), queryFn: () => api.listServices(p) });
/** Tamanho da página da busca de serviços ("Carregar mais" traz a próxima). */
export const SERVICES_PAGE = 12;

/** Busca de serviços paginada: acumula páginas e sabe se há mais. */
export const useServicesInfinite = (p?: Omit<ServiceQuery, 'page' | 'limit'>) =>
  useInfiniteQuery({
    queryKey: ['services', 'infinite', p ?? {}] as const,
    queryFn: ({ pageParam }) =>
      api.listServices({ ...(p ?? {}), page: pageParam, limit: SERVICES_PAGE }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.items.length === SERVICES_PAGE ? last.page + 1 : undefined),
  });

export const CONTRACTS_PAGE = 20;

/**
 * Lista de contratações do painel (RF-040): acumula páginas ("carregar mais") e sabe pelo total da
 * API se há mais. A chave fica sob `qk.contracts`: toda ação que invalida a lista alcança o filtro.
 */
export const useContractList = (status: ContractStatus[] = []) =>
  useInfiniteQuery({
    queryKey: [...qk.contracts, 'list', status] as const,
    queryFn: ({ pageParam }) =>
      api.contracts({
        page: pageParam,
        limit: CONTRACTS_PAGE,
        ...(status.length > 0 ? { status } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) =>
      last.items.length > 0 && pages.reduce((n, p) => n + p.items.length, 0) < last.total
        ? last.page + 1
        : undefined,
  });
export const useContractDetail = (id: number) =>
  useQuery({ queryKey: qk.contract(id), queryFn: () => api.contractDetail(id) });
export const useChatHistory = (id: number) =>
  useQuery({ queryKey: qk.chat(id), queryFn: () => api.chatHistory(id) });
export const useWithdrawals = () =>
  useQuery({ queryKey: qk.withdrawals, queryFn: () => api.withdrawals() });
/** Tamanho da página dos extratos de R$ e de créditos ("Carregar mais" traz a próxima). */
export const WALLET_TX_PAGE = 20;

/** Período dos extratos (RF-047): dias "AAAA-MM-DD", no fuso da conta; vazio = tudo. */
export interface WalletPeriod {
  from?: string;
  to?: string;
}

/**
 * Extrato paginado e filtrado por período (R$ ou créditos): acumula as páginas e sabe se há mais
 * pelo `hasMore` da API. Período invertido não vai à API (a tela avisa). A chave começa pela do
 * extrato: o que invalida o extrato invalida todos os períodos e páginas.
 */
function usePeriodLedger<Page extends { page: number; hasMore: boolean }>(
  key: readonly string[],
  period: WalletPeriod,
  fetchPage: (query: WalletPeriod & { page: number; limit: number }) => Promise<Page>,
) {
  const p = { from: period.from || undefined, to: period.to || undefined };
  return useInfiniteQuery({
    queryKey: [...key, p] as const,
    queryFn: ({ pageParam }) => fetchPage({ ...p, page: pageParam, limit: WALLET_TX_PAGE }),
    initialPageParam: 1,
    getNextPageParam: (last: Page) => (last.hasMore ? last.page + 1 : undefined),
    enabled: !(p.from && p.to && p.from > p.to),
  });
}

/** Extrato de R$ por período (RF-047). */
export const useWalletTransactions = (period: WalletPeriod = {}) =>
  usePeriodLedger(qk.walletTransactions, period, (query) => api.walletTransactions(query));
export const useDeposits = () => useQuery({ queryKey: qk.deposits, queryFn: () => api.deposits() });
/** Situação de uma cobrança; enquanto pendente, consulta a cada 3 s (o webhook pode chegar a qualquer momento). */
export const useDeposit = (id: number | null, poll: boolean) =>
  useQuery({
    queryKey: qk.deposit(id ?? 0),
    queryFn: () => api.deposit(id!),
    enabled: id != null,
    refetchInterval: poll ? 3000 : false,
  });
export const useNotifications = () =>
  useQuery({
    queryKey: qk.notifications,
    queryFn: () => api.notifications(),
    refetchInterval: 30_000,
  });
export const useBarters = () => useQuery({ queryKey: qk.barters, queryFn: () => api.barters() });
export const useProfilesMe = () =>
  useQuery({ queryKey: qk.profiles, queryFn: () => api.profilesMe() });

// ---------- Mutations (invalidam o que mudou) ----------
type ContractAction = 'accept' | 'reject' | 'approve';

export function useContractAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, seq }: { id: number; action: ContractAction; seq?: number }) =>
      seq === undefined ? api.contractAction(id, action) : api.contractAction(id, action, seq),
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
      void qc.invalidateQueries({ queryKey: qk.wallet });
      void qc.invalidateQueries({ queryKey: qk.gamification });
      void qc.invalidateQueries({ queryKey: qk.walletTransactions });
      void qc.invalidateQueries({ queryKey: qk.creditTransactions });
    },
  });
}

/** Toda decisão usa a oferta vista; erros também recarregam a Sala e a reserva. */
export function useCounterOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: CounterOfferRequest & { id: number }) =>
      api.counterOffer(id, body),
    onSettled: (_d, _e, { id }) => {
      for (const queryKey of [qk.contracts, qk.contract(id), qk.wallet, qk.walletTransactions])
        void qc.invalidateQueries({ queryKey });
    },
  });
}

export function useAcceptCounterOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, seq }: { id: number; seq: number }) => api.acceptCounterOffer(id, seq),
    onSettled: (_d, _e, { id }) => {
      for (const queryKey of [
        qk.contracts,
        qk.contract(id),
        qk.wallet,
        qk.walletTransactions,
        qk.creditTransactions,
      ])
        void qc.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Cancelar (cliente) ou desistir (freelancer) com o valor que o modal mostrou (ADR 57). Devolve
 * o que foi liquidado, para o aviso; 409 cancel_quote_changed recarrega a contratação.
 */
export function useCancelContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      expectedRefund,
      expectedDropoutCount,
      seq,
    }: {
      id: number;
      expectedRefund?: number;
      expectedDropoutCount?: number;
      seq?: number;
    }) =>
      api.cancelContract(id, {
        ...(expectedRefund === undefined ? {} : { expectedRefund }),
        ...(expectedDropoutCount === undefined ? {} : { expectedDropoutCount }),
        ...(seq === undefined ? {} : { seq }),
      }),
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
      void qc.invalidateQueries({ queryKey: qk.wallet });
      void qc.invalidateQueries({ queryKey: qk.myDropouts });
      void qc.invalidateQueries({ queryKey: ['publicFreelancer'] });
    },
  });
}

export const useMyDropouts = () =>
  useQuery({ queryKey: qk.myDropouts, queryFn: () => api.myDropouts() });

function invalidateDropouts(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    qk.myDropouts,
    ['publicFreelancer'],
    qk.contracts,
    ['contract'],
    qk.adminDropouts,
    ['adminUserDropouts'],
    ['moderationHealth'],
    ['adminReports'],
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export function useAgreeDropout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.agreeDropout(id),
    onSettled: () => invalidateDropouts(qc),
  });
}

export function useAppealDropout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: number; text: string }) => api.appealDropout(id, text),
    onSettled: () => invalidateDropouts(qc),
  });
}

export const useAdminDropouts = () =>
  useQuery({ queryKey: qk.adminDropouts, queryFn: () => api.adminDropouts() });

export const useAdminUserDropouts = (ulid: string) =>
  useQuery({
    queryKey: qk.adminUserDropouts(ulid),
    queryFn: () => api.adminUserDropouts(ulid),
    enabled: Boolean(ulid),
  });

export function useAdminDropoutDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      note,
    }: {
      id: number;
      decision: 'excuse' | 'uphold';
      note: string;
    }) => api.adminDecideDropout(id, decision, note),
    onSettled: () => invalidateDropouts(qc),
  });
}

/** Cliente pede ajustes numa entrega: volta para o freelancer com o motivo. */
export function useRequestRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => api.requestRevision(id, note),
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
    },
  });
}

export function useGrantContractRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) => api.grantContractRevision(id),
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
    },
  });
}

export function useGrantMilestoneRevision(contractId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ milestoneId }: { milestoneId: number }) =>
      api.grantMilestoneRevision(contractId, milestoneId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(contractId) });
    },
  });
}

/** Extensão de prazo (RN-028): pedido do freelancer e decisão do cliente atualizam a Sala e a lista. */
export function useRequestExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deadlineAt, reason }: { id: number; deadlineAt: string; reason: string }) =>
      api.requestExtension(id, { deadlineAt, reason }),
    // Também no erro (ADR 57): um 409 quer dizer que a Sala está velha e precisa recarregar.
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
    },
  });
}

export function useResolveExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      seq,
    }: {
      id: number;
      decision: 'accept' | 'decline';
      seq?: number;
    }) => api.resolveExtension(id, decision, seq),
    // Também no erro: com o pedido trocado ou expirado (409), a Sala recarrega o pedido atual.
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
    },
  });
}

export function useDeliverContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }: { id: number; message: string }) =>
      api.deliverContract(id, message),
    onSuccess: (_d, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
    },
  });
}

/** Ação num marco (RN-069): atualiza a sala, a lista e a carteira (liberação parcial). */
export function useMilestoneAction(contractId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      action,
      text,
    }: {
      milestoneId: number;
      action: 'deliver' | 'approve' | 'request-revision';
      text?: string;
    }) => api.milestoneAction(contractId, milestoneId, action, text),
    onSuccess: (contract) => {
      qc.setQueryData(qk.contract(contractId), contract);
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.wallet });
      void qc.invalidateQueries({ queryKey: qk.walletTransactions });
      void qc.invalidateQueries({ queryKey: qk.gamification });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(contractId) });
    },
  });
}

export function useCreateService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServiceRequest) => api.createService(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['services'] }),
  });
}

/** Detalhe do serviço (debaixo de ['services']: editar e pausar já o recarregam). */
export const useService = (id: number) =>
  useQuery({
    queryKey: ['services', 'detail', id] as const,
    queryFn: () => api.service(id),
    enabled: Number.isInteger(id) && id > 0,
  });

/** "Meus serviços" (RF-030): debaixo de ['services'], então criar, editar e pausar já a recarregam. */
export const useMyServices = () =>
  useQuery({ queryKey: ['services', 'mine'] as const, queryFn: () => api.myServices() });

/** Edita, pausa ou reativa um serviço; recarrega a busca, o perfil público e "meus serviços". */
export function useUpdateService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateServiceRequest }) =>
      api.updateService(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['services'] }),
  });
}

export function useSendMessage(contractId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.sendMessage(contractId, content),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.chat(contractId) }),
  });
}

/**
 * Leitura (RF-059): marca como lidas as recebidas até a mensagem dada. Não recarrega o histórico:
 * quem mandou fica sabendo pelo evento `message:read`, e a própria Sala também o recebe.
 */
export function useMarkChatRead(contractId: number) {
  return useMutation({ mutationFn: (upTo: number) => api.markChatRead(contractId, upTo) });
}

/** Imagem ou arquivo no chat, com legenda opcional. */
export function useSendAttachment(contractId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, content }: { file: File; content?: string }) =>
      api.sendAttachment(contractId, file, content),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.chat(contractId) }),
  });
}

/** Bytes de um anexo do chat (exige o token). Fica em cache enquanto a Sala está aberta. */
export const useAttachmentBlob = (url: string, name: string, enabled = true) =>
  useQuery({
    queryKey: ['attachment', url] as const,
    queryFn: () => api.attachmentBlob(url, name),
    enabled,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

/** Tudo que muda quando dinheiro entra ou sai da carteira. */
const WALLET_KEYS = [qk.wallet, qk.walletTransactions, qk.deposits, qk.withdrawals] as const;
function invalidateWallet(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of WALLET_KEYS) void qc.invalidateQueries({ queryKey: key });
}

export function useCreateDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDepositRequest) => api.createDeposit(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.deposits }),
  });
}

export function useSimulateDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.simulateDeposit(id),
    onSuccess: (d) => {
      qc.setQueryData(qk.deposit(d.id), d);
      invalidateWallet(qc);
      void qc.invalidateQueries({ queryKey: qk.notifications });
    },
  });
}

export function useCancelWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.cancelWithdrawal(id),
    onSuccess: () => invalidateWallet(qc),
  });
}

export function useRequestWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWithdrawalRequest) => api.requestWithdrawal(body),
    onSuccess: () => invalidateWallet(qc),
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.markNotificationRead(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
  });
}

export function useProposeBarter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBarterRequest) => api.proposeBarter(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.barters }),
  });
}

export function useBarterAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'accept' | 'reject' | 'cancel' }) =>
      api.barterAction(id, action),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.barters });
      void qc.invalidateQueries({ queryKey: qk.contracts });
    },
  });
}

export function usePutFreelancerProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertFreelancerProfileRequest) => api.putFreelancerProfile(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.profiles }),
  });
}

export function usePutClientProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertClientProfileRequest) => api.putClientProfile(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.profiles }),
  });
}

// ---------- Fase B: diferenciais ----------
/** Extrato de créditos por período e com "Carregar mais", como o de R$ (RF-047). */
export const useCreditTransactions = (period: WalletPeriod = {}) =>
  usePeriodLedger(qk.creditTransactions, period, (query) => api.creditTransactions(query));
export const useBoostPlans = () =>
  useQuery({ queryKey: qk.boostPlans, queryFn: () => api.boostPlans(), staleTime: 5 * 60_000 });
export const useMyBoosts = () => useQuery({ queryKey: qk.myBoosts, queryFn: () => api.myBoosts() });

/** Cliente contrata um serviço (dinheiro ou créditos Escambo). */
export function useCreateContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateContractRequest) => api.createContract(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.wallet });
    },
  });
}

/** Freelancer impulsiona um serviço seu (paga em créditos). */
export function useCreateBoost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBoostRequest) => api.createBoost(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      void qc.invalidateQueries({ queryKey: qk.myBoosts });
      void qc.invalidateQueries({ queryKey: qk.wallet });
      void qc.invalidateQueries({ queryKey: qk.creditTransactions });
    },
  });
}

// ---------- Avaliações ----------
export const useFreelancerReviews = (freelancerId: number | undefined) =>
  useQuery({
    queryKey: qk.reviews(freelancerId ?? 0),
    queryFn: () => api.reviews(freelancerId!),
    enabled: !!freelancerId,
  });

/** Cliente avalia uma contratação concluída: atualiza contrato, perfil (nota) e score. */
export function useCreateReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReviewRequest) => api.createReview(body),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.contract(r.contractId) });
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.reviews(r.revieweeId) });
      void qc.invalidateQueries({ queryKey: qk.profiles });
      void qc.invalidateQueries({ queryKey: qk.gamification });
      void qc.invalidateQueries({ queryKey: qk.leaderboard });
      void qc.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

/** Freelancer responde (uma vez) a uma avaliação recebida. */
export function useRespondReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, response }: { id: number; response: string }) =>
      api.respondReview(id, response),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      void qc.invalidateQueries({ queryKey: ['contract'] });
    },
  });
}

// ---------- Perfil público ----------
export const usePublicFreelancer = (ulid: string | undefined) =>
  useQuery({
    queryKey: qk.publicFreelancer(ulid ?? ''),
    queryFn: () => api.publicFreelancer(ulid!),
    enabled: !!ulid,
  });

// ---------- Favoritos ----------
export const useFavorites = () =>
  useQuery({ queryKey: qk.favorites, queryFn: () => api.favorites() });

/** Liga/desliga favorito de um serviço ou freelancer. */
export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetType,
      targetId,
      favorited,
    }: {
      targetType: FavoriteTargetType;
      targetId: number;
      favorited: boolean;
    }) =>
      favorited
        ? api.removeFavorite(targetType, targetId)
        : api.addFavorite({ targetType, targetId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.favorites }),
  });
}

// ---------- Disputas, denúncias, LGPD e admin ----------
export const useMyDisputes = () =>
  useQuery({ queryKey: qk.disputes, queryFn: () => api.disputes() });

export function useOpenDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OpenDisputeRequest) => api.openDispute(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.disputes });
    },
    onSettled: (_d, _e, { contractId }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(contractId) });
    },
  });
}

export function useCreateReport() {
  return useMutation({ mutationFn: (body: CreateContentReportRequest) => api.createReport(body) });
}

/** Uma consulta por carga do app: o Shell e o Perfil dividem, e quem grava invalida. */
export const useConsents = () =>
  useQuery({ queryKey: qk.consents, queryFn: () => api.consents(), staleTime: Infinity });
export const useExportRequests = () =>
  useQuery({ queryKey: qk.exportRequests, queryFn: () => api.exportRequests() });
export const useDeletionRequests = () =>
  useQuery({ queryKey: qk.deletionRequests, queryFn: () => api.deletionRequests() });

export function useRequestExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.requestExport(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.exportRequests }),
  });
}

export function useRequestDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string | null) => api.requestDeletion(reason),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.deletionRequests }),
  });
}

/** Portfólio do freelancer (meu): lista, adiciona e remove — o público vem no perfil por ulid. */
export const usePortfolio = () =>
  useQuery({ queryKey: ['portfolio'] as const, queryFn: () => api.myPortfolio() });

export function usePortfolioMutation() {
  const qc = useQueryClient();
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['portfolio'] });
  };
  return {
    add: useMutation({
      mutationFn: (body: UpsertPortfolioItemRequest) => api.addPortfolioItem(body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number) => api.removePortfolioItem(id),
      onSuccess: invalidate,
    }),
    /**
     * Nova ordem (ADR 43): a lista muda na hora e os pedidos vão um de cada vez, na ordem dos
     * cliques. Se um falhar, a lista volta; ao fim da fila, recarrega do servidor.
     */
    reorder: useMutation({
      mutationKey: ['portfolio', 'order'],
      scope: { id: 'portfolio-order' },
      mutationFn: (ids: number[]) => api.reorderPortfolio(ids),
      onMutate: async (ids) => {
        await qc.cancelQueries({ queryKey: ['portfolio'] });
        const previous = qc.getQueryData<PortfolioItem[]>(['portfolio']);
        if (previous) qc.setQueryData(['portfolio'], orderByIds(previous, ids));
        return { previous };
      },
      onError: (_error, _ids, context) => {
        if (context?.previous) qc.setQueryData(['portfolio'], context.previous);
      },
      onSettled: () => {
        if (qc.isMutating({ mutationKey: ['portfolio', 'order'] }) === 1) {
          invalidate();
          void qc.invalidateQueries({ queryKey: ['publicFreelancer'] });
        }
      },
    }),
  };
}

export const useAdminFinance = (q: { from?: string; to?: string; granularity: 'day' | 'month' }) =>
  useQuery({ queryKey: ['adminFinance', q] as const, queryFn: () => api.adminFinance(q) });

export const useAdminMetrics = () =>
  useQuery({ queryKey: qk.adminMetrics, queryFn: () => api.adminMetrics() });
export const useAdminStorage = () =>
  useQuery({ queryKey: qk.adminStorage, queryFn: () => api.adminStorage() });

/** Saúde da moderação (ADR 47); recarrega quando a fila ou uma contestação muda. */
export const useModerationHealth = (days: number) =>
  useQuery({
    queryKey: qk.moderationHealth(days),
    queryFn: () => api.adminModerationHealth(days),
  });
export const useAdminSettings = () =>
  useQuery({ queryKey: qk.adminSettings, queryFn: () => api.adminSettings() });
/** Comissão e prazos que a plataforma pratica agora (muda pelo painel admin). */
export const usePublicSettings = () =>
  useQuery({
    queryKey: qk.publicSettings,
    queryFn: () => api.publicSettings(),
    staleTime: 5 * 60_000,
  });
/**
 * Muda um parâmetro; recarrega o painel, o armazenamento (retenção), os públicos (taxa) e a saúde
 * da moderação (meta e chave do relatório diário, ADR 55).
 */
export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: number | boolean }) =>
      api.adminUpdateSetting(key, value),
    onSuccess: () => {
      for (const key of [qk.adminSettings, qk.adminStorage, qk.publicSettings]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      void qc.invalidateQueries({ queryKey: ['moderationHealth'] });
    },
  });
}
/** Expurgo imediato de anexos; ao terminar, o card de armazenamento é recarregado. */
export function usePurgeAttachments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.adminPurgeAttachments(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.adminStorage }),
  });
}
export const useAdminDisputes = () =>
  useQuery({ queryKey: qk.adminDisputes, queryFn: () => api.adminDisputes() });

export function useResolveDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ResolveDisputeRequest }) =>
      api.adminResolveDispute(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.adminDisputes });
      void qc.invalidateQueries({ queryKey: qk.adminMetrics });
      void qc.invalidateQueries({ queryKey: qk.disputes });
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: ['contract'] });
    },
  });
}

export const useAdminEmails = () =>
  useQuery({ queryKey: qk.adminEmails, queryFn: () => api.adminEmails(50) });

export const useAdminDeletionRequests = (status: 'pending' | 'all') =>
  useQuery({
    queryKey: qk.adminDeletions(status),
    queryFn: () => api.adminDeletionRequests(status),
  });

export function useAdminDeletionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      note,
    }: {
      id: number;
      action: 'complete' | 'reject';
      note?: string;
    }) => api.adminDeletionAction(id, action, note ? { note } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['adminDeletions'] });
      void qc.invalidateQueries({ queryKey: qk.adminMetrics });
    },
  });
}

export const useAdminWithdrawals = (status: 'open' | 'all') =>
  useQuery({ queryKey: qk.adminWithdrawals(status), queryFn: () => api.adminWithdrawals(status) });

export function useAdminWithdrawalAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: number;
      action: 'process' | 'complete' | 'fail';
      body?: { gatewayRef?: string | null; reason?: string | null };
    }) => api.adminWithdrawalAction(id, action, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['adminWithdrawals'] });
      void qc.invalidateQueries({ queryKey: qk.adminMetrics });
    },
  });
}

/** Fila de moderação do admin (ADR 39). */
export const useAdminReports = (status: 'pending' | 'resolved') =>
  useQuery({ queryKey: qk.adminReports(status), queryFn: () => api.adminReports(status) });

/** Dispensar, resolver ou remover a imagem de um grupo de denúncias. */
export function useAdminReportAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      note,
    }: {
      id: number;
      action: AdminReportAction;
      note: string | null;
    }) => api.adminReportAction(id, action, { note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['adminReports'] });
      void qc.invalidateQueries({ queryKey: qk.adminStorage });
      void qc.invalidateQueries({ queryKey: ['moderationHealth'] });
    },
  });
}

/** Imagens removidas da conta e a reincidência (ADR 41). */
export const useMyModeration = () =>
  useQuery({ queryKey: qk.myModeration, queryFn: () => api.myModeration() });

/** Contesta uma remoção; a lista do perfil recarrega com a contestação. */
export function useAppealRemoval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: number; text: string }) => api.appealRemoval(id, text),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.myModeration });
    },
  });
}

/** Contestações na fila do admin (ADR 41). */
export const useAdminAppeals = (status: 'pending' | 'decided') =>
  useQuery({ queryKey: qk.adminAppeals(status), queryFn: () => api.adminAppeals(status) });

/**
 * Arquivo guardado de uma contestação. A rota não usa cache, então a cópia fica na memória e a
 * miniatura e o diálogo usam a mesma.
 */
export const useAppealImage = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['appealImage', id],
    queryFn: async () => (await api.adminAppealImage(id)).blob,
    enabled,
    staleTime: Infinity,
    retry: false,
  });

/** Mantém ou reverte uma remoção contestada. */
export function useAdminAppealDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      note,
    }: {
      id: number;
      decision: AppealDecision;
      note: string | null;
    }) => api.adminDecideAppeal(id, decision, { note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['adminAppeals'] });
      void qc.invalidateQueries({ queryKey: ['moderationHealth'] });
      void qc.invalidateQueries({ queryKey: ['adminReports'] });
    },
  });
}

export function useModerateUser() {
  return useMutation({
    mutationFn: ({ ulid, action }: { ulid: string; action: 'suspend' | 'ban' | 'reactivate' }) =>
      api.adminModerateUser(ulid, action),
  });
}

/** Buscas salvas da conta (ADR 35). */
export const useSavedSearches = () =>
  useQuery({ queryKey: qk.savedSearches, queryFn: () => api.savedSearches() });

/** Criar, alterar (nome, alerta) e apagar buscas salvas; recarregam a lista. */
export function useSavedSearchMutations() {
  const qc = useQueryClient();
  const done = (): void => void qc.invalidateQueries({ queryKey: qk.savedSearches });
  return {
    create: useMutation({
      mutationFn: (body: CreateSavedSearchRequest) => api.createSavedSearch(body),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & UpdateSavedSearchRequest) =>
        api.updateSavedSearch(id, body),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.deleteSavedSearch(id), onSuccess: done }),
  };
}
