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
  /** Estado atual da conta; suspensão conserva consulta e restringe ações de negócio. */
  status: UserStatus;
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
  /**
   * O que sai mesmo durante o silêncio (ADR 56); null = nunca escolheu (vale como nada);
   * [] = escolheu que nada sai.
   */
  quietPass: QuietPassCategory[] | null;
}

/**
 * O que pode sair durante o silêncio (ADR 56): lista fechada da plataforma; a pessoa escolhe.
 * deadline = prazo vencido num trabalho que a pessoa entrega, com a mediação automática contando.
 */
export type QuietPassCategory = 'deadline';

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
  /**
   * A conta entrega trabalho (papel freelancer, algum serviço ou contratação como freelancer): só
   * ela vê a escolha do que sai no silêncio (ADR 56).
   */
  deliversWork: boolean;
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
  /** O que sai mesmo durante o silêncio (ADR 56); null = nunca escolheu (vale como nada). */
  quietPass: QuietPassCategory[] | null;
}

/** Muda só o que vier; `null` na hora ou no fuso volta ao padrão da plataforma. */
export interface UpdateEmailPreferenceRequest {
  emailFrequency?: EmailFrequency;
  digestHour?: number | null;
  timezone?: BrazilTimezone | null;
  /** Objeto inteiro ou null (desliga); nunca meia janela (ADR 54). */
  quietHours?: QuietHours | null;
  /** O conjunto inteiro do que sai durante o silêncio (ADR 56); [] = nada sai. */
  quietPass?: QuietPassCategory[];
}

export interface ForgotPasswordRequest {
  email: string;
}
export interface ResetPasswordRequest {
  token: string;
  password: string;
}
/** Troca de senha com login (RF-017); a resposta é o par novo desta sessão (RefreshResponse). */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
export interface VerifyEmailRequest {
  token: string;
}

/** Troca de e-mail aguardando o link enviado ao endereço novo (RF-017). */
export interface PendingEmailChange {
  email: string;
  expiresAt: string;
}
/** Contato da conta (RF-017): só o titular vê; o perfil público não traz e-mail nem telefone. */
export interface AccountContact {
  email: string;
  emailVerified: boolean;
  /** E.164 (+55 com DDD); null = não informado. */
  phone: string | null;
  pendingEmail: PendingEmailChange | null;
}
/** Pedido de troca de e-mail: a senha atual confirma o titular. */
export interface ChangeEmailRequest {
  currentPassword: string;
  newEmail: string;
}
export interface ConfirmEmailChangeRequest {
  token: string;
}
/** Troca confirmada; `session` só vem quando quem abriu o link estava logado na mesma conta. */
export interface ConfirmEmailChangeResponse {
  email: string;
  session: RefreshResponse | null;
}
/** Telefone do Brasil com DDD, em qualquer formato comum; null ou vazio apaga. */
export interface UpdatePhoneRequest {
  phone: string | null;
}

