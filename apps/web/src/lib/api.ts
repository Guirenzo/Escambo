import type {
  SupportTicket,
  SupportTicketDetail,
  SupportTicketQuery,
  CreateSupportTicketRequest,
  ReplySupportTicketRequest,
  AdminReplySupportTicketRequest,
  UpdateSupportTicketRequest,
  CancelRequest,
  CancelResult,
  AdminAppeal,
  AdminAppealDecisionRequest,
  AdminAppealDecisionResult,
  AdminDeletionRequest,
  AdminEmail,
  AdminFinanceReport,
  AdminReportAction,
  AdminReportActionRequest,
  AdminReportActionResult,
  AdminReportGroup,
  AdminMetrics,
  AdminStorage,
  AdminUsageReport,
  FinanceGranularity,
  AdminWithdrawal,
  AppealDecision,
  AuthResponse,
  AvailabilityPeriod,
  BarterAgreement,
  Boost,
  BoostPlan,
  Category,
  ChangePasswordRequest,
  AccountContact,
  ChangeEmailRequest,
  ConfirmEmailChangeResponse,
  PendingEmailChange,
  ChatHistory,
  ChatMessage,
  ChatReadReceipt,
  ClientProfile,
  Consent,
  ContentReport,
  Contract,
  ContractList,
  ContractStatus,
  ContractWithHistory,
  ContractDropout,
  CounterOfferRequest,
  CreateBarterRequest,
  CreateBoostRequest,
  CreateContentReportRequest,
  CreateContractRequest,
  CreateDepositRequest,
  CreateFavoriteRequest,
  CreateReviewRequest,
  CreateSavedSearchRequest,
  CreateServiceRequest,
  CreditTransactionsPage,
  CreditTransactionsQuery,
  DataDeletionRequest,
  DataExportRequest,
  Deposit,
  Dispute,
  EmailPreference,
  UpdateEmailPreferenceRequest,
  Favorite,
  FavoriteTargetType,
  ContentRemoval,
  MyModeration,
  MyDropout,
  MyDropouts,
  AdminDropout,
  FreelancerProfile,
  GamificationProfile,
  LeaderboardEntry,
  LeaderboardQuery,
  Mission,
  LoginRequest,
  LoginResponse,
  MfaChallenge,
  MfaEnabledResponse,
  MfaLoginRequest,
  MfaRecoveryCodesResponse,
  MfaSetup,
  MfaStatus,
  AdminAccountLookup,
  CompanyProfile,
  CpfStatus,
  PublicCompanyProfile,
  UpsertCompanyProfileRequest,
  VerifyCpfRequest,
  MediaPurpose,
  MediaUpload,
  ModerationHealth,
  MyProfiles,
  NotificationList,
  PushSendResult,
  PushStatus,
  PushSubscriptionRequest,
  OpenDisputeRequest,
  Paginated,
  PlatformSetting,
  PortfolioItem,
  PublicFreelancerProfile,
  PublicSettings,
  PublicUser,
  UserStatus,
  PurgeAttachmentsResult,
  RecordConsentRequest,
  RefreshResponse,
  RegisterRequest,
  ReorderPortfolioRequest,
  ResolveDisputeRequest,
  Review,
  SavedSearch,
  Service,
  UpdateSavedSearchRequest,
  UpdateServiceRequest,
  UpsertClientProfileRequest,
  UpsertFreelancerProfileRequest,
  UpsertPortfolioItemRequest,
  Wallet,
  WalletEarnings,
  WalletEarningsQuery,
  WalletTransactionsPage,
  WalletTransactionsQuery,
  Withdrawal,
  CreateWithdrawalRequest,
} from '@escambo/types';

const BASE_URL = '/api';
const TOKEN_KEY = 'escambo_token';
const REFRESH_KEY = 'escambo_refresh';

/** Eventos de sessão (ouvidos pelo AuthProvider e pelo socket). */
export const SESSION_TOKEN_EVENT = 'escambo:token';
export const SESSION_EXPIRED_EVENT = 'escambo:session-expired';
export const ACCOUNT_STATUS_EVENT = 'escambo:account-status';
/** A API respondeu 503 em modo de manutenção (ADR 33): o app mostra a tela de manutenção. */
export const MAINTENANCE_EVENT = 'escambo:maintenance';
/** O proxy (nginx ou Caddy) não alcançou a API ou o web (RNF-010): o app mostra a tela de fora do ar. */
export const OUTAGE_EVENT = 'escambo:outage';

/** Filtros da busca de serviços (lat+lng+radiusKm = descoberta local por proximidade). */
export type ServiceSort =
  'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest' | 'distance';

