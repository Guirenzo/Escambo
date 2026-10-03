import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  getRefreshToken,
  getToken,
  MAINTENANCE_EVENT,
  SESSION_EXPIRED_EVENT,
  SESSION_TOKEN_EVENT,
  setSession,
  setToken,
} from './api';

/**
 * O contrato de cada chamada do cliente HTTP: verbo, caminho e corpo que saem para a API. A tela
 * confia nesses três; um caminho trocado aqui vira 404 em produção sem nenhum erro de tipo.
 */

/** Resposta JSON de mentira. */
const reply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Resposta binária de mentira (download): cabeçalhos e blob. */
const blobReply = (status: number, blob: Blob, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  blob: async () => blob,
  json: async () => ({}),
});

function stubFetch(...responses: unknown[]) {
  const fetchMock = vi.fn();
  if (responses.length === 0) fetchMock.mockResolvedValue(reply(200));
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** O que foi mandado na chamada `index` do fetch. */
function sent(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit | undefined];
  const body = init?.body;
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof body === 'string' ? (JSON.parse(body) as unknown) : body,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

/** Escuta um evento da janela durante o teste. */
function listen(name: string) {
  const handler = vi.fn();
  window.addEventListener(name, handler);
  return { handler, stop: () => window.removeEventListener(name, handler) };
}

beforeEach(() => setSession(null));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setSession(null);
});

describe('consultas (GET): cada método lê do caminho certo', () => {
  const gets: Array<[string, () => Promise<unknown>, string]> = [
    ['wallet', () => api.wallet(), '/api/wallet'],
    ['gamification', () => api.gamification(), '/api/gamification/me'],
    ['leaderboard', () => api.leaderboard(), '/api/gamification/leaderboard'],
    ['categories', () => api.categories(), '/api/categories'],
    ['savedSearches', () => api.savedSearches(), '/api/saved-searches'],
    ['contracts', () => api.contracts(), '/api/contracts'],
    ['contractDetail', () => api.contractDetail(7), '/api/contracts/7'],
    ['chatHistory', () => api.chatHistory(7), '/api/messaging/contracts/7'],
    ['walletTransactions', () => api.walletTransactions(), '/api/wallet/transactions'],
    ['deposits', () => api.deposits(), '/api/wallet/deposits'],
    ['deposit', () => api.deposit(3), '/api/wallet/deposits/3'],
    ['withdrawals', () => api.withdrawals(), '/api/withdrawals'],
    ['notifications', () => api.notifications(), '/api/notifications'],
    ['emailPreference', () => api.emailPreference(), '/api/notifications/preferences'],
    ['pushStatus sem aparelho', () => api.pushStatus(), '/api/notifications/push'],
    ['creditTransactions', () => api.creditTransactions(), '/api/credits/transactions'],
    ['boostPlans', () => api.boostPlans(), '/api/boosts/plans'],
    ['myBoosts', () => api.myBoosts(), '/api/boosts'],
    ['barters', () => api.barters(), '/api/barters'],
    ['favorites', () => api.favorites(), '/api/favorites'],
    ['disputes', () => api.disputes(), '/api/disputes'],
    ['consents', () => api.consents(), '/api/lgpd/consents'],
    ['exportRequests', () => api.exportRequests(), '/api/lgpd/export-requests'],
    ['deletionRequests', () => api.deletionRequests(), '/api/lgpd/deletion-requests'],
    ['adminMetrics', () => api.adminMetrics(), '/api/admin/metrics'],
    ['adminStorage', () => api.adminStorage(), '/api/admin/storage'],
    [
      'adminModerationHealth',
      () => api.adminModerationHealth(30),
      '/api/admin/moderation/health?days=30',
    ],
    ['adminSettings', () => api.adminSettings(), '/api/admin/settings'],
    ['publicSettings', () => api.publicSettings(), '/api/settings/public'],
    ['adminDisputes', () => api.adminDisputes(), '/api/admin/disputes'],
    ['adminReports (padrão)', () => api.adminReports(), '/api/admin/reports?status=pending'],
    [
      'adminReports resolvidas',
      () => api.adminReports('resolved'),
      '/api/admin/reports?status=resolved',
    ],
    ['myModeration', () => api.myModeration(), '/api/moderation/removals'],
    ['adminAppeals (padrão)', () => api.adminAppeals(), '/api/admin/appeals?status=pending'],
    [
      'adminAppeals decididas',
      () => api.adminAppeals('decided'),
      '/api/admin/appeals?status=decided',
    ],
    ['adminEmails (padrão)', () => api.adminEmails(), '/api/admin/emails?limit=50'],
    ['adminEmails com limite', () => api.adminEmails(10), '/api/admin/emails?limit=10'],
    [
      'adminDeletionRequests (padrão)',
      () => api.adminDeletionRequests(),
      '/api/admin/deletion-requests?status=pending',
    ],
    [
      'adminDeletionRequests todas',
      () => api.adminDeletionRequests('all'),
      '/api/admin/deletion-requests?status=all',
    ],
    [
      'adminWithdrawals (padrão)',
      () => api.adminWithdrawals(),
      '/api/admin/withdrawals?status=open',
    ],
    [
      'adminWithdrawals todos',
      () => api.adminWithdrawals('all'),
      '/api/admin/withdrawals?status=all',
    ],
    ['profilesMe', () => api.profilesMe(), '/api/profiles/me'],
    ['myPortfolio', () => api.myPortfolio(), '/api/profiles/portfolio'],
    ['reviews', () => api.reviews(9), '/api/reviews?freelancerId=9&limit=50'],
  ];

  it.each(gets)('%s', async (_name, call, url) => {
    const fetchMock = stubFetch(reply(200, { marca: url }));
    await expect(call()).resolves.toEqual({ marca: url });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = sent(fetchMock);
    expect(req.url).toBe(url);
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
  });

  it('o endpoint do aparelho e o ulid do perfil vão escapados na URL', async () => {
    const fetchMock = stubFetch();
    await api.pushStatus('https://push.example/send?id=a b&x=1');
    await api.publicFreelancer('01J8/Z Q');
    expect(sent(fetchMock, 0).url).toBe(
      '/api/notifications/push?endpoint=https%3A%2F%2Fpush.example%2Fsend%3Fid%3Da%20b%26x%3D1',
    );
    expect(sent(fetchMock, 1).url).toBe('/api/profiles/freelancer/01J8%2FZ%20Q');
  });
});

