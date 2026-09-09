import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateBarterRequest,
  CreateBoostRequest,
  CreateContentReportRequest,
  CreateContractRequest,
  CreateReviewRequest,
  FavoriteTargetType,
  OpenDisputeRequest,
  ResolveDisputeRequest,
  CreateServiceRequest,
  UpsertClientProfileRequest,
  UpsertFreelancerProfileRequest,
} from '@escambo/types';
import { api, type ServiceQuery } from './api';

/** Chaves de cache — centralizadas para invalidação consistente. */
export const qk = {
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
  notifications: ['notifications'] as const,
  barters: ['barters'] as const,
  profiles: ['profiles'] as const,
  favorites: ['favorites'] as const,
  disputes: ['disputes'] as const,
  adminMetrics: ['adminMetrics'] as const,
  adminDisputes: ['adminDisputes'] as const,
  exportRequests: ['exportRequests'] as const,
  deletionRequests: ['deletionRequests'] as const,
  reviews: (freelancerId: number) => ['reviews', freelancerId] as const,
  publicFreelancer: (ulid: string) => ['publicFreelancer', ulid] as const,
};

// ---------- Queries ----------
export const useWallet = () => useQuery({ queryKey: qk.wallet, queryFn: () => api.wallet() });
export const useGamification = () =>
  useQuery({ queryKey: qk.gamification, queryFn: () => api.gamification() });
export const useLeaderboard = () =>
  useQuery({ queryKey: qk.leaderboard, queryFn: () => api.leaderboard() });
export const useCategories = () =>
  useQuery({ queryKey: qk.categories, queryFn: () => api.categories(), staleTime: 5 * 60_000 });
export const useServices = (p?: ServiceQuery) =>
  useQuery({ queryKey: qk.services(p), queryFn: () => api.listServices(p) });
export const useContracts = () =>
  useQuery({ queryKey: qk.contracts, queryFn: () => api.contracts() });
export const useContractDetail = (id: number) =>
  useQuery({ queryKey: qk.contract(id), queryFn: () => api.contractDetail(id) });
export const useChatHistory = (id: number) =>
  useQuery({ queryKey: qk.chat(id), queryFn: () => api.chatHistory(id) });
export const useWithdrawals = () =>
  useQuery({ queryKey: qk.withdrawals, queryFn: () => api.withdrawals() });
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
type ContractAction = 'accept' | 'reject' | 'approve' | 'cancel';

export function useContractAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: ContractAction }) =>
      api.contractAction(id, action),
    onSuccess: (_d, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
      void qc.invalidateQueries({ queryKey: qk.wallet });
      void qc.invalidateQueries({ queryKey: qk.gamification });
    },
  });
}

/** Cliente pede ajustes numa entrega: volta para o freelancer com o motivo. */
export function useRequestRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => api.requestRevision(id, note),
    onSuccess: (_d, { id }) => {
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

export function useCreateService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServiceRequest) => api.createService(body),
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

export function useRequestWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { amount: number; method: 'pix' | 'bank'; pixKey?: string }) =>
      api.requestWithdrawal(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.withdrawals });
      void qc.invalidateQueries({ queryKey: qk.wallet });
    },
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
export const useCreditTransactions = () =>
  useQuery({ queryKey: qk.creditTransactions, queryFn: () => api.creditTransactions() });
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
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: qk.disputes });
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(d.contractId) });
    },
  });
}

export function useCreateReport() {
  return useMutation({ mutationFn: (body: CreateContentReportRequest) => api.createReport(body) });
}

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

export const useAdminMetrics = () =>
  useQuery({ queryKey: qk.adminMetrics, queryFn: () => api.adminMetrics() });
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

export function useModerateUser() {
  return useMutation({
    mutationFn: ({ ulid, action }: { ulid: string; action: 'suspend' | 'ban' | 'reactivate' }) =>
      api.adminModerateUser(ulid, action),
  });
}
