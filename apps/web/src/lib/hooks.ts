import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateBarterRequest,
  CreateServiceRequest,
  UpsertClientProfileRequest,
  UpsertFreelancerProfileRequest,
} from '@escambo/types';
import { api } from './api';

/** Chaves de cache — centralizadas para invalidação consistente. */
export const qk = {
  wallet: ['wallet'] as const,
  gamification: ['gamification'] as const,
  leaderboard: ['leaderboard'] as const,
  categories: ['categories'] as const,
  services: (q?: string) => ['services', q ?? ''] as const,
  contracts: ['contracts'] as const,
  contract: (id: number) => ['contract', id] as const,
  chat: (id: number) => ['chat', id] as const,
  withdrawals: ['withdrawals'] as const,
  notifications: ['notifications'] as const,
  barters: ['barters'] as const,
  profiles: ['profiles'] as const,
};

// ---------- Queries ----------
export const useWallet = () => useQuery({ queryKey: qk.wallet, queryFn: () => api.wallet() });
export const useGamification = () =>
  useQuery({ queryKey: qk.gamification, queryFn: () => api.gamification() });
export const useLeaderboard = () =>
  useQuery({ queryKey: qk.leaderboard, queryFn: () => api.leaderboard() });
export const useCategories = () =>
  useQuery({ queryKey: qk.categories, queryFn: () => api.categories(), staleTime: 5 * 60_000 });
export const useServices = (q?: string) =>
  useQuery({ queryKey: qk.services(q), queryFn: () => api.listServices(q) });
export const useContracts = () => useQuery({ queryKey: qk.contracts, queryFn: () => api.contracts() });
export const useContractDetail = (id: number) =>
  useQuery({ queryKey: qk.contract(id), queryFn: () => api.contractDetail(id) });
export const useChatHistory = (id: number) =>
  useQuery({ queryKey: qk.chat(id), queryFn: () => api.chatHistory(id) });
export const useWithdrawals = () =>
  useQuery({ queryKey: qk.withdrawals, queryFn: () => api.withdrawals() });
export const useNotifications = () =>
  useQuery({ queryKey: qk.notifications, queryFn: () => api.notifications(), refetchInterval: 30_000 });
export const useBarters = () => useQuery({ queryKey: qk.barters, queryFn: () => api.barters() });
export const useProfilesMe = () => useQuery({ queryKey: qk.profiles, queryFn: () => api.profilesMe() });

// ---------- Mutations (invalidam o que mudou) ----------
type ContractAction = 'accept' | 'reject' | 'approve' | 'cancel';

export function useContractAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: ContractAction }) => api.contractAction(id, action),
    onSuccess: (_d, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.contracts });
      void qc.invalidateQueries({ queryKey: qk.contract(id) });
      void qc.invalidateQueries({ queryKey: qk.wallet });
      void qc.invalidateQueries({ queryKey: qk.gamification });
    },
  });
}

export function useDeliverContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }: { id: number; message: string }) => api.deliverContract(id, message),
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