describe('gravações: verbo, caminho e corpo de cada método', () => {
  type Write = [
    name: string,
    call: () => Promise<unknown>,
    method: string,
    url: string,
    body?: unknown,
  ];
  const writes: Write[] = [
    [
      'register',
      () => api.register({ email: 'a@b.com', password: 'segredo-1', legalAccepted: true }),
      'POST',
      '/api/auth/register',
      { email: 'a@b.com', password: 'segredo-1', legalAccepted: true },
    ],
    [
      'login',
      () => api.login({ email: 'a@b.com', password: 'segredo-1' }),
      'POST',
      '/api/auth/login',
      { email: 'a@b.com', password: 'segredo-1' },
    ],
    ['logoutAll', () => api.logoutAll(), 'POST', '/api/auth/logout-all'],
    ['logout', () => api.logout('r-1'), 'POST', '/api/auth/logout', { refreshToken: 'r-1' }],
    [
      'verifyEmail',
      () => api.verifyEmail('tok'),
      'POST',
      '/api/auth/verify-email',
      { token: 'tok' },
    ],
    ['resendVerification', () => api.resendVerification(), 'POST', '/api/auth/resend-verification'],
    [
      'forgotPassword',
      () => api.forgotPassword('a@b.com'),
      'POST',
      '/api/auth/forgot-password',
      { email: 'a@b.com' },
    ],
    [
      'resetPassword',
      () => api.resetPassword('tok', 'nova-senha'),
      'POST',
      '/api/auth/reset-password',
      { token: 'tok', password: 'nova-senha' },
    ],
    [
      'createSavedSearch',
      () => api.createSavedSearch({ name: 'Logos', query: 'logo', alertEnabled: true }),
      'POST',
      '/api/saved-searches',
      { name: 'Logos', query: 'logo', alertEnabled: true },
    ],
    [
      'updateSavedSearch',
      () => api.updateSavedSearch(4, { name: null, alertFrequency: 'daily' }),
      'PATCH',
      '/api/saved-searches/4',
      { name: null, alertFrequency: 'daily' },
    ],
    ['deleteSavedSearch', () => api.deleteSavedSearch(4), 'DELETE', '/api/saved-searches/4'],
    [
      'createService',
      () => api.createService({ categoryId: 2, title: 'Logo', description: 'Marca completa' }),
      'POST',
      '/api/services',
      { categoryId: 2, title: 'Logo', description: 'Marca completa' },
    ],
    [
      'createContract',
      () =>
        api.createContract({
          freelancerId: 5,
          title: 'Site',
          description: 'Página única',
          price: 300,
          paymentMode: 'credits',
        }),
      'POST',
      '/api/contracts',
      {
        freelancerId: 5,
        title: 'Site',
        description: 'Página única',
        price: 300,
        paymentMode: 'credits',
      },
    ],
    [
      'requestExtension',
      () =>
        api.requestExtension(7, { deadlineAt: '2026-10-20T15:00:00.000Z', reason: 'Imprevisto' }),
      'POST',
      '/api/contracts/7/extension',
      { deadlineAt: '2026-10-20T15:00:00.000Z', reason: 'Imprevisto' },
    ],
    [
      'resolveExtension com o pedido visto',
      () => api.resolveExtension(7, 'accept', 3),
      'POST',
      '/api/contracts/7/extension/accept',
      { seq: 3 },
    ],
    [
      'resolveExtension sem número do pedido',
      () => api.resolveExtension(7, 'decline'),
      'POST',
      '/api/contracts/7/extension/decline',
      {},
    ],
    ['contractAction', () => api.contractAction(7, 'approve'), 'POST', '/api/contracts/7/approve'],
    [
      'cancelContract',
      () => api.cancelContract(7, { expectedRefund: 100 }),
      'POST',
      '/api/contracts/7/cancel',
      { expectedRefund: 100 },
    ],
    [
      'requestRevision',
      () => api.requestRevision(7, 'Falta o logo'),
      'POST',
      '/api/contracts/7/request-revision',
      { note: 'Falta o logo' },
    ],
    [
      'deliverContract',
      () => api.deliverContract(7, 'Segue o arquivo'),
      'POST',
      '/api/contracts/7/deliver',
      { message: 'Segue o arquivo' },
    ],
    [
      'milestoneAction entregar manda a mensagem',
      () => api.milestoneAction(7, 2, 'deliver', 'Primeira parte'),
      'POST',
      '/api/contracts/7/milestones/2/deliver',
      { message: 'Primeira parte' },
    ],
    [
      'milestoneAction pedir revisão manda a nota',
      () => api.milestoneAction(7, 2, 'request-revision', 'Ajustar a cor'),
      'POST',
      '/api/contracts/7/milestones/2/request-revision',
      { note: 'Ajustar a cor' },
    ],
    [
      'milestoneAction aprovar não manda texto',
      () => api.milestoneAction(7, 2, 'approve', 'ignorado'),
      'POST',
      '/api/contracts/7/milestones/2/approve',
      {},
    ],
    [
      'sendMessage',
      () => api.sendMessage(7, 'Olá'),
      'POST',
      '/api/messaging/contracts/7',
      { content: 'Olá' },
    ],
    [
      'createDeposit',
      () => api.createDeposit({ amount: 50, method: 'pix' }),
      'POST',
      '/api/wallet/deposits',
      { amount: 50, method: 'pix' },
    ],
    ['simulateDeposit', () => api.simulateDeposit(3), 'POST', '/api/wallet/deposits/3/simulate'],
    [
      'requestWithdrawal',
      () => api.requestWithdrawal({ amount: 80, method: 'pix', pixKey: 'a@b.com' }),
      'POST',
      '/api/withdrawals',
      { amount: 80, method: 'pix', pixKey: 'a@b.com' },
    ],
    ['cancelWithdrawal', () => api.cancelWithdrawal(6), 'POST', '/api/withdrawals/6/cancel'],
    [
      'markNotificationRead',
      () => api.markNotificationRead(5),
      'POST',
      '/api/notifications/5/read',
    ],
    [
      'markAllNotificationsRead',
      () => api.markAllNotificationsRead(),
      'POST',
      '/api/notifications/read-all',
    ],
    [
      'pushSubscribe',
      () => api.pushSubscribe({ endpoint: 'https://push.example/1', p256dh: 'chave', auth: 'seg' }),
      'POST',
      '/api/notifications/push',
      { endpoint: 'https://push.example/1', p256dh: 'chave', auth: 'seg' },
    ],
    [
      'pushUnsubscribe',
      () => api.pushUnsubscribe('https://push.example/1'),
      'DELETE',
      '/api/notifications/push',
      { endpoint: 'https://push.example/1' },
    ],
    ['pushTest', () => api.pushTest(), 'POST', '/api/notifications/push/test', {}],
    [
      'updateEmailPreference',
      () => api.updateEmailPreference({ emailFrequency: 'daily', digestHour: 9 }),
      'PUT',
      '/api/notifications/preferences',
      { emailFrequency: 'daily', digestHour: 9 },
    ],
    [
      'createBoost',
      () => api.createBoost({ serviceId: 11, planId: 2 }),
      'POST',
      '/api/boosts',
      { serviceId: 11, planId: 2 },
    ],
    [
      'proposeBarter',
      () =>
        api.proposeBarter({
          receiverId: 8,
          offeredDescription: 'Logo',
          requestedDescription: 'Fotos',
          estimatedValueOffered: 200,
          estimatedValueRequested: 180,
        }),
      'POST',
      '/api/barters',
      {
        receiverId: 8,
        offeredDescription: 'Logo',
        requestedDescription: 'Fotos',
        estimatedValueOffered: 200,
        estimatedValueRequested: 180,
      },
    ],
    ['barterAction', () => api.barterAction(4, 'cancel'), 'POST', '/api/barters/4/cancel'],
    [
      'addFavorite',
      () => api.addFavorite({ targetType: 'service', targetId: 11 }),
      'POST',
      '/api/favorites',
      { targetType: 'service', targetId: 11 },
    ],
    [
      'removeFavorite',
      () => api.removeFavorite('freelancer', 8),
      'DELETE',
      '/api/favorites/freelancer/8',
    ],
    [
      'openDispute',
      () => api.openDispute({ contractId: 7, reason: 'quality', description: 'Veio errado' }),
      'POST',
      '/api/disputes',
      { contractId: 7, reason: 'quality', description: 'Veio errado' },
    ],
    [
      'createReport',
      () => api.createReport({ targetType: 'service', targetId: 11, reason: 'spam' }),
      'POST',
      '/api/reports',
      { targetType: 'service', targetId: 11, reason: 'spam' },
    ],
    [
      'recordConsent',
      () => api.recordConsent({ type: 'terms_of_use', version: '2026-09', accepted: true }),
      'POST',
      '/api/lgpd/consents',
      { type: 'terms_of_use', version: '2026-09', accepted: true },
    ],
    ['requestExport', () => api.requestExport(), 'POST', '/api/lgpd/export-requests'],
    [
      'requestDeletion com motivo',
      () => api.requestDeletion('Não uso mais'),
      'POST',
      '/api/lgpd/deletion-requests',
      { reason: 'Não uso mais' },
    ],
    [
      'requestDeletion sem motivo manda null',
      () => api.requestDeletion(null),
      'POST',
      '/api/lgpd/deletion-requests',
      { reason: null },
    ],
    [
      'adminUpdateSetting',
      () => api.adminUpdateSetting('platform_fee', 12),
      'PUT',
      '/api/admin/settings/platform_fee',
      { value: 12 },
    ],
    [
      'adminUpdateSetting desligando uma chave manda o false (e não some com ele)',
      () => api.adminUpdateSetting('maintenance_mode', false),
      'PUT',
      '/api/admin/settings/maintenance_mode',
      { value: false },
    ],
    [
      'adminPurgeAttachments',
      () => api.adminPurgeAttachments(),
      'POST',
      '/api/admin/storage/purge',
    ],
    [
      'adminResolveDispute',
      () => api.adminResolveDispute(3, { resolution: 'partial_split', refundPercentage: 40 }),
      'POST',
      '/api/admin/disputes/3/resolve',
      { resolution: 'partial_split', refundPercentage: 40 },
    ],
    [
      'adminModerateUser escapa o ulid',
      () => api.adminModerateUser('01J8/Z', 'suspend'),
      'POST',
      '/api/admin/users/01J8%2FZ/suspend',
    ],
    [
      'adminReportAction com nota',
      () => api.adminReportAction(9, 'remove-image', { note: 'Imagem imprópria' }),
      'POST',
      '/api/admin/reports/9/remove-image',
      { note: 'Imagem imprópria' },
    ],
    [
      'adminReportAction sem corpo manda objeto vazio',
      () => api.adminReportAction(9, 'dismiss'),
      'POST',
      '/api/admin/reports/9/dismiss',
      {},
    ],
    [
      'appealRemoval',
      () => api.appealRemoval(2, 'A imagem é minha'),
      'POST',
      '/api/moderation/removals/2/appeal',
      { text: 'A imagem é minha' },
    ],
    [
      'adminDecideAppeal com nota',
      () => api.adminDecideAppeal(2, 'overturn', { note: 'Procede' }),
      'POST',
      '/api/admin/appeals/2/overturn',
      { note: 'Procede' },
    ],
    [
      'adminDecideAppeal sem corpo manda objeto vazio',
      () => api.adminDecideAppeal(2, 'uphold'),
      'POST',
      '/api/admin/appeals/2/uphold',
      {},
    ],
    [
      'adminDeletionAction com nota',
      () => api.adminDeletionAction(5, 'reject', { note: 'Há contrato aberto' }),
      'POST',
      '/api/admin/deletion-requests/5/reject',
      { note: 'Há contrato aberto' },
    ],
    [
      'adminDeletionAction sem corpo manda objeto vazio',
      () => api.adminDeletionAction(5, 'complete'),
      'POST',
      '/api/admin/deletion-requests/5/complete',
      {},
    ],
    [
      'adminWithdrawalAction com referência',
      () => api.adminWithdrawalAction(6, 'complete', { gatewayRef: 'E2E-1' }),
      'POST',
      '/api/admin/withdrawals/6/complete',
      { gatewayRef: 'E2E-1' },
    ],
    [
      'adminWithdrawalAction sem corpo manda objeto vazio',
      () => api.adminWithdrawalAction(6, 'process'),
      'POST',
      '/api/admin/withdrawals/6/process',
      {},
    ],
    [
      'addPortfolioItem',
      () => api.addPortfolioItem({ title: 'Logo', externalUrl: 'https://exemplo.com' }),
      'POST',
      '/api/profiles/portfolio',
      { title: 'Logo', externalUrl: 'https://exemplo.com' },
    ],
    [
      'removePortfolioItem',
      () => api.removePortfolioItem(4),
      'DELETE',
      '/api/profiles/portfolio/4',
    ],
    [
      'reorderPortfolio',
      () => api.reorderPortfolio([3, 1, 2]),
      'PUT',
      '/api/profiles/portfolio/order',
      { ids: [3, 1, 2] },
    ],
    [
      'putFreelancerProfile',
      () => api.putFreelancerProfile({ fullName: 'Ana', headline: 'Designer' }),
      'PUT',
      '/api/profiles/freelancer',
      { fullName: 'Ana', headline: 'Designer' },
    ],
    [
      'putClientProfile',
      () => api.putClientProfile({ fullName: 'Bia', city: 'Joinville' }),
      'PUT',
      '/api/profiles/client',
      { fullName: 'Bia', city: 'Joinville' },
    ],
    [
      'createReview',
      () => api.createReview({ contractId: 7, rating: 5, comment: 'Ótimo' }),
      'POST',
      '/api/reviews',
      { contractId: 7, rating: 5, comment: 'Ótimo' },
    ],
    [
      'respondReview',
      () => api.respondReview(12, 'Obrigada!'),
      'POST',
      '/api/reviews/12/response',
      { response: 'Obrigada!' },
    ],
  ];

  it.each(writes)('%s', async (_name, call, method, url, body) => {
    const fetchMock = stubFetch(reply(200, { ok: true }));
    await expect(call()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = sent(fetchMock);
    expect(req.url).toBe(url);
    expect(req.method).toBe(method);
    expect(req.body).toEqual(body);
    expect(req.headers['Content-Type']).toBe('application/json');
  });
});

describe('busca de serviços e relatório financeiro: só os filtros preenchidos vão na URL', () => {
  it('listServices sem filtro nenhum não põe "?" no caminho', async () => {
    const fetchMock = stubFetch();
    await api.listServices();
    expect(sent(fetchMock).url).toBe('/api/services');
  });

  it('listServices ignora filtro vazio e mantém zero e false', async () => {
    const fetchMock = stubFetch();
    await api.listServices({
      q: 'logo marca',
      categoryId: undefined,
      minPrice: 0,
      now: false,
      sort: 'price_asc',
      page: 2,
      limit: 12,
    });
    expect(sent(fetchMock).url).toBe(
      '/api/services?q=logo+marca&minPrice=0&now=false&sort=price_asc&page=2&limit=12',
    );
    await api.listServices({ q: '' });
    expect(sent(fetchMock, 1).url).toBe('/api/services');
  });

  it('adminFinance manda o período e a granularidade; data em branco fica de fora', async () => {
    const fetchMock = stubFetch();
    await api.adminFinance({ from: '2026-09-01', to: '2026-09-30', granularity: 'day' });
    await api.adminFinance({ from: '', granularity: 'month' });
    expect(sent(fetchMock, 0).url).toBe(
      '/api/admin/finance?from=2026-09-01&to=2026-09-30&granularity=day',
    );
    expect(sent(fetchMock, 1).url).toBe('/api/admin/finance?granularity=month');
  });
});

describe('envio de arquivo (multipart)', () => {
  it('uploadMedia manda o uso e o arquivo com o nome, sem fixar o Content-Type', async () => {
    setToken('tok-1');
    const fetchMock = stubFetch(reply(200, { url: '/api/media/x.webp' }));
    const image = new Blob(['bytes'], { type: 'image/webp' });

    await expect(api.uploadMedia(image, 'avatar.webp', 'avatar')).resolves.toEqual({
      url: '/api/media/x.webp',
    });

    const req = sent(fetchMock);
    expect(req.url).toBe('/api/media');
    expect(req.method).toBe('POST');
    const form = req.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('purpose')).toBe('avatar');
    const file = form.get('file') as File;
    expect(file.name).toBe('avatar.webp');
    expect(file.type).toBe('image/webp');
    // O navegador é quem escreve o Content-Type do multipart (com o boundary).
    expect(req.headers['Content-Type']).toBeUndefined();
    // O envio é de quem está logado: o token vai junto mesmo sem o cabeçalho de JSON.
    expect(req.headers.Authorization).toBe('Bearer tok-1');
  });

  it('sendAttachment manda o arquivo; a legenda só vai quando existe', async () => {
    const fetchMock = stubFetch();
    const file = new File(['pdf'], 'briefing.pdf', { type: 'application/pdf' });

    await api.sendAttachment(7, file, 'Segue o briefing');
    await api.sendAttachment(7, file);

    const withCaption = sent(fetchMock, 0);
    expect(withCaption.url).toBe('/api/messaging/contracts/7/attachments');
    expect(withCaption.method).toBe('POST');
    const first = withCaption.body as FormData;
    expect((first.get('file') as File).name).toBe('briefing.pdf');
    expect(first.get('content')).toBe('Segue o briefing');
    expect(withCaption.headers['Content-Type']).toBeUndefined();
    expect((sent(fetchMock, 1).body as FormData).has('content')).toBe(false);
  });
});

