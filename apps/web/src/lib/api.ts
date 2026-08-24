import type { ApiError, AuthResponse, LoginRequest, PublicUser, RegisterRequest } from '@escambo/types';

const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data as ApiError;
    throw new Error(err.message ?? err.error ?? `Erro ${res.status}`);
  }

  return data as T;
}

/** Client tipado da API — os tipos vêm de @escambo/types (compartilhados com o backend). */
export const api = {
  health: () => request<{ status: string; db: string; timestamp: string }>('/health'),
  register: (body: RegisterRequest) =>
    request<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: LoginRequest) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
};
