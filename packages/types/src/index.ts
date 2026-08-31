/**
 * Tipos de domínio compartilhados entre a API (@escambo/api) e o front (@escambo/web).
 * Fonte única da verdade dos contratos — evita divergência entre back e front.
 */

export type UserRole = 'client' | 'freelancer' | 'company' | 'admin';

export type UserStatus = 'active' | 'suspended' | 'banned' | 'pending_verification';

/** Usuário como exposto publicamente (sem hash de senha, sem id interno). */
export interface PublicUser {
  id: number;
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

// --- Favoritos ---

export type FavoriteTargetType = 'service' | 'freelancer';

export interface Favorite {
  id: number;
  targetType: FavoriteTargetType;
  targetId: number;
  createdAt: string;
}

export interface CreateFavoriteRequest {
  targetType: FavoriteTargetType;
  targetId: number;
}

// --- Buscas salvas ---

export interface SavedSearch {
  id: number;
  name: string | null;
  query: string | null;
  filters: Record<string, unknown> | null;
  alertEnabled: boolean;
  createdAt: string;
}

export interface CreateSavedSearchRequest {
  name?: string | null;
  query?: string | null;
  filters?: Record<string, unknown> | null;
  alertEnabled?: boolean;
}

// --- Denúncias (trust & safety) ---

export type ReportTargetType = 'user' | 'service' | 'review' | 'message';
export type ReportReason = 'spam' | 'fraud' | 'offensive' | 'off_platform' | 'illegal' | 'other';

export interface ContentReport {
  id: number;
  targetType: ReportTargetType;
  targetId: number;
  reason: ReportReason;
  status: string;
  createdAt: string;
}

export interface CreateContentReportRequest {
  targetType: ReportTargetType;
  targetId: number;
  reason: ReportReason;
  description?: string | null;
}

// --- Disputas ---

export type DisputeReason = 'not_delivered' | 'quality' | 'deadline' | 'scope' | 'payment' | 'other';
export type DisputeStatus = 'open' | 'under_review' | 'awaiting_parties' | 'resolved' | 'closed';
export type DisputeResolution = 'refund_client' | 'release_freelancer' | 'partial_split' | 'none';

export interface Dispute {
  id: number;
  ulid: string;
  contractId: number;
  openedBy: number;
  reason: DisputeReason;
  description: string;
  status: DisputeStatus;
  resolution: DisputeResolution | null;
  refundPercentage: number | null;
  createdAt: string;
}

export interface OpenDisputeRequest {
  contractId: number;
  reason: DisputeReason;
  description: string;
}

export interface ResolveDisputeRequest {
  resolution: DisputeResolution;
  refundPercentage?: number | null; // obrigatório em partial_split
  note?: string | null;
}

// --- Admin ---

export interface AdminMetrics {
  users: number;
  freelancers: number;
  contracts: number;
  completedContracts: number;
  openDisputes: number;
  platformFees: number;
}

// --- LGPD ---

export type ConsentType = 'terms_of_use' | 'privacy_policy' | 'marketing' | 'data_processing';

export interface Consent {
  type: ConsentType;
  version: string;
  accepted: boolean;
  at: string;
}

export interface DataDeletionRequest {
  id: number;
  reason: string | null;
  status: string;
  createdAt: string;
}

export interface DataExportRequest {
  id: number;
  status: string;
  fileUrl: string | null;
  createdAt: string;
}

export interface RecordConsentRequest {
  type: ConsentType;
  version: string;
  accepted: boolean;
}

// --- Notificações ---

export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationList {
  items: Notification[];
  unreadCount: number;
  page: number;
  limit: number;
}

// --- Perfis ---

export interface FreelancerProfile {
  fullName: string;
  avatarUrl: string | null;
  bio: string | null;
  headline: string | null;
  city: string | null;
  state: string | null;
  isAvailable: boolean;
  avgRating: number;
  totalReviews: number;
  totalContracts: number;
}

export interface ClientProfile {
  fullName: string;
  avatarUrl: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
}

export interface MyProfiles {
  freelancer: FreelancerProfile | null;
  client: ClientProfile | null;
}

export interface PublicFreelancerProfile extends FreelancerProfile {
  userUlid: string;
  level: number;
  levelName: string;
}

export interface UpsertFreelancerProfileRequest {
  fullName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  headline?: string | null;
  city?: string | null;
  state?: string | null;
  isAvailable?: boolean;
}

export interface UpsertClientProfileRequest {
  fullName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  city?: string | null;
  state?: string | null;
}

// --- Categorias ---

export interface Category {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  iconUrl: string | null;
  children: Category[];
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

// --- Chat em tempo real (mensagens do contrato) ---

export interface ChatMessage {
  id: number;
  conversationId: number;
  senderId: number;
  content: string;
  createdAt: string;
}

export interface ChatHistory {
  conversationId: number;
  contractId: number;
  otherPartyId: number;
  messages: ChatMessage[];
}

export interface SendMessageRequest {
  content: string;
}

/** Payload emitido no evento realtime `message:new`. */
export type ChatMessageEvent = ChatMessage & { contractId: number };

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

// --- Troca de Serviços (Escambo) ---

export type BarterStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface BarterAgreement {
  id: number;
  ulid: string;
  proposerId: number;
  receiverId: number;
  offeredServiceId: number | null;
  requestedServiceId: number | null;
  offeredDescription: string | null;
  requestedDescription: string | null;
  estimatedValueOffered: number;
  estimatedValueRequested: number;
  cashDifference: number; // torna
  cashPayerId: number | null;
  platformFee: number;
  status: BarterStatus;
  contractOfferedId: number | null;
  contractRequestedId: number | null;
  createdAt: string;
}

export interface CreateBarterRequest {
  receiverId: number;
  offeredServiceId?: number | null;
  offeredDescription?: string | null;
  requestedServiceId?: number | null;
  requestedDescription?: string | null;
  estimatedValueOffered: number;
  estimatedValueRequested: number;
}

// --- Saques ---

export type WithdrawalMethod = 'pix' | 'bank';
export type WithdrawalStatus = 'requested' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Withdrawal {
  id: number;
  amount: number;
  status: WithdrawalStatus;
  method: WithdrawalMethod;
  maskedDestination: string; // chave PIX / conta mascarada
  createdAt: string;
  processedAt: string | null;
}

export interface CreateWithdrawalRequest {
  amount: number;
  method: WithdrawalMethod;
  pixKey?: string | null;
  bankName?: string | null;
  bankAgency?: string | null;
  bankAccount?: string | null;
}

/** Formato padronizado de erro da API (ver error-handler / RNF-039). */
export interface ApiError {
  error: string;
  message?: string;
  details?: Record<string, string[] | undefined>;
}
