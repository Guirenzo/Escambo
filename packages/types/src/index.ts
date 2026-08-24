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

// --- Serviços ---

export type ServicePriceType = 'fixed' | 'hourly' | 'negotiable';

export interface Service {
  id: number;
  categoryId: number;
  ownerId: number;
  title: string;
  description: string;
  priceType: ServicePriceType;
  price: number | null;
  deliveryDays: number | null;
  isRemote: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface CreateServiceRequest {
  categoryId: number;
  title: string;
  description: string;
  priceType?: ServicePriceType;
  price?: number | null;
  deliveryDays?: number | null;
  isRemote?: boolean;
}

export type UpdateServiceRequest = Partial<CreateServiceRequest> & { isActive?: boolean };

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
}

// --- Contratações ---

export type ContractStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'in_progress'
  | 'delivered'
  | 'revision_requested'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface Contract {
  id: number;
  ulid: string;
  clientId: number;
  freelancerId: number;
  serviceId: number | null;
  title: string;
  description: string;
  price: number;
  platformFee: number;
  freelancerNet: number;
  status: ContractStatus;
  deadlineAt: string | null;
  createdAt: string;
}

export interface ContractStatusHistoryEntry {
  previousStatus: ContractStatus | null;
  status: ContractStatus;
  note: string | null;
  at: string;
}

export interface ContractWithHistory extends Contract {
  history: ContractStatusHistoryEntry[];
}

export interface CreateContractRequest {
  freelancerId: number;
  serviceId?: number | null;
  title: string;
  description: string;
  price: number;
  deadlineAt?: string | null;
}

export interface CancelResult {
  status: ContractStatus;
  refundPercentage: number;
}

/** Formato padronizado de erro da API (ver error-handler / RNF-039). */
export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, string[] | undefined>;
}