describe('downloads com o token (blob + nome do arquivo)', () => {
  const file = new Blob(['conteudo'], { type: 'application/json' });

  it('downloadExport baixa com o Bearer e usa o nome UTF-8 do Content-Disposition', async () => {
    setToken('tok-1');
    const fetchMock = stubFetch(
      blobReply(200, file, {
        'content-disposition':
          'attachment; filename="dados.json"; filename*=UTF-8\'\'exporta%C3%A7%C3%A3o.json',
      }),
    );

    const result = await api.downloadExport(4);

    expect(result.fileName).toBe('exportação.json');
    expect(result.blob).toBe(file);
    const req = sent(fetchMock);
    expect(req.url).toBe('/api/lgpd/export-requests/4/download');
    expect(req.headers.Authorization).toBe('Bearer tok-1');
  });

  it('sem o nome UTF-8 usa o ASCII; sem cabeçalho, o nome padrão de cada download', async () => {
    const fetchMock = stubFetch(
      blobReply(200, file, { 'content-disposition': 'attachment; filename="ledger-set.csv"' }),
      blobReply(200, file),
      blobReply(200, file),
      blobReply(200, file),
    );

    const csv = await api.downloadFinanceCsv({ from: '2026-09-01', granularity: 'month' });
    const moderation = await api.downloadModerationCsv(7);
    const exportFile = await api.downloadExport(4);
    const image = await api.adminAppealImage(2);

    expect(csv.fileName).toBe('ledger-set.csv');
    expect(sent(fetchMock, 0).url).toBe(
      '/api/admin/finance/export.csv?from=2026-09-01&granularity=month',
    );
    expect(moderation.fileName).toBe('escambo-moderacao.csv');
    expect(sent(fetchMock, 1).url).toBe('/api/admin/moderation/health/export.csv?days=7');
    expect(exportFile.fileName).toBe('escambo-dados-4.json');
    expect(image.fileName).toBe('contestacao-2');
    expect(sent(fetchMock, 3).url).toBe('/api/admin/appeals/2/image');
    // Sem sessão não vai Authorization nenhum.
    expect(sent(fetchMock, 0).headers.Authorization).toBeUndefined();
  });

  it('nome UTF-8 malformado cai no ASCII em vez de quebrar o download', async () => {
    stubFetch(
      blobReply(200, file, {
        'content-disposition': 'attachment; filename="plano.pdf"; filename*=UTF-8\'\'%E0%A4%A',
      }),
    );
    const result = await api.attachmentBlob('/api/messaging/attachments/9', 'anexo');
    expect(result.fileName).toBe('plano.pdf');
  });

  it('attachmentBlob aceita a URL que a API devolve (com /api) sem dobrar o prefixo', async () => {
    const fetchMock = stubFetch(blobReply(200, file));
    const result = await api.attachmentBlob('/api/messaging/attachments/9', 'foto.png');
    expect(sent(fetchMock).url).toBe('/api/messaging/attachments/9');
    expect(result.fileName).toBe('foto.png');
  });

  it('download recusado mostra a mensagem da API; sem mensagem, diz o que não deu para fazer', async () => {
    stubFetch(
      { ...blobReply(404, file), json: async () => ({ message: 'Exportação expirada' }) },
      {
        ...blobReply(500, file),
        json: async () => {
          throw new Error('não é JSON');
        },
      },
    );
    await expect(api.downloadExport(4)).rejects.toThrow('Exportação expirada');
    await expect(api.attachmentBlob('/api/messaging/attachments/9', 'a')).rejects.toThrow(
      'Erro 500 ao baixar o anexo',
    );
  });

  it('num 401 renova a sessão uma vez e baixa de novo com o token novo', async () => {
    setSession({ accessToken: 'velho', refreshToken: 'refresh-1' });
    const fetchMock = stubFetch(
      blobReply(401, file),
      reply(200, { accessToken: 'novo', refreshToken: 'refresh-2' }),
      blobReply(200, file, { 'content-disposition': 'attachment; filename="ok.json"' }),
    );

    const result = await api.downloadExport(4);

    expect(result.fileName).toBe('ok.json');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sent(fetchMock, 1).url).toBe('/api/auth/refresh');
    expect(sent(fetchMock, 2).headers.Authorization).toBe('Bearer novo');
  });

  it('401 com a renovação recusada: o download falha sem pedir o arquivo de novo', async () => {
    setSession({ accessToken: 'velho', refreshToken: 'refresh-1' });
    const fetchMock = stubFetch(blobReply(401, file), reply(401, { error: 'refresh_invalid' }));

    await expect(api.downloadExport(4)).rejects.toThrow('Erro 401 ao baixar a exportação');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(fetchMock, 1).url).toBe('/api/auth/refresh');
    expect(sent(fetchMock, 1).body).toEqual({ refreshToken: 'refresh-1' });
  });

  it('401 sem refresh token não tenta renovar: o download falha com o erro', async () => {
    setToken('velho');
    const fetchMock = stubFetch(blobReply(401, file));
    await expect(api.downloadModerationCsv(30)).rejects.toThrow('Erro 401 ao exportar a série');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('erros da API', () => {
  it('sem "message" usa o código do erro; sem corpo JSON, o status', async () => {
    stubFetch(reply(409, { error: 'extension_changed' }), {
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('html');
      },
    });
    await expect(api.contracts()).rejects.toThrow('extension_changed');
    await expect(api.contracts()).rejects.toThrow('Erro 500');
  });

  it.each(['account_blocked', 'account_suspended', 'account_banned'])(
    '403 %s com sessão aberta encerra a sessão local e avisa o app',
    async (code) => {
      setSession({ accessToken: 'tok', refreshToken: 'refresh-1' });
      stubFetch(reply(403, { error: code, message: 'Conta bloqueada pela moderação' }));
      const expired = listen(SESSION_EXPIRED_EVENT);

      await expect(api.wallet()).rejects.toThrow('Conta bloqueada pela moderação');

      expect(expired.handler).toHaveBeenCalledTimes(1);
      expect(getToken()).toBeNull();
      expect(getRefreshToken()).toBeNull();
      expired.stop();
    },
  );

  it('403 comum (sem permissão) não derruba a sessão', async () => {
    setSession({ accessToken: 'tok', refreshToken: 'refresh-1' });
    stubFetch(reply(403, { error: 'forbidden', message: 'Sem permissão' }));
    const expired = listen(SESSION_EXPIRED_EVENT);

    await expect(api.adminMetrics()).rejects.toThrow('Sem permissão');

    expect(expired.handler).not.toHaveBeenCalled();
    expect(getToken()).toBe('tok');
    expired.stop();
  });

  it('403 sem código de erro no corpo é só uma recusa: a sessão continua', async () => {
    setSession({ accessToken: 'tok', refreshToken: 'refresh-1' });
    stubFetch(reply(403, { message: 'Proibido' }));
    const expired = listen(SESSION_EXPIRED_EVENT);

    await expect(api.adminMetrics()).rejects.toThrow('Proibido');

    expect(expired.handler).not.toHaveBeenCalled();
    expect(getToken()).toBe('tok');
    expect(getRefreshToken()).toBe('refresh-1');
    expired.stop();
  });

  it('403 de conta bloqueada sem sessão aberta não dispara o aviso de sessão expirada', async () => {
    stubFetch(reply(403, { error: 'account_banned', message: 'Conta banida' }));
    const expired = listen(SESSION_EXPIRED_EVENT);
    await expect(api.login({ email: 'a@b.com', password: 'x' })).rejects.toThrow('Conta banida');
    expect(expired.handler).not.toHaveBeenCalled();
    expired.stop();
  });

  it('503 em manutenção avisa o app para mostrar a tela de manutenção', async () => {
    stubFetch(reply(503, { error: 'maintenance', message: 'Voltamos já' }));
    const maintenance = listen(MAINTENANCE_EVENT);
    await expect(api.categories()).rejects.toThrow('Voltamos já');
    expect(maintenance.handler).toHaveBeenCalledTimes(1);
    maintenance.stop();
  });

  it('503 por outro motivo é só um erro: a tela de manutenção não aparece', async () => {
    stubFetch(reply(503, { error: 'unavailable' }));
    const maintenance = listen(MAINTENANCE_EVENT);
    await expect(api.categories()).rejects.toThrow('unavailable');
    expect(maintenance.handler).not.toHaveBeenCalled();
    maintenance.stop();
  });

  it('401 sem refresh token não tenta renovar nem encerra nada', async () => {
    setToken('tok');
    const fetchMock = stubFetch(reply(401, { message: 'Token inválido' }));
    const expired = listen(SESSION_EXPIRED_EVENT);
    await expect(api.me()).rejects.toThrow('Token inválido');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired.handler).not.toHaveBeenCalled();
    expired.stop();
  });

  it('token renovado e a chamada repetida ainda dá 401: desiste, sem entrar em laço', async () => {
    setSession({ accessToken: 'velho', refreshToken: 'refresh-1' });
    const fetchMock = stubFetch(
      reply(401, { message: 'Token vencido' }),
      reply(200, { accessToken: 'novo', refreshToken: 'refresh-2' }),
      reply(401, { message: 'Sem acesso a este recurso' }),
    );

    await expect(api.wallet()).rejects.toThrow('Sem acesso a este recurso');

    // Chamada, renovação e UMA repetição: nada de renovar de novo.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/wallet',
      '/api/auth/refresh',
      '/api/wallet',
    ]);
    expect(sent(fetchMock, 2).headers.Authorization).toBe('Bearer novo');
  });

  it.each<[string, () => Promise<unknown>, string]>([
    [
      'cadastro',
      () => api.register({ email: 'a@b.com', password: 'segredo-1', legalAccepted: true }),
      '/api/auth/register',
    ],
    ['sair', () => api.logout('refresh-1'), '/api/auth/logout'],
  ])(
    '401 em rota de credencial (%s) é a resposta, não token vencido: não renova nem encerra a sessão',
    async (_what, call, url) => {
      setSession({ accessToken: 'tok', refreshToken: 'refresh-1' });
      const fetchMock = stubFetch(reply(401, { message: 'Não autorizado' }));
      const expired = listen(SESSION_EXPIRED_EVENT);

      await expect(call()).rejects.toThrow('Não autorizado');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sent(fetchMock).url).toBe(url);
      expect(expired.handler).not.toHaveBeenCalled();
      expect(getRefreshToken()).toBe('refresh-1');
      expired.stop();
    },
  );

  it('cada vencimento pede uma renovação nova, já com o refresh token rotacionado', async () => {
    setSession({ accessToken: 'a-1', refreshToken: 'refresh-1' });
    const fetchMock = stubFetch(
      reply(401),
      reply(200, { accessToken: 'a-2', refreshToken: 'refresh-2' }),
      reply(200, { balance: 10 }),
      reply(401),
      reply(200, { accessToken: 'a-3', refreshToken: 'refresh-3' }),
      reply(200, { balance: 20 }),
    );

    await expect(api.wallet()).resolves.toEqual({ balance: 10 });
    await expect(api.wallet()).resolves.toEqual({ balance: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sent(fetchMock, 1).body).toEqual({ refreshToken: 'refresh-1' });
    // A segunda renovação não reaproveita a primeira (já concluída) nem o refresh token usado.
    expect(sent(fetchMock, 4).url).toBe('/api/auth/refresh');
    expect(sent(fetchMock, 4).body).toEqual({ refreshToken: 'refresh-2' });
    expect(sent(fetchMock, 5).headers.Authorization).toBe('Bearer a-3');
    expect(getRefreshToken()).toBe('refresh-3');
  });

  it('renovação que cai por falha de rede encerra a sessão como qualquer renovação recusada', async () => {
    setSession({ accessToken: 'velho', refreshToken: 'refresh-1' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(401, { message: 'Token vencido' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const expired = listen(SESSION_EXPIRED_EVENT);

    await expect(api.me()).rejects.toThrow('Token vencido');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(expired.handler).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
    expired.stop();
  });
});

describe('tokens da sessão', () => {
  it('setToken guarda no navegador e avisa quem escuta (o socket) com o token novo', () => {
    const changed = listen(SESSION_TOKEN_EVENT);

    setToken('tok-9');

    expect(getToken()).toBe('tok-9');
    expect(localStorage.getItem('escambo_token')).toBe('tok-9');
    expect(changed.handler).toHaveBeenCalledTimes(1);
    expect((changed.handler.mock.calls[0]![0] as CustomEvent<string | null>).detail).toBe('tok-9');
    changed.stop();
  });

  it('setSession guarda o par; setSession(null) apaga os dois do navegador', () => {
    setSession({ accessToken: 'a-1', refreshToken: 'r-1' });
    expect(getToken()).toBe('a-1');
    expect(getRefreshToken()).toBe('r-1');
    expect(localStorage.getItem('escambo_token')).toBe('a-1');
    expect(localStorage.getItem('escambo_refresh')).toBe('r-1');

    setSession(null);
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem('escambo_token')).toBeNull();
    expect(localStorage.getItem('escambo_refresh')).toBeNull();
  });

  it('ao carregar o app, a sessão guardada no navegador é retomada', async () => {
    localStorage.setItem('escambo_token', 'guardado');
    localStorage.setItem('escambo_refresh', 'refresh-guardado');
    vi.resetModules();
    const fresh = await import('./api');
    expect(fresh.getToken()).toBe('guardado');
    expect(fresh.getRefreshToken()).toBe('refresh-guardado');
    localStorage.clear();
  });

  it('navegador sem localStorage: o app carrega sem sessão e guarda os tokens na memória', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('armazenamento bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('armazenamento bloqueado');
    });
    vi.resetModules();
    const fresh = await import('./api');

    expect(fresh.getToken()).toBeNull();
    fresh.setSession({ accessToken: 'a-1', refreshToken: 'r-1' });
    expect(fresh.getToken()).toBe('a-1');
    expect(fresh.getRefreshToken()).toBe('r-1');
  });

  it('falha ao avisar a janela não impede a troca do token', () => {
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
      throw new Error('sem window');
    });
    expect(() => setToken('tok-2')).not.toThrow();
    expect(getToken()).toBe('tok-2');
  });
});