/** E-mail registrado na caixa de saída (painel admin; no provedor simulado é a própria entrega). */
export interface AdminEmail {
  id: number;
  userId: number | null;
  to: string;
  subject: string;
  template:
    | 'verify_email'
    | 'password_reset'
    | 'email_change'
    | 'notification'
    | 'digest'
    | 'moderation_report';
  text: string;
  status: 'queued' | 'sent' | 'failed';
  provider: string;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

/**
 * Dados da empresa no cadastro (RF-018): obrigatórios quando `role` é 'company'. O CNPJ vai com ou
 * sem máscara, numérico ou alfanumérico (IN RFB 2.229/2024).
 */
export interface RegisterCompanyData {
  /** Razão social. */
  legalName: string;
  /** Nome fantasia: o nome que aparece para os freelancers. */
  tradeName: string;
  cnpj: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  role?: Exclude<UserRole, 'admin'>;
  /** Só com role 'company', e aí obrigatório. */
  company?: RegisterCompanyData;
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

// --- Verificação em duas etapas (RF-090, RNF-042, ADR 66) ---

/**
 * Resposta do login com a senha certa numa conta com 2FA: ainda sem sessão. O `mfaToken` vale
 * alguns minutos e só serve para POST /auth/login/mfa, com o código do app ou um de recuperação.
 */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresInSeconds: number;
}

/** POST /auth/login: a sessão, ou o pedido do segundo fator. */
export type LoginResponse = AuthResponse | MfaChallenge;

export interface MfaLoginRequest {
  mfaToken: string;
  /** 6 dígitos do app autenticador, ou um código de recuperação (XXXX-XXXX). */
  code: string;
}

/** GET /auth/mfa: a situação da 2FA da própria conta. */
export interface MfaStatus {
  enabled: boolean;
  /** Quando foi ativada (ISO), ou null. */
  confirmedAt: string | null;
  /** Códigos de recuperação ainda não usados. */
  recoveryCodesLeft: number;
  /** O servidor tem a chave que cifra o segredo (FIELD_ENCRYPTION_KEY): sem ela, não dá para ativar. */
  available: boolean;
  /** Conta admin num servidor com ADMIN_MFA_REQUIRED: o painel só abre com a 2FA ativa. */
  required: boolean;
}

/** POST /auth/mfa/setup: o segredo novo, ainda não ativo, para o app autenticador. */
export interface MfaSetup {
  /** Base32, para digitar no app (quem não consegue ler o QR). */
  secret: string;
  /** otpauth://totp/... (o conteúdo do QR). */
  otpauthUrl: string;
}

/** POST /auth/mfa/enable: a sessão nova desta conta (as outras caem) e os códigos, mostrados uma vez. */
export interface MfaEnabledResponse extends RefreshResponse {
  recoveryCodes: string[];
}

/** POST /auth/mfa/recovery-codes: códigos novos (os anteriores deixam de valer). */
export interface MfaRecoveryCodesResponse {
  recoveryCodes: string[];
}

/** Conta encontrada pelo admin, para o atendimento (GET /admin/users/lookup?email=). */
export interface AdminAccountLookup {
  ulid: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  mfaEnabled: boolean;
  createdAt: string;
  /** CPF do perfil de freelancer (RF-020), só mascarado; null sem perfil de freelancer. */
  cpf: AdminCpfSummary | null;
  /** Conta de empresa (RF-018): o nome fantasia e o CNPJ (dado público); null nas outras. */
  company: { tradeName: string; cnpj: string } | null;
}

/** O CPF como o atendimento vê: validado ou não, e só mascarado (RN-075). */
export interface AdminCpfSummary {
  verified: boolean;
  /** ***.456.789-**; null sem CPF; "[indisponível]" se o cifrado não abriu. */
  maskedCpf: string | null;
  verifiedAt: string | null;
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
  /** true = atende remoto, false = atende presencial; quem atende dos dois jeitos entra nos dois. */
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
  /** Denúncias criadas no dia, humanas e automáticas (ADR 55). */
  received: number;
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
    /** Denúncias de conteúdo esperando há mais que a meta agora (revisões de conta não contam; ADR 55). */
    overSlaPending: number;
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
  /** O relatório diário por e-mail aos admins (ADR 55): chave, hora, provedor e a última conferência. */
  dailyReport: {
    enabled: boolean;
    hour: number;
    mailProvider: 'simulated' | 'smtp' | 'off';
    last: ModerationSlaReportState | null;
  };
}

/** A marca do relatório diário da meta (ADR 55): o que a última conferência do dia decidiu e entregou. */
export interface ModerationSlaReportState {
  /** Dia de Brasília da conferência. */
  day: string;
  /** ISO da última tentativa. */
  at: string;
  breached: boolean;
  slaHours: number;
  /** Admins encontrados no banco. */
  recipients: number;
  /** E-mails que o provedor aceitou. */
  delivered: number;
  /** Rodadas de envio no dia. */
  attempts: number;
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

/** Dia, semana (de segunda a domingo) ou mês, sempre em horário de Brasília. */
export type FinanceGranularity = 'day' | 'week' | 'month';

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
  /** "AAAA-MM" (mês) ou "AAAA-MM-DD" (dia; na semana, a segunda-feira), em horário de Brasília. */
  bucket: string;
}

/** Uso da plataforma num período (RF-081). Contagens de pessoas e de contratações. */
export interface UsageTotals {
  /** Contas criadas no período (sem as de administrador). */
  newUsers: number;
  /** Contratações criadas (propostas enviadas), em qualquer modalidade. */
  newContracts: number;
  /** Contratações concluídas, em qualquer modalidade. */
  completedContracts: number;
  /** Contratações canceladas. */
  cancelledContracts: number;
  /**
   * Pessoas distintas que entraram na conta ou renovaram a sessão, mandaram mensagem no chat ou
   * mudaram o status de uma contratação (sem administradores e sem as mudanças automáticas). Nos
   * totais, conta cada pessoa uma vez no período inteiro: não é a soma dos baldes.
   */
  activeUsers: number;
}

export interface UsageBucket extends UsageTotals {
  /** O mesmo formato do relatório financeiro ("AAAA-MM-DD" no dia e na semana, "AAAA-MM" no mês). */
  bucket: string;
  /** Snapshot gravado pelo job diário (período fechado) ou calculado agora. */
  source: 'snapshot' | 'live';
}

/** Relatório de uso do admin (GET /admin/usage): todos os baldes do período, mesmo os zerados. */
export interface AdminUsageReport {
  from: string;
  to: string;
  granularity: FinanceGranularity;
  totals: UsageTotals;
  series: UsageBucket[];
  /** O que conta como "usuário ativo", em texto para a tela. */
  activeDefinition: string;
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
  /** Dos pendentes, quantos já passaram do prazo gravado no pedido (RN-035). */
  overdueWithdrawals: number;
  /** Total já depositado pelos clientes (pagamentos confirmados). */
  depositsTotal: number;
  /** Saldo disponível somado de todas as carteiras (passivo com usuários). */
  usersBalance: number;
  /** Pedidos de exclusão de conta (LGPD) aguardando o admin. */
  pendingDeletions: number;
  /**
   * Chamados de suporte de contas ativas (os de conta anonimizada ficam congelados e não entram):
   * em aberto (aberto, em atendimento ou aguardando o titular), aguardando resposta da equipe
   * (aberto ou em atendimento) e, dos em aberto, os sem primeira resposta pública com o SLA vencido.
   */
  supportOpen: number;
  supportAwaitingReply: number;
  supportSlaOverdue: number;
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
  | 'counter_offer_response_hours'
  | 'extension_response_hours'
  | 'deadline_grace_hours'
  | 'attachment_retention_days'
  | 'appeal_window_days'
  | 'strike_window_days'
  | 'strike_upload_block_days'
  | 'strike_review_threshold'
  | 'moderation_sla_hours'
  | 'moderation_sla_report_enabled'
  | 'min_service_price'
  | 'min_withdrawal_amount'
  | 'withdrawal_pix_business_days'
  | 'withdrawal_bank_business_days'
  | 'barter_enabled'
  | 'maintenance_mode'
  | 'maintenance_return_minutes';

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

/** Política das contratações, derivada das constantes da API e exibida somente para consulta. */
export interface FixedContractRules {
  includedRevisions: number;
  maxOffers: number;
  disputeWaitHours: number;
  disputeTacitMarginHours: number;
  dropoutWindowDays: number;
  dropoutAlertAt: number;
  dropoutAgreementDays: number;
}

/** Parâmetros que o app mostra sem login: taxa no modal de contratação, prazos nas telas. */
export interface PublicSettings {
  platformFeePercentage: number;
  tacitApprovalDays: number;
  proposalExpiryHours: number;
  /** Horas para responder às ofertas 2 a 5, gravadas na oferta (RN-030, ADR 61). */
  counterOfferResponseHours: number;
  minServicePrice: number;
  minWithdrawalAmount: number;
  /**
   * Prazo do saque em dias úteis por forma de recebimento (RN-035): seg a sex no calendário de
   * Brasília, sem feriados. O prazo de cada saque fica gravado nele (`Withdrawal.dueAt`).
   */
  withdrawalBusinessDays: Record<WithdrawalMethod, number>;
  barterEnabled: boolean;
  /** Carência da RN-029: do aviso de atraso até a disputa automática (ADR 57). */
  deadlineGraceHours: number;
  /** Horas para responder a um pedido novo de extensão, gravadas no pedido (RN-028, ADR 61). */
  extensionResponseHours: number;
  /** Regras dos Termos, calculadas das constantes da API; não são parâmetros editáveis. */
  fixedContractRules: FixedContractRules;
  /** Ligado: a API responde 503 para quem não é admin; o app mostra a tela de manutenção. */
  maintenanceMode: boolean;
  /** Hora prevista da volta da manutenção (RNF-010); nula sem previsão ou fora de manutenção. */
  maintenanceReturnAt: string | null;
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
  /** Só nas contas de empresa (RF-018). */
  company: CompanyProfile | null;
}

/**
 * Conta de empresa (RF-018): contrata como o cliente. Razão social, nome fantasia e CNPJ vêm do
 * cadastro; logo, site e descrição curta, do Perfil.
 */
export interface CompanyProfile {
  /** Razão social. */
  legalName: string;
  /** Nome fantasia: o nome exibido. */
  tradeName: string;
  /** 14 caracteres, maiúsculas, sem máscara (dado público; a tela põe a máscara). */
  cnpj: string;
  logoUrl: string | null;
  /** Descrição curta. */
  bio: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
}

/** GET /profiles/company/:ulid — a página pública da empresa. */
export interface PublicCompanyProfile extends CompanyProfile {
  userUlid: string;
  /** Desde quando está no Escambo (a criação da conta). */
  memberSince: string;
}

/** PUT /profiles/company — a razão social, o nome fantasia e o CNPJ continuam obrigatórios. */
export interface UpsertCompanyProfileRequest {
  legalName: string;
  tradeName: string;
  cnpj: string;
  logoUrl?: string | null;
  bio?: string | null;
  website?: string | null;
  city?: string | null;
  state?: string | null;
}

/** Quem contrata é empresa (RF-018): o nome fantasia e o endereço do perfil público. */
export interface CompanyRef {
  ulid: string;
  tradeName: string;
}

/**
 * GET /profiles/me/cpf — o CPF do freelancer (RF-020, RN-009, RN-075). A validação confere os
 * dígitos verificadores, a unicidade entre contas e a maioridade: não é consulta à Receita.
 */
export interface CpfStatus {
  /** O servidor guarda o CPF cifrado (sem a FIELD_ENCRYPTION_KEY, não: o recurso fica indisponível). */
  available: boolean;
  /** A conta entrega trabalho (ADR 56): o saque pede o CPF validado. */
  required: boolean;
  /** O CPF mora no perfil de freelancer: sem ele, primeiro o perfil. */
  hasFreelancerProfile: boolean;
  verified: boolean;
  /** ***.456.789-**; null antes de validar. */
  maskedCpf: string | null;
  /** AAAA-MM-DD; null antes de validar. */
  birthDate: string | null;
  verifiedAt: string | null;
}

/** PUT /profiles/me/cpf — CPF com ou sem máscara e a data de nascimento (AAAA-MM-DD). */
export interface VerifyCpfRequest {
  cpf: string;
  birthDate: string;
}

export interface PublicFreelancerProfile extends FreelancerProfile {
  userId: number;
  userUlid: string;
  level: number;
  levelName: string;
  /** XP acumulado (RF-068). */
  totalXp: number;
  /** Badges conquistadas, da mais recente para a mais antiga (RF-015). */
  badges: Badge[];
  /** Até 3 em destaque (RN-058): sem escolha do freelancer, as mais recentes. */
  featuredBadges: Badge[];
  portfolio: PortfolioItem[];
  /** RN-026: resumo público sem títulos, datas ou contestações. */
  dropouts?: DropoutSummary;
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

/** Modalidade (RF-023): remoto, presencial ou os dois ("both" é remoto e presencial). */
export type ServiceModality = 'remote' | 'onsite' | 'both';

/** Nível do pacote (RF-086, RN-068): Básico, Padrão e Premium. */
export type PackageTier = 'basic' | 'standard' | 'premium';

/**
 * Um pacote do serviço (RF-086, RN-068): o que entra em cada nível, com preço, prazo e revisões
 * próprios. Na contratação, é a cópia do pacote como estava publicado.
 */
export interface ServicePackage {
  tier: PackageTier;
  name: string;
  description: string | null;
  price: number;
  /** Prazo de entrega em dias, contado a partir do dia da proposta. */
  deliveryDays: number;
  /** Revisões sem custo por entrega (ou por marco), de 1 a 10 (RN-023). */
  revisions: number;
  /** Itens inclusos, na ordem em que o freelancer escreveu (até 10). */
  features: string[];
}

export interface Service {
  id: number;
  categoryId: number;
  ownerId: number;
  title: string;
  description: string;
  priceType: ServicePriceType;
  price: number | null;
  deliveryDays: number | null;
  /** Atende remoto: true em "remote" e em "both" (compatível com quem só conhece remoto/presencial). */
  isRemote: boolean;
  /** Modalidade (RF-023); a API sempre manda. */
  modality?: ServiceModality;
  /** Tags (RF-024, RN-018): até 10, normalizadas em minúsculas, em ordem alfabética. */
  tags?: string[];
  /**
   * Pacotes (RF-086), do Básico ao Premium; [] = serviço sem pacotes. Com pacotes, price e
   * deliveryDays são os do Básico ("a partir de"). Ausente nas versões anteriores da API.
   */
  packages?: ServicePackage[];
  /** Visualizações do detalhe (RF-029): só em "Meus serviços", para o dono. */
  viewsCount?: number;
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
  /** Cidade do perfil público de quem presta (null = não informou). */
  ownerCity?: string | null;
  /** Capa do card: a primeira imagem do portfólio de quem presta (null = sem imagem). */
  ownerCoverUrl?: string | null;
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
  /** Vale mais que isRemote quando os dois vêm. */
  modality?: ServiceModality;
  /** RN-018: até 10, de 2 a 30 caracteres, sem repetir; na edição, a lista substitui a anterior. */
  tags?: string[];
  /**
   * RF-086/RN-068: até 3 pacotes, Básico obrigatório e sem pular nível, só no preço fixo. Com
   * pacotes, price e deliveryDays não vêm: saem do Básico. Na edição, a lista substitui a anterior
   * ([] tira os pacotes, e aí price volta a ser obrigatório).
   */
  packages?: ServicePackage[];
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
  /** O prazo agora: de quem é a vez, quando sai o aviso e quando abre a disputa (ADR 57). */
  deadline: ContractDeadline;
  /** Entrega única registrada: a partir de quando ela é aprovada automaticamente (RN-024). */
  approvalDueAt: string | null;
  /** Proposta: até quando o freelancer responde (RN-021). */
  proposalExpiresAt: string | null;
  /** Negociação em aberto (RN-030); ausente nas versões anteriores da API. */
  negotiation?: Negotiation | null;
  /** Entrega única: uso e limite; null por marcos, ausente na API anterior (RN-023). */
  revisions?: RevisionState | null;
  /** Abertura da disputa manual; null fora dos estados disputáveis (RN-062). */
  disputeOpensAt?: string | null;
  /**
   * Fuso em que o prazo é um dia: vale até 23:59 nele (ADR 58). É o fuso em que o prazo gravado marca
   * 23:59:59, preferindo o de quem entrega; só diz o dia, e as horas de agir vêm no fuso de quem lê.
   */
  deadlineZone: BrazilTimezone;
  /** Revisão em aberto (entrega única): quando o cliente pediu; null fora de revisão (ADR 58). */
  revisionRequestedAt: string | null;
  /**
   * O pacote contratado (RF-086), como estava publicado na proposta; null sem pacote. Ausente nas
   * versões anteriores da API.
   */
  package?: ServicePackage | null;
  /**
   * Quem contrata é empresa (RF-018): nome fantasia e perfil público; null quando é pessoa. Ausente
   * nas versões anteriores da API.
   */
  clientCompany?: CompanyRef | null;
}

/**
 * 'expired': o cliente não respondeu até `respondBy` (vale como recusa). 'closed': a contratação
 * saiu da vez de quem entrega (entrega, cancelamento, disputa) com o pedido ainda aberto.
 */
export type ExtensionStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'closed';

/** Pedido de extensão de prazo feito pelo freelancer (RN-028). */
export interface ContractExtension {
  status: ExtensionStatus;
  /** Novo prazo proposto (vira o prazo da contratação se o cliente aceitar). */
  deadlineAt: string;
  reason: string;
  requestedAt: string;
  resolvedAt: string | null;
  /** Até quando o cliente responde; depois disso o pedido expira. */
  respondBy: string | null;
  /** Número do pedido (1 ou 2): vai na decisão, para o cliente decidir o pedido que viu. */
  seq: number;
  /** Fuso em que a data pedida vale até 23:59 (ADR 58): o dia que as duas partes leem. */
  deadlineZone: BrazilTimezone;
}

/**
 * Estado do prazo (ADR 57): 'running' correndo; 'due' vencido, aviso ainda não saiu; 'grace' aviso
 * dado, carência correndo; 'paused' pedido de extensão esperando o cliente; 'met' não há mais o
 * que cobrar (houve entrega); 'proposal' ainda não aceita; 'closed' encerrada; 'none' sem prazo.
 */
export type DeadlineState =
  'none' | 'proposal' | 'running' | 'due' | 'grace' | 'paused' | 'met' | 'closed';

export interface ContractDeadline {
  state: DeadlineState;
  /** Quando o aviso de atraso sai (running/due: previsto) ou saiu (grace/paused). */
  noticeAt: string | null;
  /** A partir de quando a disputa automática abre (running/due: previsto; grace: gravado). */
  mediationAt: string | null;
  /** Pedidos de extensão que ainda cabem (até 2, só um aceito; nenhum depois da entrega). */
  extensionRequestsLeft: number;
  undeliveredMilestones: number;
  totalMilestones: number;
  /** A primeira entrega (ou o primeiro marco entregue): dali em diante o prazo não abre disputa. */
  firstDeliveredAt: string | null;
}

/** Participante responsável por cada oferta na negociação da ADR 61. */
export type NegotiationTurn = 'client' | 'freelancer';

export type OfferOutcome =
  'open' | 'countered' | 'accepted' | 'declined' | 'withdrawn' | 'expired' | 'closed';

/** Marco como será exposto numa oferta; o título sempre vem preenchido pelo mapper. */
export interface OfferMilestone {
  id: number;
  title: string;
  amount: number;
  freelancerNet: number;
  dueAt: string | null;
}

/** Uma oferta da negociação (RN-030); a primeira registra a proposta do cliente. */
export interface ContractOffer {
  seq: number;
  madeBy: NegotiationTurn;
  price: number;
  platformFee: number;
  freelancerNet: number;
  deadlineAt: string | null;
  deadlineZone: BrazilTimezone;
  milestones: OfferMilestone[] | null;
  /** Null só na proposta inicial. */
  message: string | null;
  respondBy: string | null;
  outcome: OfferOutcome;
  createdAt: string;
  resolvedAt: string | null;
}

/** Negociação em pending, fora da troca; a oferta completa será lida somente no detalhe. */
export interface Negotiation {
  /** Fuso atual do freelancer para o editor de novas contrapropostas. */
  deadlineZone?: BrazilTimezone;
  seq: number;
  /** Percentual da proposta validado pelo backend; usado na prévia do líquido. */
  feePercentage?: number;
  round: 1 | 2 | 3;
  turn: NegotiationTurn;
  respondBy: string | null;
  canCounter: boolean;
  countersLeft: number;
  current: ContractOffer | null;
}

/** A contraproposta só altera os termos dos mesmos marcos, preservando ids e títulos. */
export interface CounterOfferRequest {
  seq: number;
  price: number;
  deadlineAt: string | null;
  milestones?: Pick<OfferMilestone, 'id' | 'amount' | 'dueAt'>[];
  message: string;
}

/** Entrega única e cada marco usam a mesma forma; null conserva o limite aberto do legado. */
export interface RevisionState {
  used: number;
  limit: number | null;
}
/** Nome anterior preservado para consumidores da proposta inicial da ADR 61. */
export type ContractRevisions = RevisionState;

/** Fatos da desistência destinados às partes da contratação, sem texto da contestação. */
export interface ContractDropout {
  at: string;
  agreedAt: string | null;
  agreeUntil: string;
  counts: boolean;
}

/** Resumo público da RN-026: não identifica contratações, participantes ou datas. */
export interface DropoutSummary {
  count: number;
  windowDays: 60;
  alert: boolean;
}

/** Retrato informativo do cancelamento; outra contratação pode mudar a contagem antes do COMMIT. */
export interface DropoutPreview {
  countAfter: number;
  windowDays: 60;
  alertAt: 3;
  alertUntil: string | null;
}

export type DropoutDecision = 'excused' | 'upheld';
export type DropoutStatus = 'counting' | 'agreed' | 'excused' | 'expired';

/** Visão do titular sobre uma desistência; contestar não suspende a contagem. */
export interface MyDropout {
  id: number;
  contractId: number;
  contractTitle: string;
  droppedAt: string;
  countsUntil: string | null;
  status: DropoutStatus;
  appealText: string | null;
  appealedAt: string | null;
  canAppeal: boolean;
  decision: DropoutDecision | null;
  decisionNote: string | null;
}

export interface MyDropouts {
  items: MyDropout[];
  count: number;
  alert: boolean;
  alertUntil: string | null;
  /** Contexto privado do titular; não faz parte do resumo público. */
  acceptedInWindow: number;
}

export interface AdminDropout extends MyDropout {
  freelancer: { id: number; ulid: string; name: string | null };
  clientAgreed: boolean;
  ownerCount: number;
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
  /** Marco entregue: a partir de quando ele é aprovado automaticamente (RN-024). */
  approvalDueAt: string | null;
  /** Fuso em que a data do marco é um dia (ADR 58), como `Contract.deadlineZone`. */
  dueZone: BrazilTimezone;
  /** Marco em revisão ('funded' já entregue antes): quando o cliente pediu (ADR 58). */
  revisionRequestedAt: string | null;
  /** Ausente na API anterior; limit null conserva as revisões ilimitadas do legado. */
  revisions?: RevisionState;
  /**
   * Arquivos anexados às entregas deste marco (RF-035), na ordem em que foram enviados; cada
   * reentrega soma os seus. Ausente nas versões anteriores da API.
   */
  attachments?: DeliveryAttachment[];
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

/** Uma entrega única registrada (RF-035): a primeira e cada reentrega depois de uma revisão. */
export interface ContractDelivery {
  id: number;
  /** O que o freelancer escreveu ao entregar. */
  message: string;
  /** Links informados na entrega; vazio quando a entrega foi só a mensagem. */
  files: string[];
  /** Arquivos enviados com a entrega (RF-035). Ausente nas versões anteriores da API. */
  attachments?: DeliveryAttachment[];
  deliveredAt: string;
}

/**
 * Arquivo de uma entrega (RF-035). É um anexo do chat do par (ADR 29): mesmo download, só para as
 * partes (`url`), mesma retenção (ADR 31) e mesma moderação (ADR 44).
 */
export interface DeliveryAttachment extends ChatAttachment {
  /** A mensagem do chat que guarda o arquivo (é o alvo de uma denúncia). */
  messageId: number;
  /** Removido pela moderação (ADR 44): o arquivo deixa de ser servido. */
  removedAt: string | null;
  /** Quando foi enviado, junto com a entrega. */
  sentAt: string;
}

/** Lista paginada das contratações de quem pede (RF-040): `total` já conta o filtro de status. */
export interface ContractList extends Paginated<Contract> {
  total: number;
}

export interface ContractWithHistory extends Contract {
  history: ContractStatusHistoryEntry[];
  /** Entregas únicas, da primeira à mais recente; vazio por marcos e ausente na API anterior. */
  deliveries?: ContractDelivery[];
  /** Ofertas em ordem de sequência; ausente nas versões anteriores da API. */
  offers?: ContractOffer[];
  /** Só as partes veem a confirmação; contestação e decisão permanecem privadas. */
  dropout?: ContractDropout | null;
  /** Marcos (vazio quando o contrato é de entrega única). */
  milestones: Milestone[];
  /** Avaliação do cliente (com a resposta do freelancer, se houver). */
  review: Review | null;
  /** O que cancelar (cliente) ou desistir (freelancer) faria agora; null quando não se aplica. */
  cancellation: CancelTerms | null;
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
  /**
   * O pacote escolhido (RF-086): obrigatório quando o serviço tem pacotes. O price precisa ser o
   * do pacote; sem deadlineAt, o prazo é o do pacote.
   */
  packageTier?: PackageTier;
}

export interface ExtensionRequest {
  deadlineAt: string;
  reason: string;
}

/**
 * Etapa do cancelamento (RN-025, ADR 57): 'proposal' antes do aceite; 'withdrawal' o freelancer
 * desiste; 'overdue' prazo vencido sem entrega, a partir do aviso; 'early'/'late' antes ou depois da
 * metade do tempo entre o aceite e o prazo; 'no_deadline' sem prazo; 'credits' em créditos; 'barter'
 * contratação de uma troca.
 */
export type CancelStage =
  'proposal' | 'withdrawal' | 'overdue' | 'early' | 'late' | 'no_deadline' | 'credits' | 'barter';

/** O cancelamento calculado antes de confirmar: a tela mostra, o POST confere e liquida o mesmo. */
export interface CancelTerms {
  allowed: boolean;
  by: 'client' | 'freelancer';
  stage: CancelStage | null;
  refundPercentage: number;
  /** Quanto volta ao cliente (R$; créditos na etapa 'credits'). */
  refundClient: number;
  /** Quanto fica com o freelancer (R$ líquido). */
  releaseFreelancer: number;
  unit: 'BRL' | 'credits' | 'none';
  /** Código do erro quando não dá agora (ex.: 'wait_notice', 'milestone_open'). */
  code: string | null;
  message: string | null;
  /** 'wait_notice': a partir de quando cancelar devolve tudo. */
  availableAt: string | null;
  /** 'late': quando sai o aviso de atraso, a partir do qual cancelar devolve tudo. */
  noticeAt: string | null;
  /** RN-026: contagem informativa na desistência depois do aceite. */
  dropout?: DropoutPreview | null;
}

export interface CancelRequest {
  /** O reembolso que a pessoa viu na tela; se mudou, a API responde 409 cancel_quote_changed. */
  expectedRefund?: number;
  /** Contagem exibida; apenas informativa, não congela desistências de outros contratos. */
  expectedDropoutCount?: number;
}

export interface CancelResult {
  status: ContractStatus;
  refundPercentage: number;
  stage: CancelStage;
  by: 'client' | 'freelancer';
  refundClient: number;
  releaseFreelancer: number;
  unit: 'BRL' | 'credits' | 'none';
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
  /** Quando o destinatário leu (RF-059); null enquanto não lida. */
  readAt: string | null;
}

/** O que a detecção de negociação por fora achou numa mensagem (ADR 45). */
export type OffPlatformSignal = 'pix' | 'phone' | 'email' | 'whatsapp' | 'off_platform';

export interface ChatHistory {
  conversationId: number | null;
  contractId: number;
  otherPartyId: number;
  messages: ChatMessage[];
}

export interface SendMessageRequest {
  content: string;
}

/** Payload emitido no evento realtime `message:new`. */
export type ChatMessageEvent = ChatMessage & { contractId: number };

/** Corpo de POST /messaging/contracts/:id/read: até qual mensagem a tela mostrou (RF-059). */
export interface MarkChatReadRequest {
  /** Id da última mensagem exibida; sem ele, todas as recebidas contam como lidas. */
  upTo?: number;
}

/** Resposta de POST /messaging/contracts/:id/read. */
export interface ChatReadReceipt {
  /** null quando o par ainda não tem conversa (nada a marcar). */
  conversationId: number | null;
  /** Quantas mensagens recebidas viraram lidas agora (0 = já estavam: a chamada é idempotente). */
  marked: number;
  /** Maior id marcado agora; null quando nada mudou. */
  upToId: number | null;
  readAt: string | null;
}

/**
 * Payload do evento realtime `message:read`: as mensagens recebidas por `readerId` até `upToId`
 * estão lidas. Vai para a sala de cada contratação do par, com o id dela.
 */
export interface ChatReadEvent {
  contractId: number;
  conversationId: number;
  readerId: number;
  upToId: number;
  readAt: string;
}

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
  | 'hold_release' // redução da reserva numa oferta do cliente
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

/**
 * Filtro do extrato de R$ (RF-047): `from` e `to` são dias "AAAA-MM-DD" no fuso da conta, os
 * dois inclusivos; sem eles, o extrato inteiro.
 */
export interface WalletTransactionsQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
}

/** Uma página do extrato de R$; `hasMore` diz se há lançamentos depois dela ("Carregar mais"). */
export interface WalletTransactionsPage extends Paginated<WalletTransaction> {
  hasMore: boolean;
}

/** Agrupamento dos ganhos (RF-082): por dia, por semana (de segunda a domingo) ou por mês. */
export type EarningsGranularity = 'day' | 'week' | 'month';

/**
 * Filtro dos ganhos (RF-082): dias "AAAA-MM-DD" no fuso da conta, os dois inclusivos. Sem eles, os
 * últimos 30 dias (dia), 12 semanas (semana) ou 12 meses (mês) até hoje.
 */
export interface WalletEarningsQuery {
  from?: string;
  to?: string;
  granularity?: EarningsGranularity;
}

/** Ganhos em R$ de um período do gráfico. */
export interface EarningsBucket {
  /** Início do período no fuso da conta: "AAAA-MM-DD" (dia; na semana, a segunda) ou "AAAA-MM". */
  bucket: string;
  /** O que ficou disponível: liberações do escrow mais tornas recebidas (já sem a taxa). */
  amount: number;
  /** Contratações com liberação no período (uma por marcos conta uma vez por período). */
  contracts: number;
  /** Trocas concluídas com torna recebida no período. */
  barters: number;
}

/**
 * Ganhos do freelancer por período (RF-082), lidos do ledger de R$: só liberação do escrow e torna
 * recebida. Créditos (time-bank) vêm à parte, nunca somados aos reais.
 */
export interface WalletEarnings {
  from: string;
  to: string;
  granularity: EarningsGranularity;
  /** Fuso em que os dias foram contados (o da conta). */
  timezone: BrazilTimezone;
  /** Já recebeu alguma vez, em reais ou em créditos, fora do período inclusive. */
  hasEarnings: boolean;
  totals: {
    amount: number;
    /** Contratações distintas com liberação no período. */
    contracts: number;
    barters: number;
    /** amount ÷ (contracts + barters); null sem nada pago no período. */
    averageTicket: number | null;
  };
  /** Todos os períodos entre from e to, os vazios com zero. */
  series: EarningsBucket[];
  /**
   * Créditos no período: entram no aceite (escrow) e as devoluções de cancelamento ou disputa
   * descontam no dia em que acontecem; `contracts` conta as contratações aceitas no período.
   */
  credits: { total: number; contracts: number };
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

/** Filtro do extrato de créditos (RF-047): o mesmo do extrato de R$ (dias no fuso da conta). */
export type CreditTransactionsQuery = WalletTransactionsQuery;

/** Uma página do extrato de créditos; `hasMore` diz se há lançamentos depois dela. */
export interface CreditTransactionsPage extends Paginated<CreditTransaction> {
  hasMore: boolean;
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
  /**
   * Quem avaliou é empresa (RF-018): nome fantasia e perfil público; null quando é pessoa. Ausente
   * nas versões anteriores da API.
   */
  reviewerCompany?: CompanyRef | null;
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
  /** Nota média (0 sem avaliação): o 1º critério do ranking por categoria e local (RN-056). */
  avgRating: number;
  /** Contratações concluídas: o 2º critério da RN-056 (o 3º é o XP). */
  completedContracts: number;
  /** Só no ranking local: distância em km até o ponto pesquisado. */
  distanceKm?: number;
}

/**
 * Filtros do ranking (RF-067). Sem nenhum, é o ranking geral por XP; com categoria e/ou o ponto do
 * "perto de mim" (lat e lng juntos, raio `ranking_radius_km` da plataforma), segue a RN-056.
 */
export interface LeaderboardQuery {
  categoryId?: number;
  lat?: number;
  lng?: number;
}

export type MissionType = 'daily' | 'weekly' | 'achievement';
export type MissionAction =
  'complete_contracts' | 'fast_response_hours' | 'daily_login' | 'complete_barter';

/**
 * Missão do catálogo com o progresso de quem pede no período vigente (RF-066, RN-054). O período
 * é o dia ou a semana (segunda a domingo) no fuso da conta; virou, o progresso recomeça do zero.
 */
export interface Mission {
  id: number;
  title: string;
  description: string | null;
  type: MissionType;
  action: MissionAction;
  xpReward: number;
  progress: number;
  target: number;
  completed: boolean;
  completedAt: string | null;
  /** Fim do período: 23:59:59 do dia ou do domingo, no fuso da conta; null na conquista sem prazo. */
  expiresAt: string | null;
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
  /**
   * De onde veio o valor de cada lado (RF-084): preço fechado do catálogo, ou informado pelo
   * proponente (serviço a combinar, por hora ou descrito). Ausente nas versões anteriores da API;
   * as trocas propostas antes da 1.45.0 vêm como 'informed'.
   */
  offeredValueSource?: BarterValueSource;
  requestedValueSource?: BarterValueSource;
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
  /**
   * Valor de cada lado (RF-084). Com serviço de preço fechado no catálogo, o sistema usa o preço
   * do catálogo: o campo pode faltar, e um valor diferente é recusado (422 estimate_mismatch).
   * Serviço a combinar, por hora ou sem preço, e o lado descrito, exigem o valor (422
   * estimate_required).
   */
  estimatedValueOffered?: number;
  estimatedValueRequested?: number;
}

/** Origem do valor de um lado da troca (RF-084). */
export type BarterValueSource = 'catalog' | 'informed';

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
  /**
   * Prazo de pagamento (RN-035): 23:59:59 de Brasília do último dia útil, calculado e gravado no
   * pedido. null só em saque já encerrado antes de o prazo existir (1.44.0).
   */
  dueAt: string | null;
}

/** Saque na fila do admin (destino completo: é o admin quem paga). */
export interface AdminWithdrawal extends Withdrawal {
  userId: number;
  userUlid: string;
  userEmail: string;
  userName: string | null;
  destination: string;
  /** Ainda não pago (aguardando ou em processamento) e já passou do prazo. */
  overdue: boolean;
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
  /** RN-020: contratação do próprio cliente que impede uma nova proposta ao mesmo freelancer. */
  contractId?: number;
}

/** Atendimento privado; não altera disputas financeiras nem os prazos das contratações. */
export type SupportCategory = 'payment' | 'dispute' | 'account' | 'fraud' | 'other';
export type SupportStatus = 'open' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed';
export type SupportPriority = 'low' | 'medium' | 'high' | 'critical';

export interface SupportTicket {
  id: number;
  ulid: string;
  userId: number;
  /** Histórico da conta anonimizada: equipe pode consultar, mas não acrescentar texto. */
  ownerDeleted: boolean;
  contractId: number | null;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  priority: SupportPriority;
  assignedTo: number | null;
  firstResponseAt: string | null;
  slaDueAt: string;
  slaAlertedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessage {
  id: number;
  ticketId: number;
  senderId: number;
  from: 'user' | 'support';
  message: string;
  internal: boolean;
  createdAt: string;
}

export interface SupportTicketDetail extends SupportTicket {
  /** Últimas 50 mensagens em ordem cronológica; notas internas só no endpoint administrativo. */
  messages: SupportMessage[];
  nextBeforeId: number | null;
}

export interface CreateSupportTicketRequest {
  category: SupportCategory;
  subject: string;
  description: string;
  contractId?: number | null;
}

export interface ReplySupportTicketRequest {
  message: string;
}

export interface AdminReplySupportTicketRequest extends ReplySupportTicketRequest {
  internal?: boolean;
  resolve?: boolean;
}

export interface UpdateSupportTicketRequest {
  priority?: SupportPriority;
  status?: 'in_progress' | 'waiting_user';
}

export interface SupportTicketQuery {
  page?: number;
  limit?: number;
  status?: SupportStatus;
}