export interface ServiceQuery {
  q?: string;
  categoryId?: number;
  /** true = atende remoto, false = atende presencial; "remoto e presencial" entra nos dois. */
  isRemote?: boolean;
  ownerId?: number;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  minPrice?: number;
  maxPrice?: number;
  maxDeliveryDays?: number;
  minRating?: number;
  day?: number;
  period?: AvailabilityPeriod;
  now?: boolean;
  sort?: ServiceSort;
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
let refreshingToken: string | null = null;

/**
 * Renova o access token (expira em 1h) com o refresh token. Várias requisições que tomam 401
 * ao mesmo tempo compartilham UMA renovação (single-flight). Devolve false se a sessão acabou.
 */
async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;
  if (!refreshing || refreshingToken !== refreshToken) {
    const renewingToken = refreshToken;
    refreshingToken = renewingToken;
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: renewingToken }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as RefreshResponse;
        if (refreshToken !== renewingToken) return false;
        setSession({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return true;
      } catch {
        return false;
      } finally {
        if (refreshingToken === renewingToken) {
          refreshing = null;
          refreshingToken = null;
        }
      }
    })();
  }
  return refreshing;
}

function expireSession(): void {
  setSession(null);
  emit(SESSION_EXPIRED_EVENT);
}

// Suspensão mantém consulta e direitos; banimento/exclusão encerram a sessão.
const BLOCKED_CODES = new Set(['account_blocked', 'account_banned', 'account_deleted']);

export function isAccountStatus(status: unknown): status is UserStatus {
  return ['active', 'suspended', 'banned', 'pending_verification'].includes(String(status));
}

function accountStatusResponse(res: Response, token: string | null): void {
  if (!token || token !== accessToken) return;
  const status = res.headers?.get('X-Account-Status');
  if (isAccountStatus(status)) {
    if (status === 'banned') expireSession();
    else emit(ACCOUNT_STATUS_EVENT, status);
  }
}

function accountErrorResponse(res: Response, token: string | null, data: unknown): void {
  if (res.status !== 403 || !token || token !== accessToken) return;
  const code = (data as { error?: string }).error ?? '';
  if (code === 'account_suspended') emit(ACCOUNT_STATUS_EVENT, 'suspended');
  else if (BLOCKED_CODES.has(code)) expireSession();
}

// Nessas rotas um 401 é resposta legítima (credenciais), não token vencido. No segundo passo do
// login (2FA), o 401 é o pedido do segundo fator que venceu: a tela volta para a senha.
const NO_REFRESH = [
  '/auth/login',
  '/auth/login/mfa',
  '/auth/register',
  '/auth/refresh',
  '/auth/logout',
];

/** A resposta do login é o pedido do segundo fator (conta com 2FA), e não a sessão. */
export function isMfaChallenge(res: LoginResponse): res is MfaChallenge {
  return (res as Partial<MfaChallenge>).mfaRequired === true;
}

/** O que a 2FA pede para mexer nela: a senha da conta e um código do app ou de recuperação. */
export interface MfaConfirmRequest {
  password: string;
  code: string;
}

/** Falha HTTP com os dados necessários para orientar o próximo passo do usuário. */
export class ApiRequestError extends Error {
  readonly contractId?: number;

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    contractId?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    if (typeof contractId === 'number' && Number.isSafeInteger(contractId) && contractId > 0) {
      this.contractId = contractId;
    }
  }
}

/**
 * Mensagens para quando a API não diz nada (RNF-028): o navegador não alcançou o servidor
 * ("Failed to fetch") ou a resposta não trouxe JSON (502 do proxy, página HTML de erro).
 */
export const NETWORK_ERROR_MESSAGE =
  'Sem conexão com o servidor. Confira sua internet e tente de novo.';
export const UNAVAILABLE_MESSAGE = 'Serviço indisponível no momento. Tente de novo em instantes.';

/** Texto da falha pelo status HTTP, para a resposta de erro que não trouxe mensagem. */
export function statusMessage(status: number): string {
  if (status >= 500) return UNAVAILABLE_MESSAGE;
  switch (status) {
    case 401:
      return 'Sua sessão terminou. Entre de novo para continuar.';
    case 403:
      return 'Você não tem permissão para fazer isso.';
    case 404:
      return 'Não encontramos o que você pediu.';
    case 413:
      return 'O envio passou do tamanho permitido.';
    case 429:
      return 'Muitas tentativas. Tente novamente em alguns minutos.';
    default:
      return 'Não foi possível concluir. Tente de novo.';
  }
}

/** fetch que troca a falha de rede pela mensagem em português; o cancelamento segue como veio. */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'AbortError') throw error;
    throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0, 'network_error');
  }
}

