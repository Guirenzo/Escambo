import type {
  AuthResponse,
  BarterAgreement,
  Boost,
  BoostPlan,
  Category,
  ChatHistory,
  ChatMessage,
  ClientProfile,
  Contract,
  ContractWithHistory,
  CreateBarterRequest,
  CreateBoostRequest,
  CreateContractRequest,
  CreateReviewRequest,
  CreateServiceRequest,
  CreditTransaction,
  FreelancerProfile,
  GamificationProfile,
  LeaderboardEntry,
  LoginRequest,
  MyProfiles,
  NotificationList,
  Paginated,
  PublicFreelancerProfile,
  PublicUser,
  RefreshResponse,
  RegisterRequest,
  Review,
  Service,
  UpsertClientProfileRequest,
  UpsertFreelancerProfileRequest,
  Wallet,
  Withdrawal,
} from '@escambo/types';

const BASE_URL = '/api';
const TOKEN_KEY = 'escambo_token';
const REFRESH_KEY = 'escambo_refresh';

/** Eventos de sessão (ouvidos pelo AuthProvider e pelo socket). */
export const SESSION_TOKEN_EVENT = 'escambo:token';
export const SESSION_EXPIRED_EVENT = 'escambo:session-expired';

/** Filtros da busca de serviços (lat+lng+radiusKm = descoberta local por proximidade). */
export interface ServiceQuery {
  q?: string;
  categoryId?: number;
  ownerId?: number;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  page?: number;
  limit?: number;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage indisponível — segue com os tokens em memória */
  }
}
function emit(name: string, detail?: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* sem window (testes/SSR) */
  }
}

let accessToken: string | null = readStorage(TOKEN_KEY);
let refreshToken: string | null = readStorage(REFRESH_KEY);

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
  writeStorage(TOKEN_KEY, token);
  emit(SESSION_TOKEN_EVENT, token);
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

/** Guarda (ou limpa) o par de tokens da sessão. */
export function setSession(tokens: { accessToken: string; refreshToken: string } | null): void {
  refreshToken = tokens?.refreshToken ?? null;
  writeStorage(REFRESH_KEY, refreshToken);
  setToken(tokens?.accessToken ?? null);
}

let refreshing: Promise<boolean> | null = null;

/**
 * Renova o access token (expira em 1h) com o refresh token. Várias requisições que tomam 401
 * ao mesmo tempo compartilham UMA renovação (single-flight). Devolve false se a sessão acabou.
 */
async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as RefreshResponse;
        setSession({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

function expireSession(): void {
  setSession(null);
  emit(SESSION_EXPIRED_EVENT);
}

// Nessas rotas um 401 é resposta legítima (credenciais), não token vencido.
const NO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  // Access token vencido: renova e repete a chamada uma vez; se não der, encerra a sessão.
  if (res.status === 401 && retry && refreshToken && !NO_REFRESH.includes(path)) {
    if (await refreshSession()) return request<T>(path, options, false);
    expireSession();
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `Erro ${res.status}`);
  }
  return data as T;
}

/** Client tipado — todos os tipos vêm de @escambo/types (compartilhados com o backend). */
export const api = {
  // auth
  register: (body: RegisterRequest) =>
    request<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: LoginRequest) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () => request<PublicUser>('/auth/me'),
  logout: (refreshToken: string) =>
    request<void>('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),

  // dashboard
  wallet: () => request<Wallet>('/wallet'),
  gamification: () => request<GamificationProfile>('/gamification/me'),
  leaderboard: () => request<LeaderboardEntry[]>('/gamification/leaderboard'),

  // categorias & serviços
  categories: () => request<Category[]>('/categories'),
  listServices: (params: ServiceQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return request<Paginated<Service>>(`/services${s ? `?${s}` : ''}`);
  },
  createService: (body: CreateServiceRequest) =>
    request<Service>('/services', { method: 'POST', body: JSON.stringify(body) }),

  // contratações
  contracts: () => request<Paginated<Contract>>('/contracts'),
  createContract: (body: CreateContractRequest) =>
    request<Contract>('/contracts', { method: 'POST', body: JSON.stringify(body) }),
  contractDetail: (id: number) => request<ContractWithHistory>(`/contracts/${id}`),
  contractAction: (id: number, action: 'accept' | 'reject' | 'approve' | 'cancel') =>
    request<Contract>(`/contracts/${id}/${action}`, { method: 'POST' }),
  requestRevision: (id: number, note: string) =>
    request<Contract>(`/contracts/${id}/request-revision`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  deliverContract: (id: number, message: string) =>
    request<Contract>(`/contracts/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // chat do contrato
  chatHistory: (contractId: number) => request<ChatHistory>(`/messaging/contracts/${contractId}`),
  sendMessage: (contractId: number, content: string) =>
    request<ChatMessage>(`/messaging/contracts/${contractId}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  // carteira / saques
  withdrawals: () => request<Paginated<Withdrawal>>('/withdrawals'),
  requestWithdrawal: (body: { amount: number; method: 'pix' | 'bank'; pixKey?: string }) =>
    request<Withdrawal>('/withdrawals', { method: 'POST', body: JSON.stringify(body) }),

  // notificações
  notifications: () => request<NotificationList>('/notifications'),
  markNotificationRead: (id: number) =>
    request<void>(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () =>
    request<{ read: number }>('/notifications/read-all', { method: 'POST' }),

  // créditos Escambo (time-bank)
  creditTransactions: () => request<Paginated<CreditTransaction>>('/credits/transactions'),

  // impulsionamento (boosts)
  boostPlans: () => request<BoostPlan[]>('/boosts/plans'),
  myBoosts: () => request<Boost[]>('/boosts'),
  createBoost: (body: CreateBoostRequest) =>
    request<Boost>('/boosts', { method: 'POST', body: JSON.stringify(body) }),

  // trocas (escambo)
  barters: () => request<Paginated<BarterAgreement>>('/barters'),
  proposeBarter: (body: CreateBarterRequest) =>
    request<BarterAgreement>('/barters', { method: 'POST', body: JSON.stringify(body) }),
  barterAction: (id: number, action: 'accept' | 'reject' | 'cancel') =>
    request<BarterAgreement | void>(`/barters/${id}/${action}`, { method: 'POST' }),

  // perfis
  profilesMe: () => request<MyProfiles>('/profiles/me'),
  publicFreelancer: (ulid: string) =>
    request<PublicFreelancerProfile>(`/profiles/freelancer/${encodeURIComponent(ulid)}`),
  putFreelancerProfile: (body: UpsertFreelancerProfileRequest) =>
    request<FreelancerProfile>('/profiles/freelancer', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  putClientProfile: (body: UpsertClientProfileRequest) =>
    request<ClientProfile>('/profiles/client', { method: 'PUT', body: JSON.stringify(body) }),

  // avaliações (fecham o ciclo: aprovação → nota → Escambo Score)
  reviews: (freelancerId: number) =>
    request<Paginated<Review>>(`/reviews?freelancerId=${freelancerId}&limit=50`),
  createReview: (body: CreateReviewRequest) =>
    request<Review>('/reviews', { method: 'POST', body: JSON.stringify(body) }),
  respondReview: (id: number, response: string) =>
    request<{ ok: boolean }>(`/reviews/${id}/response`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    }),
};
