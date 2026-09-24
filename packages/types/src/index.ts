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
  /** E-mail confirmado pelo link enviado no cadastro (ou ao redefinir a senha). */
  emailVerified: boolean;
  /** Como o usuário quer os e-mails de notificação (ADR 27). */
  emailFrequency: EmailFrequency;
  /** Hora (0 a 23) do resumo do dia: e-mail diário e alertas diários de busca (ADR 42). */
  digestHour: number;
  /** Fuso da conta (ADR 46): vale para a hora do resumo e para as datas nos avisos. */
  timezone: BrazilTimezone;
  /**
   * A conta escolheu o fuso (ou nasceu com o do aparelho, ADR 51). Falso = ainda no padrão de
   * Brasília sem escolha: é quando o app sugere o fuso do aparelho, uma vez.
   */
  timezoneChosen: boolean;
  /** Janela de silêncio dos avisos no navegador (ADR 54); null = desligado. */
  quietHours: QuietHours | null;
}

/**
 * "Não perturbe" (ADR 54): horas cheias no fuso da conta, [start, end); start maior que end cruza
 * a meia-noite (22 → 7). Início igual ao fim não é uma janela.
 */
export interface QuietHours {
  start: number;
  end: number;
}

/** Avisos push no navegador (ADR 52): chave para assinar e aparelhos ligados nesta conta. */
export interface PushStatus {
  publicKey: string;
  devices: number;
  /** Este aparelho (o endpoint da consulta) recebe avisos desta conta? */
  subscribed: boolean;
  /** Avisos retidos pelo silêncio, ainda por ver, que o resumo ao fim da janela vai cobrir. */
  held: number;
}