/** Corpo de erro lido como objeto; JSON que não é objeto (null, lista, texto) vale como vazio. */
function errorBody(data: unknown): {
  error?: unknown;
  message?: unknown;
  contractId?: unknown;
  returnAt?: unknown;
} {
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/** A mensagem que a API mandou, se for texto de verdade. */
function apiMessage(body: { message?: unknown }): string | undefined {
  return typeof body.message === 'string' && body.message.trim() ? body.message : undefined;
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const token = accessToken;
  const res = await send(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      // FormData (upload): o navegador põe o Content-Type com o boundary do multipart.
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  accountStatusResponse(res, token);
  // Access token vencido: renova e repete a chamada uma vez; se não der, encerra a sessão.
  if (
    res.status === 401 &&
    retry &&
    token === accessToken &&
    refreshToken &&
    !NO_REFRESH.includes(path)
  ) {
    const renewingToken = refreshToken;
    if (await refreshSession()) return request<T>(path, options, false);
    if (refreshToken === renewingToken) expireSession();
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = errorBody(data);
    accountErrorResponse(res, token, err);
    const code = typeof err.error === 'string' ? err.error : undefined;
    // Com previsão de volta (RNF-010), o 503 traz a hora: a tela a mostra sem outra chamada.
    if (res.status === 503 && code === 'maintenance')
      emit(MAINTENANCE_EVENT, {
        returnAt: typeof err.returnAt === 'string' ? err.returnAt : null,
      });
    if (res.status === 503 && code === 'service_unavailable') emit(OUTAGE_EVENT);
    // Sem mensagem da API (proxy, HTML, só o código), quem usa lê o que houve, e não "Erro 502".
    throw new ApiRequestError(
      apiMessage(err) ?? statusMessage(res.status),
      res.status,
      code,
      err.contractId,
    );
  }
  return data as T;
}

/** Entrega com arquivos (RF-035): mensagem, links (campo repetido) e os arquivos em `attachments`. */
function deliveryForm(message: string, attachments: File[], links: string[] = []): FormData {
  const form = new FormData();
  form.append('message', message);
  for (const link of links) form.append('files', link);
  for (const file of attachments) form.append('attachments', file, file.name);
  return form;
}

/** Nome de arquivo do Content-Disposition (prefere o UTF-8 do RFC 5987; senão o ASCII). */
function fileNameFrom(disposition: string, fallback: string): string {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      /* cai no ASCII */
    }
  }
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
}

