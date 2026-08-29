import type {
  AuthResponse,
  Contract,
  GamificationProfile,
  LoginRequest,
  NotificationList,
  Paginated,
  PublicUser,
  RegisterRequest,
  Wallet,
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
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `Erro ${res.status}`);
  }
  return data as T;
}

/** Client tipado — todos os tipos vêm de @escambo/types (compartilhados com o backend). */
export const api = {
  register: (body: RegisterRequest) =>
    request<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: LoginRequest) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  me: () => request<PublicUser>('/auth/me'),
  wallet: () => request<Wallet>('/wallet'),
  gamification: () => request<GamificationProfile>('/gamification/me'),
  contracts: () => request<Paginated<Contract>>('/contracts'),
  notifications: () => request<NotificationList>('/notifications'),
};
