import type {
  AuthResponse,
  Category,
  ClientProfile,
  Contract,
  CreateServiceRequest,
  FreelancerProfile,
  GamificationProfile,
  LoginRequest,
  MyProfiles,
  NotificationList,
  Paginated,
  PublicUser,
  RegisterRequest,
  Service,
  UpsertClientProfileRequest,
  UpsertFreelancerProfileRequest,
  Wallet,
  Withdrawal,
} from '@escambo/types';

const BASE_URL = '/api';
const TOKEN_KEY = 'escambo_token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let accessToken: string | null = readToken();

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage indisponível — segue com o token em memória */
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
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

  // dashboard
  wallet: () => request<Wallet>('/wallet'),
  gamification: () => request<GamificationProfile>('/gamification/me'),

  // categorias & serviços
  categories: () => request<Category[]>('/categories'),
  listServices: (q?: string) =>
    request<Paginated<Service>>(`/services${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createService: (body: CreateServiceRequest) =>
    request<Service>('/services', { method: 'POST', body: JSON.stringify(body) }),

  // contratações
  contracts: () => request<Paginated<Contract>>('/contracts'),
  contractAction: (id: number, action: 'accept' | 'reject' | 'approve' | 'cancel') =>
    request<Contract>(`/contracts/${id}/${action}`, { method: 'POST' }),
  deliverContract: (id: number, message: string) =>
    request<Contract>(`/contracts/${id}/deliver`, { method: 'POST', body: JSON.stringify({ message }) }),

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

  // perfis
  profilesMe: () => request<MyProfiles>('/profiles/me'),
  putFreelancerProfile: (body: UpsertFreelancerProfileRequest) =>
    request<FreelancerProfile>('/profiles/freelancer', { method: 'PUT', body: JSON.stringify(body) }),
  putClientProfile: (body: UpsertClientProfileRequest) =>
    request<ClientProfile>('/profiles/client', { method: 'PUT', body: JSON.stringify(body) }),
};