/** GET binário com o token (renova a sessão uma vez num 401): blob + nome sugerido. */
async function fetchBlob(
  path: string,
  fallbackName: string,
  what: string,
): Promise<{ blob: Blob; fileName: string }> {
  let responseToken = accessToken;
  const fetchIt = async () => {
    const token = accessToken;
    responseToken = token;
    const res = await send(`${BASE_URL}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    accountStatusResponse(res, token);
    return res;
  };
  let res = await fetchIt();
  if (res.status === 401 && responseToken === accessToken && (await refreshSession()))
    res = await fetchIt();
  if (!res.ok) {
    const body = errorBody(await res.json().catch(() => ({})));
    accountErrorResponse(res, responseToken, body);
    throw new ApiRequestError(
      apiMessage(body) ?? `Não foi possível ${what}. ${statusMessage(res.status)}`,
      res.status,
      typeof body.error === 'string' ? body.error : undefined,
    );
  }
  const fileName = fileNameFrom(res.headers.get('content-disposition') ?? '', fallbackName);
  return { blob: await res.blob(), fileName };
}

/** Client tipado — todos os tipos vêm de @escambo/types (compartilhados com o backend). */
/** Query string do relatório financeiro (só os campos preenchidos). */
const financeQs = (q: { from?: string; to?: string; granularity: string }): string =>
  new URLSearchParams(
    Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  ).toString();

/** Query string dos extratos de R$ e de créditos (só os campos preenchidos). */
function walletQuery(query: WalletTransactionsQuery): string {
  const search = new URLSearchParams();
  if (query.page != null) search.set('page', String(query.page));
  if (query.limit != null) search.set('limit', String(query.limit));
  if (query.from) search.set('from', query.from);
  if (query.to) search.set('to', query.to);
  return search.size ? `?${search}` : '';
}

function supportQuery(query: SupportTicketQuery): string {
  const search = new URLSearchParams();
  if (query.page != null) search.set('page', String(query.page));
  if (query.limit != null) search.set('limit', String(query.limit));
  if (query.status) search.set('status', query.status);
  return search.size ? `?${search}` : '';
}

/** Filtro da lista de contratações (RF-040): sem status, todas. */
export interface ContractListQuery {
  page?: number;
  limit?: number;
  status?: ContractStatus[];
}

export const api = {
  supportTickets: (query: SupportTicketQuery = {}) =>
    request<Paginated<SupportTicket>>(`/support/tickets${supportQuery(query)}`),
  supportTicket: (id: number, beforeId?: number) =>
    request<SupportTicketDetail>(
      `/support/tickets/${id}${beforeId ? `?beforeId=${beforeId}` : ''}`,
    ),
  createSupportTicket: (body: CreateSupportTicketRequest) =>
    request<SupportTicketDetail>('/support/tickets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  replySupportTicket: (id: number, body: ReplySupportTicketRequest) =>
    request<SupportTicketDetail>(`/support/tickets/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  closeSupportTicket: (id: number) =>
    request<SupportTicketDetail>(`/support/tickets/${id}/close`, { method: 'POST' }),
  adminSupportTickets: (query: SupportTicketQuery = {}) =>
    request<Paginated<SupportTicket>>(`/admin/support/tickets${supportQuery(query)}`),
  adminSupportTicket: (id: number, beforeId?: number) =>
    request<SupportTicketDetail>(
      `/admin/support/tickets/${id}${beforeId ? `?beforeId=${beforeId}` : ''}`,
    ),
  adminReplySupportTicket: (id: number, body: AdminReplySupportTicketRequest) =>
    request<SupportTicketDetail>(`/admin/support/tickets/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  adminUpdateSupportTicket: (id: number, body: UpdateSupportTicketRequest) =>
    request<SupportTicketDetail>(`/admin/support/tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  // auth
  register: (body: RegisterRequest) =>
    request<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  /** Senha conferida: a sessão, ou (conta com 2FA) o pedido do segundo fator, ainda sem sessão. */
  login: (body: LoginRequest) =>
    request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  /** Segundo passo do login (RF-090): o código do app ou um de recuperação abre a sessão. */
  loginMfa: (body: MfaLoginRequest) =>
    request<AuthResponse>('/auth/login/mfa', { method: 'POST', body: JSON.stringify(body) }),
  // verificação em duas etapas da própria conta (RF-090, ADR 66)
  mfaStatus: () => request<MfaStatus>('/auth/mfa'),
  /** Começa a ativação: um segredo novo, ainda inativo, para o app autenticador. */
  mfaSetup: (password: string) =>
    request<MfaSetup>('/auth/mfa/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  /**
   * Ativa com o primeiro código do app. A API encerra todas as sessões e devolve um par novo só
   * para esta, como na troca de senha: guardá-lo aqui é o que mantém a pessoa dentro.
   */
  mfaEnable: async (code: string): Promise<MfaEnabledResponse> => {
    const res = await request<MfaEnabledResponse>('/auth/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    return res;
  },
  mfaDisable: (body: MfaConfirmRequest) =>
    request<void>('/auth/mfa/disable', { method: 'POST', body: JSON.stringify(body) }),
  /** Códigos de recuperação novos; os anteriores deixam de valer. */
  mfaRecoveryCodes: (body: MfaConfirmRequest) =>
    request<MfaRecoveryCodesResponse>('/auth/mfa/recovery-codes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  me: () => request<PublicUser>('/auth/me'),
  logoutAll: () => request<{ revoked: number }>('/auth/logout-all', { method: 'POST' }),
  logout: (refreshToken: string) =>
    request<void>('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  verifyEmail: (token: string) =>
    request<PublicUser>('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
  resendVerification: () =>
    request<{ sent: boolean }>('/auth/resend-verification', { method: 'POST' }),
  forgotPassword: (email: string) =>
    request<{ sent: boolean }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    request<void>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  /**
   * Troca de senha com login (RF-017). A API encerra todas as sessões e devolve um par novo só
   * para esta: guardá-lo aqui é o que mantém a pessoa dentro (o refresh antigo já não vale).
   */
  changePassword: async (body: ChangePasswordRequest): Promise<RefreshResponse> => {
    const tokens = await request<RefreshResponse>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return tokens;
  },
  /** Contato da conta (RF-017): e-mail, troca pendente e telefone; só o titular vê. */
  accountContact: () => request<AccountContact>('/auth/contact'),
  /** Pede a troca de e-mail; o link vai ao endereço novo e nada muda até a confirmação. */
  changeEmail: (body: ChangeEmailRequest) =>
    request<PendingEmailChange>('/auth/change-email', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelEmailChange: () => request<void>('/auth/change-email', { method: 'DELETE' }),
  /**
   * Confirma a troca pelo link. A API encerra todas as sessões; se esta aba estava logada na mesma
   * conta, vem o par novo dela, guardado aqui para a pessoa seguir dentro.
   */
  confirmEmailChange: async (token: string): Promise<ConfirmEmailChangeResponse> => {
    const res = await request<ConfirmEmailChangeResponse>('/auth/confirm-email-change', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    if (res.session) setSession(res.session);
    return res;
  },
  /** Grava o telefone (a API guarda em E.164) ou apaga, com null. */
  updatePhone: (phone: string | null) =>
    request<AccountContact>('/auth/phone', { method: 'PUT', body: JSON.stringify({ phone }) }),

  // dashboard
  wallet: () => request<Wallet>('/wallet'),
  gamification: () => request<GamificationProfile>('/gamification/me'),
  /** Ranking (RF-067): sem filtro, o geral por XP; com categoria e/ou lat+lng, a RN-056. */
  leaderboard: (query: LeaderboardQuery = {}) => {
    const qs = new URLSearchParams();
    if (query.categoryId != null) qs.set('categoryId', String(query.categoryId));
    if (query.lat != null && query.lng != null) {
      qs.set('lat', String(query.lat));
      qs.set('lng', String(query.lng));
    }
    return request<LeaderboardEntry[]>(`/gamification/leaderboard${qs.size ? `?${qs}` : ''}`);
  },
  /** Missões do período vigente (RF-066); abrir conta como o acesso do dia. */
  missions: () => request<Mission[]>('/gamification/me/missions'),

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
  // imagens de perfil e portfólio (ADR 36)
  /** Envia a imagem (recortada ou reduzida no navegador); devolve a URL pública (/api/media/...). */
  uploadMedia: (file: Blob, name: string, purpose: MediaPurpose) => {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', file, name);
    return request<MediaUpload>('/media', { method: 'POST', body: form });
  },
  // buscas salvas (ADR 35)
  savedSearches: () => request<SavedSearch[]>('/saved-searches'),
  createSavedSearch: (body: CreateSavedSearchRequest) =>
    request<SavedSearch>('/saved-searches', { method: 'POST', body: JSON.stringify(body) }),
  updateSavedSearch: (id: number, body: UpdateSavedSearchRequest) =>
    request<SavedSearch>(`/saved-searches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSavedSearch: (id: number) => request<void>(`/saved-searches/${id}`, { method: 'DELETE' }),
  createService: (body: CreateServiceRequest) =>
    request<Service>('/services', { method: 'POST', body: JSON.stringify(body) }),
  /** "Meus serviços" (RF-030): os do dono, pausados inclusive (a busca só traz os ativos). */
  myServices: () => request<Service[]>('/services/mine'),
  /** Detalhe do serviço; abrir soma uma visualização (RF-029) quando quem abre não é o dono. */
  service: (id: number) => request<Service>(`/services/${id}`),
  /** Edita o serviço; `{ isActive }` sozinho pausa ou reativa (RF-030). */
  updateService: (id: number, body: UpdateServiceRequest) =>
    request<Service>(`/services/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // contratações
  /** Lista do painel (RF-040): página, limite e filtro por status; o total vem da API. */
  contracts: (query: ContractListQuery = {}) => {
    const qs = new URLSearchParams();
    if (query.page != null) qs.set('page', String(query.page));
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.status?.length) qs.set('status', query.status.join(','));
    return request<ContractList>(`/contracts${qs.size ? `?${qs}` : ''}`);
  },
  createContract: (body: CreateContractRequest) =>
    request<Contract>('/contracts', { method: 'POST', body: JSON.stringify(body) }),
  contractDetail: (id: number) => request<ContractWithHistory>(`/contracts/${id}`),
  requestExtension: (id: number, body: { deadlineAt: string; reason: string }) =>
    request<Contract>(`/contracts/${id}/extension`, { method: 'POST', body: JSON.stringify(body) }),
  /** Decide o pedido que a pessoa viu (`seq`): trocado no meio, 409 extension_changed (ADR 57). */
  resolveExtension: (id: number, decision: 'accept' | 'decline', seq?: number) =>
    request<Contract>(`/contracts/${id}/extension/${decision}`, {
      method: 'POST',
      body: JSON.stringify(seq === undefined ? {} : { seq }),
    }),
  contractAction: (id: number, action: 'accept' | 'reject' | 'approve', seq?: number) =>
    request<Contract>(`/contracts/${id}/${action}`, {
      method: 'POST',
      ...(seq === undefined ? {} : { body: JSON.stringify({ seq }) }),
    }),
  counterOffer: (id: number, body: CounterOfferRequest) =>
    request<ContractWithHistory>(`/contracts/${id}/offers`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  acceptCounterOffer: (id: number, seq: number) =>
    request<ContractWithHistory>(`/contracts/${id}/offers/${seq}/accept`, { method: 'POST' }),
  /** Cancelar ou desistir com o reembolso que a tela mostrou (ADR 57): mudou, 409. */
  cancelContract: (id: number, body: CancelRequest) =>
    request<CancelResult>(`/contracts/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  agreeDropout: (id: number) =>
    request<ContractDropout>(`/contracts/${id}/dropout/agreed`, { method: 'POST' }),
  myDropouts: () => request<MyDropouts>('/profiles/me/dropouts'),
  appealDropout: (id: number, text: string) =>
    request<MyDropout>(`/profiles/me/dropouts/${id}/appeal`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  adminDropouts: () => request<AdminDropout[]>('/admin/dropouts?status=appealed'),
  adminUserDropouts: (ulid: string) =>
    request<AdminDropout[]>(`/admin/users/${encodeURIComponent(ulid)}/dropouts`),
  adminDecideDropout: (id: number, decision: 'excuse' | 'uphold', note: string) =>
    request<MyDropout>(`/admin/dropouts/${id}/${decision}`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  requestRevision: (id: number, note: string) =>
    request<Contract>(`/contracts/${id}/request-revision`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  grantContractRevision: (id: number) =>
    request<Contract>(`/contracts/${id}/revisions/grant`, { method: 'POST' }),
  grantMilestoneRevision: (contractId: number, milestoneId: number) =>
    request<ContractWithHistory>(
      `/contracts/${contractId}/milestones/${milestoneId}/revisions/grant`,
      { method: 'POST' },
    ),
  /** Entrega única (RF-035): com arquivos vai em multipart (`attachments`), senão em JSON. */
  deliverContract: (id: number, message: string, attachments: File[] = [], links: string[] = []) =>
    request<Contract>(`/contracts/${id}/deliver`, {
      method: 'POST',
      body: attachments.length
        ? deliveryForm(message, attachments, links)
        : JSON.stringify(links.length ? { message, files: links } : { message }),
    }),
  /** Escrow por marcos: entregar, aprovar (libera só aquele valor) ou pedir revisão de um marco. */
  milestoneAction: (
    contractId: number,
    milestoneId: number,
    action: 'deliver' | 'approve' | 'request-revision',
    text?: string,
    attachments: File[] = [],
  ) =>
    request<ContractWithHistory>(`/contracts/${contractId}/milestones/${milestoneId}/${action}`, {
      method: 'POST',
      body:
        action === 'deliver' && attachments.length
          ? deliveryForm(text ?? '', attachments)
          : JSON.stringify(
              action === 'deliver'
                ? { message: text }
                : action === 'request-revision'
                  ? { note: text }
                  : {},
            ),
    }),

  // chat do contrato
  chatHistory: (contractId: number) => request<ChatHistory>(`/messaging/contracts/${contractId}`),
  /** Envia imagem ou arquivo (multipart) com legenda opcional. */
  sendAttachment: (contractId: number, file: File, content?: string) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (content) form.append('content', content);
    return request<ChatMessage>(`/messaging/contracts/${contractId}/attachments`, {
      method: 'POST',
      body: form,
    });
  },
  /** Bytes de um anexo (a URL do ChatAttachment exige o token, então não vai direto num <img>). */
  attachmentBlob: (url: string, fallbackName: string) =>
    fetchBlob(url.replace(/^\/api/, ''), fallbackName, 'baixar o anexo'),
  sendMessage: (contractId: number, content: string) =>
    request<ChatMessage>(`/messaging/contracts/${contractId}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  /** Leitura (RF-059): marca como lidas as recebidas até `upTo`, a última que a tela mostrou. */
  markChatRead: (contractId: number, upTo?: number) =>
    request<ChatReadReceipt>(`/messaging/contracts/${contractId}/read`, {
      method: 'POST',
      body: JSON.stringify(upTo ? { upTo } : {}),
    }),

  // carteira: extrato de R$, depósitos (PIX via gateway) e saques
  /** Extrato de R$; `from`/`to` (dias, no fuso da conta) filtram o período (RF-047). */
  walletTransactions: (query: WalletTransactionsQuery = {}) =>
    request<WalletTransactionsPage>(`/wallet/transactions${walletQuery(query)}`),
  /** Ganhos por período (RF-082): liberações do escrow e tornas recebidas, no fuso da conta. */
  walletEarnings: (query: WalletEarningsQuery = {}) => {
    const search = new URLSearchParams();
    for (const key of ['from', 'to', 'granularity'] as const) {
      const value = query[key];
      if (value) search.set(key, value);
    }
    return request<WalletEarnings>(`/wallet/earnings${search.size ? `?${search}` : ''}`);
  },
  deposits: () => request<Paginated<Deposit>>('/wallet/deposits'),
  deposit: (id: number) => request<Deposit>(`/wallet/deposits/${id}`),
  createDeposit: (body: CreateDepositRequest) =>
    request<Deposit>('/wallet/deposits', { method: 'POST', body: JSON.stringify(body) }),
  simulateDeposit: (id: number) =>
    request<Deposit>(`/wallet/deposits/${id}/simulate`, { method: 'POST' }),
  withdrawals: () => request<Paginated<Withdrawal>>('/withdrawals'),
  requestWithdrawal: (body: CreateWithdrawalRequest) =>
    request<Withdrawal>('/withdrawals', { method: 'POST', body: JSON.stringify(body) }),
  cancelWithdrawal: (id: number) =>
    request<Withdrawal>(`/withdrawals/${id}/cancel`, { method: 'POST' }),

  // notificações
  notifications: () => request<NotificationList>('/notifications'),
  markNotificationRead: (id: number) =>
    request<void>(`/notifications/${id}/read`, { method: 'POST' }),
  emailPreference: () => request<EmailPreference>('/notifications/preferences'),
  /**
   * Avisos push (ADR 52): chave para assinar, quantos aparelhos desta conta recebem e, com o
   * endpoint deste aparelho, se a assinatura dele é desta conta (o navegador pode guardar a de
   * outra pessoa que usou a mesma máquina).
   */
  pushStatus: (endpoint?: string) =>
    request<PushStatus>(
      endpoint
        ? `/notifications/push?endpoint=${encodeURIComponent(endpoint)}`
        : '/notifications/push',
    ),
  pushSubscribe: (body: PushSubscriptionRequest) =>
    request<{ devices: number }>('/notifications/push', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pushUnsubscribe: (endpoint: string) =>
    request<void>('/notifications/push', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: () =>
    request<PushSendResult>('/notifications/push/test', { method: 'POST', body: '{}' }),
  /** Frequência dos e-mails e hora do resumo do dia (ADR 42): muda só o que vier. */
  updateEmailPreference: (body: UpdateEmailPreferenceRequest) =>
    request<EmailPreference>('/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  markAllNotificationsRead: () =>
    request<{ read: number }>('/notifications/read-all', { method: 'POST' }),

  // créditos Escambo (time-bank)
  /** Extrato de créditos; `from`/`to` (dias, no fuso da conta) como no de R$ (RF-047). */
  creditTransactions: (query: CreditTransactionsQuery = {}) =>
    request<CreditTransactionsPage>(`/credits/transactions${walletQuery(query)}`),

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

  // favoritos (serviços e freelancers)
  favorites: () => request<Favorite[]>('/favorites'),
  addFavorite: (body: CreateFavoriteRequest) =>
    request<void>('/favorites', { method: 'POST', body: JSON.stringify(body) }),
  removeFavorite: (targetType: FavoriteTargetType, targetId: number) =>
    request<void>(`/favorites/${targetType}/${targetId}`, { method: 'DELETE' }),

  // disputas (mediação da plataforma)
  disputes: () => request<Dispute[]>('/disputes'),
  openDispute: (body: OpenDisputeRequest) =>
    request<Dispute>('/disputes', { method: 'POST', body: JSON.stringify(body) }),

  // denúncias de conteúdo/usuário
  createReport: (body: CreateContentReportRequest) =>
    request<ContentReport>('/reports', { method: 'POST', body: JSON.stringify(body) }),

  // LGPD: consentimentos (termos, privacidade)
  consents: () => request<Consent[]>('/lgpd/consents'),
  recordConsent: (body: RecordConsentRequest) =>
    request<Consent>('/lgpd/consents', { method: 'POST', body: JSON.stringify(body) }),

  // LGPD: exportação e exclusão dos meus dados
  exportRequests: () => request<DataExportRequest[]>('/lgpd/export-requests'),
  requestExport: () => request<DataExportRequest>('/lgpd/export-requests', { method: 'POST' }),
  deletionRequests: () => request<DataDeletionRequest[]>('/lgpd/deletion-requests'),
  requestDeletion: (reason: string | null) =>
    request<DataDeletionRequest>('/lgpd/deletion-requests', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  /** Baixa a cópia de dados (JSON) com o token; renova a sessão uma vez num 401. */
  downloadExport: (id: number) =>
    fetchBlob(
      `/lgpd/export-requests/${id}/download`,
      `escambo-dados-${id}.json`,
      'baixar a exportação',
    ),

  // admin (mediação, métricas, moderação)
  adminMetrics: () => request<AdminMetrics>('/admin/metrics'),
  adminStorage: () => request<AdminStorage>('/admin/storage'),
  /** Saúde da moderação no período (ADR 47). */
  adminModerationHealth: (days: number) =>
    request<ModerationHealth>(`/admin/moderation/health?days=${days}`),
  adminSettings: () => request<PlatformSetting[]>('/admin/settings'),
  adminUpdateSetting: (key: string, value: number | boolean) =>
    request<PlatformSetting>(`/admin/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  /** Parâmetros públicos (taxa, prazos) — sem login. */
  publicSettings: () => request<PublicSettings>('/settings/public'),
  /** Roda o expurgo de anexos agora (retenção + órfãos), sem esperar a hora do job. */
  adminPurgeAttachments: () =>
    request<PurgeAttachmentsResult>('/admin/storage/purge', { method: 'POST' }),
  adminFinance: (q: { from?: string; to?: string; granularity: FinanceGranularity }) =>
    request<AdminFinanceReport>(`/admin/finance?${financeQs(q)}`),
  /** Uso no período (RF-081): cadastros, contratações e ativos, do snapshot ou calculado agora. */
  adminUsage: (q: { from?: string; to?: string; granularity: FinanceGranularity }) =>
    request<AdminUsageReport>(`/admin/usage?${financeQs(q)}`),
  /** Baixa o ledger do período em CSV com o token; renova a sessão uma vez num 401. */
  downloadFinanceCsv: (q: { from?: string; to?: string; granularity: FinanceGranularity }) =>
    fetchBlob(
      `/admin/finance/export.csv?${financeQs(q)}`,
      'escambo-ledger.csv',
      'exportar o ledger',
    ),
  /** Baixa a série por dia da saúde da moderação em CSV, em dias inteiros de Brasília (ADR 55). */
  downloadModerationCsv: (days: number) =>
    fetchBlob(
      `/admin/moderation/health/export.csv?days=${days}`,
      'escambo-moderacao.csv',
      'exportar a série',
    ),
  adminDisputes: () => request<Dispute[]>('/admin/disputes'),
  adminResolveDispute: (id: number, body: ResolveDisputeRequest) =>
    request<Dispute>(`/admin/disputes/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  adminModerateUser: (ulid: string, action: 'suspend' | 'ban' | 'reactivate') =>
    request<void>(`/admin/users/${encodeURIComponent(ulid)}/${action}`, { method: 'POST' }),
  /** Atendimento: a conta pelo e-mail (404 se não existe). */
  adminAccountLookup: (email: string) =>
    request<AdminAccountLookup>(`/admin/users/lookup?email=${encodeURIComponent(email)}`),
  /** Tira a 2FA de quem perdeu o app e os códigos; o motivo fica no registro do atendimento. */
  adminResetMfa: (ulid: string, reason: string) =>
    request<void>(`/admin/users/${encodeURIComponent(ulid)}/mfa/reset`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  /** Apaga o CPF validado para o titular corrigir (RF-020); o motivo fica no registro. */
  adminResetCpf: (ulid: string, reason: string) =>
    request<void>(`/admin/users/${encodeURIComponent(ulid)}/cpf/reset`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  // moderação (ADR 39)
  adminReports: (status: 'pending' | 'resolved' = 'pending') =>
    request<AdminReportGroup[]>(`/admin/reports?status=${status}`),
  adminReportAction: (id: number, action: AdminReportAction, body: AdminReportActionRequest = {}) =>
    request<AdminReportActionResult>(`/admin/reports/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // contestação e reincidência (ADR 41)
  myModeration: () => request<MyModeration>('/moderation/removals'),
  appealRemoval: (id: number, text: string) =>
    request<ContentRemoval>(`/moderation/removals/${id}/appeal`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  adminAppeals: (status: 'pending' | 'decided' = 'pending') =>
    request<AdminAppeal[]>(`/admin/appeals?status=${status}`),
  /** Imagem em quarentena: a rota exige o token, então vem como blob. */
  adminAppealImage: (id: number) =>
    fetchBlob(`/admin/appeals/${id}/image`, `contestacao-${id}`, 'carregar a imagem'),
  adminDecideAppeal: (
    id: number,
    decision: AppealDecision,
    body: AdminAppealDecisionRequest = {},
  ) =>
    request<AdminAppealDecisionResult>(`/admin/appeals/${id}/${decision}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  adminEmails: (limit = 50) => request<AdminEmail[]>(`/admin/emails?limit=${limit}`),
  adminDeletionRequests: (status: 'pending' | 'all' = 'pending') =>
    request<AdminDeletionRequest[]>(`/admin/deletion-requests?status=${status}`),
  adminDeletionAction: (id: number, action: 'complete' | 'reject', body: { note?: string } = {}) =>
    request<DataDeletionRequest>(`/admin/deletion-requests/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  adminWithdrawals: (status: 'open' | 'all' = 'open') =>
    request<AdminWithdrawal[]>(`/admin/withdrawals?status=${status}`),
  adminWithdrawalAction: (
    id: number,
    action: 'process' | 'complete' | 'fail',
    body: { gatewayRef?: string | null; reason?: string | null } = {},
  ) =>
    request<AdminWithdrawal>(`/admin/withdrawals/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // perfis
  profilesMe: () => request<MyProfiles>('/profiles/me'),
  myPortfolio: () => request<PortfolioItem[]>('/profiles/portfolio'),
  addPortfolioItem: (body: UpsertPortfolioItemRequest) =>
    request<PortfolioItem[]>('/profiles/portfolio', { method: 'POST', body: JSON.stringify(body) }),
  removePortfolioItem: (id: number) =>
    request<PortfolioItem[]>(`/profiles/portfolio/${id}`, { method: 'DELETE' }),
  /** Nova ordem do portfólio: os ids de todos os trabalhos, do primeiro ao último (ADR 43). */
  reorderPortfolio: (ids: number[]) =>
    request<PortfolioItem[]>('/profiles/portfolio/order', {
      method: 'PUT',
      body: JSON.stringify({ ids } satisfies ReorderPortfolioRequest),
    }),
  publicFreelancer: (ulid: string) =>
    request<PublicFreelancerProfile>(`/profiles/freelancer/${encodeURIComponent(ulid)}`),
  putFreelancerProfile: (body: UpsertFreelancerProfileRequest) =>
    request<FreelancerProfile>('/profiles/freelancer', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  putClientProfile: (body: UpsertClientProfileRequest) =>
    request<ClientProfile>('/profiles/client', { method: 'PUT', body: JSON.stringify(body) }),
  /** Dados da empresa (RF-018), só de conta de empresa. */
  putCompanyProfile: (body: UpsertCompanyProfileRequest) =>
    request<CompanyProfile>('/profiles/company', { method: 'PUT', body: JSON.stringify(body) }),
  publicCompany: (ulid: string) =>
    request<PublicCompanyProfile>(`/profiles/company/${encodeURIComponent(ulid)}`),
  /** CPF do freelancer (RF-020): a situação, com o CPF só mascarado. */
  cpfStatus: () => request<CpfStatus>('/profiles/me/cpf'),
  verifyCpf: (body: VerifyCpfRequest) =>
    request<CpfStatus>('/profiles/me/cpf', { method: 'PUT', body: JSON.stringify(body) }),

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
