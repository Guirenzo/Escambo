/**
 * Tipos de domínio compartilhados entre a API (@escambo/api) e o front (@escambo/web).
 * Fonte única da verdade dos contratos — evita divergência entre back e front.
 */

export type UserRole = 'client' | 'freelancer' | 'company' | 'admin';

export type UserStatus = 'active' | 'suspended' | 'banned' | 'pending_verification';

/** Usuário como exposto publicamente (sem hash de senha, sem id interno). */
export interface PublicUser {
  ulid: string;
  email: string;
  role: UserRole;
}

export interface RegisterRequest {
  email: string;
  password: string;
  role?: Exclude<UserRole, 'admin'>;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/** Formato padronizado de erro da API (ver error-handler / RNF-039). */
export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, string[] | undefined>;
}
