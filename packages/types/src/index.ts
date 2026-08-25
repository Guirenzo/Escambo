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

// --- Carteira ---

export interface Wallet {
  balance: number; // saldo disponível para saque
  balancePending: number; // retido em escrow
  currency: string;
}

// --- Avaliações ---

export interface Review {
  id: number;
  contractId: number;
  reviewerId: number;
  revieweeId: number;
  rating: number; // 1 a 5
  comment: string | null;
  response: string | null; // resposta do freelancer (RN-046)
  createdAt: string;
}

export interface CreateReviewRequest {
  contractId: number;
  rating: number;
  comment?: string | null;
}

// --- Gamificação ---

export interface Badge {
  slug: string;
  name: string;
  awardedAt: string;
}

export interface LevelProgress {
  level: number;
  levelName: string;
  currentLevelMin: number;
  nextLevelMin: number | null; // null = nível máximo
  xpIntoLevel: number; // XP acumulado dentro do nível atual
  xpToNextLevel: number | null; // XP faltando para o próximo nível
  percent: number; // 0–100 (barra de progresso)
}

export interface GamificationProfile {
  totalXp: number;
  level: number;
  levelName: string;
  progress: LevelProgress;
  streakDays: number; // sequência de dias ativos
  rank: number | null; // posição no ranking global por XP
  badges: Badge[];
}

export interface XpEvent {
  amount: number;
  reason: string;
  at: string;
}

export interface LeaderboardEntry {
  rank: number;
  userUlid: string;
  name: string | null;
  totalXp: number;
  level: number;
  levelName: string;
}

/** Formato padronizado de erro da API (ver error-handler / RNF-039). */
export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, string[] | undefined>;
}