/** Assinatura de um aparelho, como o navegador entrega. */
export interface PushSubscriptionRequest {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Resultado de um envio: entregues, aparelhos que sumiram e tentativas perdidas. */
export interface PushSendResult {
  sent: number;
  removed: number;
  failed: number;
}

/** Fusos do Brasil que a conta pode escolher (ADR 46); sem horário de verão desde 2019. */
export type BrazilTimezone =
  | 'America/Noronha'
  | 'America/Sao_Paulo'
  | 'America/Cuiaba'
  | 'America/Manaus'
  | 'America/Rio_Branco';

/** instant: um e-mail por evento · daily: resumo diário · off: só e-mails essenciais. */
export type EmailFrequency = 'instant' | 'daily' | 'off';

export interface EmailPreference {
  emailFrequency: EmailFrequency;
  /** Hora do resumo do dia; quem nunca escolheu fica com a hora padrão da plataforma. */
  digestHour: number;
  /** Fuso da conta; quem nunca escolheu fica em Brasília (ADR 46). */
  timezone: BrazilTimezone;
  /** Janela de silêncio dos avisos no navegador (ADR 54); null = desligado. */
  quietHours: QuietHours | null;
}

/** Muda só o que vier; `null` na hora ou no fuso volta ao padrão da plataforma. */
export interface UpdateEmailPreferenceRequest {
  emailFrequency?: EmailFrequency;
  digestHour?: number | null;
  timezone?: BrazilTimezone | null;
  /** Objeto inteiro ou null (desliga); nunca meia janela (ADR 54). */
  quietHours?: QuietHours | null;
}

export interface ForgotPasswordRequest {
  email: string;
}
export interface ResetPasswordRequest {
  token: string;
  password: string;
}
export interface VerifyEmailRequest {
  token: string;
}

/** E-mail registrado na caixa de saída (painel admin; no provedor simulado é a própria entrega). */
export interface AdminEmail {
  id: number;
  userId: number | null;
  to: string;
  subject: string;
  template: 'verify_email' | 'password_reset' | 'notification' | 'digest';
  text: string;
  status: 'queued' | 'sent' | 'failed';
  provider: string;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  role?: Exclude<UserRole, 'admin'>;
  /** Fuso do aparelho, quando é um dos do Brasil (ADR 51); sem ele, a conta fica em Brasília. */
  timezone?: BrazilTimezone;
  /** O aceite dos Termos e da Política: a API grava o consentimento na versão vigente (ADR 54). */
  legalAccepted: true;
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

/** Filtros de uma busca salva (ADR 35): os mesmos da busca de serviços, sem ordenação. */
export interface SavedSearchFilters {
  categoryId?: number;
  isRemote?: boolean;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  minPrice?: number;
  maxPrice?: number;
  maxDeliveryDays?: number;
  minRating?: number;
  day?: number;
  period?: AvailabilityPeriod;
}

/** Com que frequência a busca salva avisa de serviço novo (ADR 37). */
export type SavedSearchAlertFrequency = 'instant' | 'hourly' | 'daily';

export interface SavedSearch {
  id: number;
  name: string | null;
  query: string | null;
  filters: SavedSearchFilters | null;
  alertEnabled: boolean;
  /** Vale mesmo com o alerta desligado: é a escolha que volta quando ele for religado. */
  alertFrequency: SavedSearchAlertFrequency;
  /** Até quando o alerta já conferiu serviços novos; null = alerta nunca ligado. */
  lastAlertAt: string | null;
  createdAt: string;
}

export interface CreateSavedSearchRequest {
  name?: string | null;
  query?: string | null;
  filters?: SavedSearchFilters | null;
  alertEnabled?: boolean;
  /** Padrão: de hora em hora. */
  alertFrequency?: SavedSearchAlertFrequency;
}

export interface UpdateSavedSearchRequest {
  /** null apaga o nome, e a busca volta a aparecer pelo texto buscado. */
  name?: string | null;
  alertEnabled?: boolean;
  alertFrequency?: SavedSearchAlertFrequency;
}

// --- Denúncias (trust & safety) ---

/** avatar e portfolio_item são imagens (ADR 39): a moderação pode removê-las e bloqueá-las. */
export type ReportTargetType =
  'user' | 'service' | 'review' | 'message' | 'avatar' | 'portfolio_item';
export type ReportReason = 'spam' | 'fraud' | 'offensive' | 'off_platform' | 'illegal' | 'other';

export interface ContentReport {
  id: number;
  targetType: ReportTargetType;
  targetId: number;
  reason: ReportReason;
  status: string;
  /** Imagem denunciada como estava na hora da denúncia (só avatar e portfolio_item). */
  imageUrl: string | null;
  createdAt: string;
}

export type ReportStatus = 'pending' | 'reviewing' | 'actioned' | 'dismissed';
export type AdminReportAction = 'dismiss' | 'resolve' | 'remove-image' | 'remove-content';

/** Denúncias do mesmo alvo (e da mesma imagem) juntas na fila de moderação (ADR 39). */
export interface AdminReportGroup {
  /** Denúncia mais recente do grupo: as ações são chamadas por ela e valem para o grupo todo. */
  id: number;
  targetType: ReportTargetType;
  targetId: number;
  imageUrl: string | null;
  /** O alvo ainda mostra essa imagem (false: já foi trocada, removida ou o alvo sumiu). */
  imageLive: boolean;
  /** Como o alvo aparece para o admin: "Foto de perfil", "Trabalho “Logo”", "Serviço “X”". */
  label: string;
  /** Trecho do conteúdo denunciado (comentário da avaliação, texto da mensagem). */
  excerpt: string | null;
  owner: { id: number; ulid: string; name: string | null } | null;
  status: ReportStatus;
  reports: number;
  reasons: { reason: ReportReason; count: number }[];
  /** Até três descrições, das mais recentes. */
  descriptions: string[];
  firstReportedAt: string;
  lastReportedAt: string;
  reviewedAt: string | null;
  resolutionNote: string | null;
  /** Tem denúncia automática da detecção de negociação por fora, sem denunciante (ADR 45). */
  automatic: boolean;
}

export interface AdminReportActionRequest {
  note?: string | null;
}

export interface AdminReportActionResult {
  status: ReportStatus;
  /** Quantas denúncias do grupo foram fechadas. */
  reports: number;
  /** Perfis e trabalhos que deixaram de mostrar a imagem. */
  referencesCleared: number;
  /** Arquivo removido do disco (imagem enviada ao Escambo). */
  fileRemoved: boolean;
  /** A imagem entrou na lista de bloqueio e não pode ser enviada de novo. */
  blocked: boolean;
  /** Registro contestável da remoção (ADR 41); null quando a imagem não tinha dono. */
  removalId: number | null;
  /** Remoções do dono que contam na janela de reincidência, já com esta. */
  ownerStrikes: number | null;
  /** Até quando o dono fica sem enviar imagens, se a reincidência bloqueou. */
  uploadsBlockedUntil: string | null;
  /** Esta remoção levou o dono ao limite e abriu uma denúncia da conta para revisão. */
  accountReviewOpened: boolean;
}

// --- Contestação e reincidência na moderação de conteúdo (ADR 41 e 44) ---

/** removed: sem contestação · appealed: esperando o admin · upheld: mantida · overturned: revertida. */
export type RemovalStatus = 'removed' | 'appealed' | 'upheld' | 'overturned';

/** O que a moderação removeu: imagem (ADR 41), avaliação ou mensagem (ADR 44). */
export type RemovalTarget = 'avatar' | 'portfolio_item' | 'review' | 'message';

/** Um conteúdo removido, como o dono vê no perfil. */
export interface ContentRemoval {
  id: number;
  targetType: RemovalTarget;
  /** "Foto de perfil", "Imagem do trabalho “Logo”", "Avaliação" ou "Mensagem no chat". */
  label: string;
  /** Texto removido, de avaliação ou mensagem; null para imagem. */
  excerpt: string | null;
  reason: ReportReason;
  /** Nota da moderação na remoção. */
  note: string | null;
  removedAt: string;
  status: RemovalStatus;
  appealDeadline: string;
  /** Ainda sem contestação e dentro do prazo. */
  canAppeal: boolean;
  appealText: string | null;
  appealedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** Reincidência calculada na hora: remoções não revertidas dentro da janela. */
export interface StrikeSummary {
  strikes: number;
  /** Só as imagens removidas: é o que conta para o bloqueio de envio (ADR 44). */
  imageStrikes: number;
  windowDays: number;
  /** Remoções na janela que abrem a revisão da conta. */
  reviewThreshold: number;
  uploadsBlockedUntil: string | null;
}

export interface MyModeration {
  removals: ContentRemoval[];
  strikes: StrikeSummary;
}

export interface AppealRemovalRequest {
  text: string;
}

export type AppealDecision = 'uphold' | 'overturn';

/** Contestação na fila do admin. */
export interface AdminAppeal {
  id: number;
  owner: { id: number; ulid: string; name: string | null };
  targetType: RemovalTarget;
  label: string;
  /** Texto removido, de avaliação ou mensagem; null para imagem. */
  excerpt: string | null;
  reason: ReportReason;
  note: string | null;
  removedAt: string;
  /** Endereço público da imagem (null para avaliação e mensagem); volta ao ar se revertida. */
  imageUrl: string | null;
  /** Vazio quando o titular teve a conta anonimizada (LGPD). */
  appealText: string;
  appealedAt: string;
  status: Exclude<RemovalStatus, 'removed'>;
  decidedAt: string | null;
  decisionNote: string | null;
  /** O arquivo ainda está guardado e pode ser visto em /admin/appeals/:id/image. */
  hasImage: boolean;
  /** Remoções do dono que contam agora na janela de reincidência. */
  ownerStrikes: number;
}

/** Um dia (Brasília) da série da saúde da moderação (ADR 50); dia sem nada vem zerado. */
export interface ModerationHealthDay {
  day: string;
  actioned: number;
  dismissed: number;
  flagged: number;
  medianHours: number | null;
}

/** Saúde da moderação no painel (ADR 47 e 50): fila agora e, num período, decisões, sinalizações, contestações e a série por dia. */
export interface ModerationHealth {
  windowDays: number;
  queue: {
    /** Denúncias pendentes ou em análise, contando cada denúncia. */
    pending: number;
    oldestPendingAt: string | null;
    automaticPending: number;
    /** Contas com denúncia de reincidência aberta (ADR 41). */
    accountReviewsOpen: number;
    appealsPending: number;
    oldestAppealAt: string | null;
  };
  decisions: {
    total: number;
    dismissed: number;
    actioned: number;
    /** Horas entre a denúncia e a decisão, no período. */
    medianHours: number | null;
    p90Hours: number | null;
  };
  automatic: {
    flagged: number;
    pending: number;
    dismissed: number;
    actioned: number;
    /** Removidas sobre decididas (0 a 1); null sem decisão. */
    precision: number | null;
    signals: {
      signal: OffPlatformSignal;
      flagged: number;
      actioned: number;
      dismissed: number;
      precision: number | null;
    }[];
  };
  appeals: {
    decided: number;
    upheld: number;
    overturned: number;
    medianHours: number | null;
    overturnRate: number | null;
  };
  removals: { total: number; byType: { targetType: RemovalTarget; count: number }[] };
  /** Meta de tempo até decidir (platform_settings.moderation_sla_hours), em horas. */
  slaHours: number;
  /** Do dia do começo do período ao de hoje (Brasília), sem buracos. */
  history: ModerationHealthDay[];
}

export interface AdminAppealDecisionRequest {
  note?: string | null;
}

export interface AdminAppealDecisionResult {
  status: 'upheld' | 'overturned';
  /** Perfis e trabalhos que voltaram a mostrar a imagem. */
  restoredReferences: number;
  imageRestored: boolean;
  /** O conteúdo voltou para onde estava: a imagem, a avaliação ou a mensagem (ADR 44). */
  contentRestored: boolean;
  /** Arquivo guardado apagado (remoção mantida). */
  fileDeleted: boolean;
}

export interface CreateContentReportRequest {
  targetType: ReportTargetType;
  targetId: number;
  reason: ReportReason;
  description?: string | null;
}

// --- Disputas ---

export type DisputeReason =
  'not_delivered' | 'quality' | 'deadline' | 'scope' | 'payment' | 'other';
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

export type FinanceGranularity = 'day' | 'month';

/** Somas de um período (ou de um balde do período). Valores em R$. */
export interface FinanceTotals {
  /** Taxas retidas pela plataforma, líquidas de estornos (derivadas do ledger de R$). */
  revenue: number;
  /** Depósitos confirmados (dinheiro que entrou). */
  deposits: number;
  /** Saques efetivados, líquidos de saques estornados (dinheiro que saiu). */
  withdrawals: number;
  /** Reembolsos a clientes (recusa, cancelamento, disputa). */
  refunds: number;
  /** Contratações em dinheiro concluídas no período. */
  completedContracts: number;
  /** Valor bruto das contratações em dinheiro concluídas (GMV). */
  gmv: number;
}

export interface FinanceBucket extends FinanceTotals {
  /** "AAAA-MM" (mês) ou "AAAA-MM-DD" (dia), em horário de Brasília. */
  bucket: string;
}

/** Relatório financeiro do admin (GET /admin/finance). */
export interface AdminFinanceReport {
  from: string;
  to: string;
  granularity: FinanceGranularity;
  totals: FinanceTotals;
  series: FinanceBucket[];
  /** Fotografia de agora (não depende do período). */
  now: { inEscrow: number; usersBalance: number };
}

export interface AdminMetrics {
  users: number;
  freelancers: number;
  contracts: number;
  completedContracts: number;
  openDisputes: number;
  /** Taxas retidas desde o início, líquidas de estornos (derivadas do ledger de R$, ADR 26). */
  platformFees: number;
  /** Soma do que está retido em escrow / reservado em propostas (passivo da plataforma). */
  inEscrow: number;
  /** Saques aguardando processamento (quantidade e valor). */
  pendingWithdrawals: number;
  pendingWithdrawalsAmount: number;
  /** Total já depositado pelos clientes (pagamentos confirmados). */
  depositsTotal: number;
  /** Saldo disponível somado de todas as carteiras (passivo com usuários). */
  usersBalance: number;
  /** Pedidos de exclusão de conta (LGPD) aguardando o admin. */
  pendingDeletions: number;
}

/** Uso do volume da API e saúde dos anexos do chat (painel admin, ADR 31). */
export interface AdminStorage {
  /** platform_settings.attachment_retention_days */
  retentionDays: number;
  /** Hora (Brasília) do expurgo diário. */
  purgeHour: number;
  uploads: { files: number; bytes: number };
  exports: { files: number; bytes: number };
  /**
   * Fotos de perfil e imagens do portfólio (ADR 36 e 38): files = imagens enviadas, variants =
   * miniaturas geradas, bytes = tudo junto; orphans = imagens que ninguém usa.
   */
  media: { files: number; variants: number; bytes: number; orphans: number };
  attachments: {
    active: number;
    activeBytes: number;
    purged: number;
    purged30d: number;
    /** Linhas cujo arquivo não está no disco. */
    missing: number;
    /** Arquivos no disco sem linha no banco. */
    orphans: number;
  };
  lastPurge: {
    at: string;
    purged: number;
    orphansRemoved: number;
    trigger: 'job' | 'admin';
  } | null;
}

/** Chaves de platform_settings editáveis pelo admin (ADR 32). */
export type PlatformSettingKey =
  | 'platform_fee_percentage'
  | 'tacit_approval_days'
  | 'proposal_expiry_hours'
  | 'deadline_grace_hours'
  | 'attachment_retention_days'
  | 'appeal_window_days'
  | 'strike_window_days'
  | 'strike_upload_block_days'
  | 'strike_review_threshold'
  | 'moderation_sla_hours'
  | 'min_service_price'
  | 'min_withdrawal_amount'
  | 'barter_enabled'
  | 'maintenance_mode';

export type PlatformSettingType = 'integer' | 'decimal' | 'boolean';

export interface PlatformSetting {
  key: PlatformSettingKey;
  type: PlatformSettingType;
  label: string;
  description: string;
  unit: string;
  value: number | boolean;
  min: number;
  max: number;
  defaultValue: number | boolean;
  updatedAt: string | null;
  /** E-mail do admin que mudou por último. */
  updatedBy: string | null;
}

export interface UpdatePlatformSettingRequest {
  value: number | boolean;
}

/** Parâmetros que o app mostra sem login: taxa no modal de contratação, prazos nas telas. */
export interface PublicSettings {
  platformFeePercentage: number;
  tacitApprovalDays: number;
  proposalExpiryHours: number;
  minServicePrice: number;
  minWithdrawalAmount: number;
  barterEnabled: boolean;
  /** Ligado: a API responde 503 para quem não é admin; o app mostra a tela de manutenção. */
  maintenanceMode: boolean;
}

/** Para que a imagem vai (ADR 38): avatar sai quadrado; portfólio cabe em 1600 px e pode animar. */
export type MediaPurpose = 'avatar' | 'portfolio';

/** Imagem enviada para avatar ou portfólio (ADR 36 e 38): a URL pública vai no perfil. */
export interface MediaUpload {
  url: string;
  /** Sempre image/webp: a API reencoda tudo. */
  mime: string;
  size: number;
  width: number;
  height: number;
}

/** Resultado de uma rodada do expurgo de anexos (job ou botão do admin). */
export interface PurgeAttachmentsResult {
  retentionDays: number;
  cutoff: string | null;
  purged: number;
  orphansRemoved: number;
  failed: number;
  skipped: 'before_hour' | 'already_today' | null;
}

// --- LGPD ---

export type ConsentType = 'terms_of_use' | 'privacy_policy' | 'marketing' | 'data_processing';

export interface Consent {
  type: ConsentType;
  version: string;
  accepted: boolean;
  at: string;
}

export type DeletionRequestStatus = 'pending' | 'processing' | 'completed' | 'rejected';
export type ExportRequestStatus =
  'pending' | 'processing' | 'ready' | 'downloaded' | 'expired' | 'failed';

export interface DataDeletionRequest {
  id: number;
  reason: string | null;
  status: DeletionRequestStatus;
  /** Justificativa do admin (recusa). */
  adminNote: string | null;
  createdAt: string;
  processedAt: string | null;
}

/** Solicitação de exclusão vista pelo admin: titular e o que ainda o prende à plataforma. */
export interface AdminDeletionRequest extends DataDeletionRequest {
  userId: number;
  userUlid: string;
  userEmail: string;
  userName: string | null;
  activeContracts: number;
  balance: number;
  balancePending: number;
}

export interface DataExportRequest {
  id: number;
  status: ExportRequestStatus;
  /** Rota autenticada do arquivo JSON; null quando ainda não está (ou não está mais) disponível. */
  downloadUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
  processedAt: string | null;
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

export type ScoreTier = 'novato' | 'confiavel' | 'top' | 'elite';

export interface ScoreBreakdown {
  quality: number; // 0-100, a partir da nota média
  experience: number; // 0-100, a partir do volume de contratos
  socialProof: number; // 0-100, a partir do volume de avaliações
  responsiveness: number; // 0-100, a partir do tempo de resposta
}

/** Reputação multifator computada (0-100) com faixa e detalhamento explicável. */
export interface EscamboScore {
  score: number;
  tier: ScoreTier;
  breakdown: ScoreBreakdown;
}

/** Período do dia em que o freelancer atende, no fuso dele (ADR 48): manhã 6–12, tarde 12–18, noite 18–24. */
export type AvailabilityPeriod = 'morning' | 'afternoon' | 'evening';

/** Por dia marcado ('0' = domingo … '6' = sábado), os períodos; dia sem chave = o dia todo. */
export type AvailablePeriods = Record<string, AvailabilityPeriod[]>;

export interface FreelancerProfile {
  fullName: string;
  avatarUrl: string | null;
  bio: string | null;
  headline: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  isAvailable: boolean;
  /** Dias da semana em que atende (0 = domingo … 6 = sábado); null = não informou. */
  availableDays: number[] | null;
  /** Períodos por dia (ADR 34); null = atende o dia todo nos dias marcados. */
  availablePeriods: AvailablePeriods | null;
  /** Aceitando pedidos, atende hoje e está num período marcado agora, no fuso dele. */
  availableNow: boolean;
  /** Fuso da conta em que os dias e períodos valem (ADR 48); Brasília para quem não escolheu. */
  timezone: BrazilTimezone;
  /** Tempo médio de resposta no chat, em horas (média móvel); null = ainda sem amostra. */
  responseTimeHours: number | null;
  avgRating: number;
  totalReviews: number;
  totalContracts: number;
  escamboScore: EscamboScore;
}

/** Item do portfólio do freelancer (imagem e/ou link externo). */
export interface PortfolioItem {
  id: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  externalUrl: string | null;
  sortOrder: number;
}

export interface UpsertPortfolioItemRequest {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  externalUrl?: string | null;
}

/** Nova ordem do portfólio (ADR 43): os ids de todos os trabalhos, do primeiro ao último. */
export interface ReorderPortfolioRequest {
  ids: number[];
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
  userId: number;
  userUlid: string;
  level: number;
  levelName: string;
  portfolio: PortfolioItem[];
}

export interface UpsertFreelancerProfileRequest {
  fullName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  headline?: string | null;
  city?: string | null;
  state?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isAvailable?: boolean;
  availableDays?: number[] | null;
  availablePeriods?: AvailablePeriods | null;
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
  /** Distância em km até o ponto pesquisado (só na busca por proximidade). */
  distanceKm?: number | null;
  /** Serviço com impulsionamento ativo (ranqueia no topo). */
  boosted?: boolean;
  /** Quem presta o serviço (nome e reputação) — presente na listagem. */
  ownerUlid?: string;
  ownerName?: string | null;
  ownerAvatarUrl?: string | null;
  ownerRating?: number;
  ownerReviews?: number;
  /** Dias em que o prestador atende (0=domingo … 6=sábado); null = não informou. */
  ownerAvailableDays?: number[] | null;
  ownerAvailablePeriods?: AvailablePeriods | null;
  /** O prestador atende agora (aceitando pedidos, dia e período de agora no fuso dele). */
  ownerAvailableNow?: boolean;
  /** Fuso em que a agenda do prestador vale (ADR 48). */
  ownerTimezone?: BrazilTimezone;
}

// --- Impulsionamento (Boosts) ---

export interface BoostPlan {
  id: number;
  name: string;
  description: string | null;
  durationDays: number;
  price: number; // valor de referência (R$)
  costCredits: number; // custo em créditos Escambo
  features: Record<string, unknown> | null;
}

export type BoostStatus = 'active' | 'expired' | 'cancelled';

export interface Boost {
  id: number;
  serviceId: number | null;
  planId: number;
  planName: string;
  status: BoostStatus;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface CreateBoostRequest {
  serviceId: number;
  planId: number;
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

export type PaymentMode = 'cash' | 'barter' | 'credits';

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
  paymentMode: PaymentMode;
  status: ContractStatus;
  deadlineAt: string | null;
  createdAt: string;
  /** O cliente já avaliou esta contratação (uma avaliação por contrato). */
  hasReview: boolean;
  /** Escrow por marcos (RN-069): entrega e liberação acontecem marco a marco. */
  hasMilestones: boolean;
  /** Quando o prazo foi estendido (RN-028: só uma vez por contratação). */
  deadlineExtendedAt: string | null;
  /** Quando as partes foram avisadas de que o prazo estourou (RN-029). */
  overdueNotifiedAt: string | null;
  /** Último pedido de extensão de prazo, se houve. */
  extension: ContractExtension | null;
}

export type ExtensionStatus = 'pending' | 'accepted' | 'declined';

/** Pedido de extensão de prazo feito pelo freelancer (RN-028). */
export interface ContractExtension {
  status: ExtensionStatus;
  /** Novo prazo proposto (vira o prazo da contratação se o cliente aceitar). */
  deadlineAt: string;
  reason: string;
  requestedAt: string;
  resolvedAt: string | null;
}

export type MilestoneStatus =
  'pending' | 'funded' | 'delivered' | 'approved' | 'released' | 'cancelled';

export interface Milestone {
  id: number;
  title: string;
  description: string | null;
  amount: number;
  /** O que o freelancer recebe ao liberar este marco (valor − taxa). */
  freelancerNet: number;
  sortOrder: number;
  status: MilestoneStatus;
  dueAt: string | null;
  deliveredAt: string | null;
  deliveryNote: string | null;
  revisionNote: string | null;
  releasedAt: string | null;
}

export interface MilestoneInput {
  title: string;
  description?: string | null;
  amount: number;
  dueAt?: string | null;
}

export interface ContractStatusHistoryEntry {
  previousStatus: ContractStatus | null;
  status: ContractStatus;
  note: string | null;
  at: string;
}

export interface ContractWithHistory extends Contract {
  history: ContractStatusHistoryEntry[];
  /** Marcos (vazio quando o contrato é de entrega única). */
  milestones: Milestone[];
  /** Avaliação do cliente (com a resposta do freelancer, se houver). */
  review: Review | null;
}

export interface CreateContractRequest {
  freelancerId: number;
  serviceId?: number | null;
  title: string;
  description: string;
  price: number;
  deadlineAt?: string | null;
  /** 'cash' (padrão) ou 'credits' (paga com créditos Escambo). */
  paymentMode?: 'cash' | 'credits';
  /** Escrow por marcos (só em dinheiro): 2 a 10 marcos cuja soma é o valor da contratação. */
  milestones?: MilestoneInput[];
}

export interface ExtensionRequest {
  deadlineAt: string;
  reason: string;
}

export interface CancelResult {
  status: ContractStatus;
  refundPercentage: number;
}

// --- Chat em tempo real (mensagens do contrato) ---

export type ChatMessageType = 'text' | 'image' | 'file';

/** Anexo de uma mensagem: a `url` é relativa à API e exige o token (só as partes leem). */
/** Por que o arquivo de um anexo saiu do disco (ADR 31): retenção, pedido do titular ou sumiu. */
export type AttachmentPurgeReason = 'retention' | 'lgpd' | 'missing';

export interface ChatAttachment {
  name: string;
  mime: string;
  size: number;
  url: string;
  /** Quando o arquivo foi removido do disco; null = disponível. */
  purgedAt: string | null;
  purgedReason: AttachmentPurgeReason | null;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  senderId: number;
  type: ChatMessageType;
  /** Texto (ou legenda do anexo); vazio quando a mensagem é só o arquivo. */
  content: string;
  attachment: ChatAttachment | null;
  createdAt: string;
  /** Removida pela moderação (ADR 44): as partes veem o aviso, sem o texto nem o anexo. */
  removedAt: string | null;
  /** Sinais de negociação por fora achados no texto (ADR 45); vazio quando limpa ou removida. */
  signals: OffPlatformSignal[];
}

/** O que a detecção de negociação por fora achou numa mensagem (ADR 45). */
export type OffPlatformSignal = 'pix' | 'phone' | 'email' | 'whatsapp' | 'off_platform';

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
  credits: number; // saldo de créditos Escambo (time-bank)
  creditsPending: number; // créditos retidos em escrow
}

/** Motivo de cada linha do extrato de R$ (espelho do ledger de créditos). */
export type WalletReason =
  | 'deposit' // depósito confirmado pelo gateway
  | 'hold' // valor reservado ao enviar a proposta (cliente)
  | 'payment' // proposta aceita: o valor reservado paga a contratação (cliente)
  | 'escrow_in' // líquido entra em escrow (freelancer)
  | 'escrow_release' // escrow liberado, total ou parcial (freelancer)
  | 'escrow_refund' // escrow devolvido ao cliente, nada liberado (freelancer)
  | 'refund' // reembolso ao cliente (recusa, cancelamento, disputa)
  | 'withdrawal' // saque solicitado
  | 'withdrawal_refund' // saque cancelado/falhou: valor de volta
  | 'barter_hold' // torna da troca reservada (pagador)
  | 'barter_payment' // troca concluída: torna paga (pagador)
  | 'barter_in'; // troca concluída: torna recebida, menos a taxa (outro lado)

export interface WalletTransaction {
  id: number;
  amount: number; // variação do saldo disponível (+ entra, - sai)
  pendingDelta: number; // variação do saldo retido
  balanceAfter: number;
  pendingAfter: number;
  reason: WalletReason;
  contractId: number | null;
  paymentId: number | null;
  withdrawalId: number | null;
  createdAt: string;
}

export type DepositStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'refunded' | 'cancelled';

/** Depósito na carteira (cobrança PIX gerada pelo gateway de pagamento). */
export interface Deposit {
  id: number;
  amount: number;
  status: DepositStatus;
  method: 'pix';
  gateway: string;
  /** Identificador da cobrança no gateway (referência para suporte/webhook). */
  reference: string | null;
  pixCode: string | null; // "copia e cola" (BR Code)
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  /** Ambiente de demonstração: o pagamento pode ser simulado pela própria API. */
  canSimulate: boolean;
}

export interface CreateDepositRequest {
  amount: number;
  method?: 'pix';
}

export type CreditReason =
  | 'welcome'
  | 'escrow_hold'
  | 'escrow_in'
  | 'escrow_release'
  | 'escrow_refund'
  | 'refund'
  | 'grant'
  | 'boost';

export interface CreditTransaction {
  id: number;
  amount: number; // assinado: + entra, - sai
  balanceAfter: number;
  reason: CreditReason;
  contractId: number | null;
  createdAt: string;
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
  /** Removida pela moderação (ADR 44): só a contratação mostra, sem comentário nem resposta. */
  removedAt: string | null;
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
  'proposed' | 'accepted' | 'rejected' | 'active' | 'completed' | 'cancelled' | 'disputed';

/** Máquina de estados do dinheiro da troca (torna), separada do status do acordo. */
export type TornaStatus = 'none' | 'pending' | 'held' | 'paid' | 'refunded';

export interface BarterAgreement {
  id: number;
  ulid: string;
  proposerId: number;
  receiverId: number;
  offeredServiceId: number | null;
  requestedServiceId: number | null;
  offeredServiceTitle: string | null;
  requestedServiceTitle: string | null;
  offeredDescription: string | null;
  requestedDescription: string | null;
  estimatedValueOffered: number;
  estimatedValueRequested: number;
  cashDifference: number; // torna
  cashPayerId: number | null;
  platformFee: number; // 15% sobre a torna (troca equilibrada não tem taxa)
  tornaNet: number; // o que o outro lado recebe: torna − taxa
  tornaStatus: TornaStatus;
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

/** Saque na fila do admin (destino completo: é o admin quem paga). */
export interface AdminWithdrawal extends Withdrawal {
  userId: number;
  userUlid: string;
  userEmail: string;
  userName: string | null;
  destination: string;
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
