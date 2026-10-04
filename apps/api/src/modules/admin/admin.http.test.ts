import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { adminRoutes } from './admin.routes';

const {
  adminSvc,
  finance,
  withdrawals,
  lgpd,
  mail,
  settings,
  moderation,
  health,
  appeals,
  recordAction,
  audit,
  storageReport,
  runPurge,
} = vi.hoisted(() => ({
  adminSvc: {
    getMetrics: vi.fn(),
    listOpenDisputes: vi.fn(),
    resolveDispute: vi.fn(),
    moderateUser: vi.fn(),
  },
  finance: { report: vi.fn(), exportCsv: vi.fn() },
  withdrawals: { listForAdmin: vi.fn(), process: vi.fn(), complete: vi.fn(), fail: vi.fn() },
  lgpd: {
    listDeletionRequestsForAdmin: vi.fn(),
    completeDeletion: vi.fn(),
    rejectDeletion: vi.fn(),
  },
  mail: { listRecent: vi.fn() },
  settings: { listForAdmin: vi.fn(), update: vi.fn() },
  // Módulos vizinhos que o painel também monta: denúncias, saúde da moderação e contestações.
  moderation: { listQueue: vi.fn(), act: vi.fn() },
  health: { report: vi.fn(), history: vi.fn() },
  appeals: { listForAdmin: vi.fn(), quarantineImage: vi.fn(), decide: vi.fn() },
  recordAction: vi.fn(),
  audit: vi.fn(),
  storageReport: vi.fn(),
  runPurge: vi.fn(),
}));

vi.mock('./admin.service', () => ({ adminService: adminSvc }));
vi.mock('./admin.repository', () => ({ adminRepository: { recordAction } }));
vi.mock('./finance.service', () => ({ financeService: finance }));
vi.mock('../withdrawal/withdrawal.service', () => ({ withdrawalService: withdrawals }));
vi.mock('../lgpd/lgpd.service', () => ({ lgpdService: lgpd }));
// O resto do módulo de e-mail (a lista de avisos que viram e-mail) é lido na carga de outros módulos.
vi.mock('../mail/mail.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail/mail.service')>()),
  mailService: mail,
}));
vi.mock('../settings/settings.service', () => ({ settingsService: settings }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: audit } }));
vi.mock('../messaging/attachments.purge', () => ({ storageReport }));
vi.mock('../../jobs/purge-attachments', () => ({ runPurgeAttachments: runPurge }));
vi.mock('../reports/reports.moderation', () => ({ moderationService: moderation }));
vi.mock('../reports/moderation.health', () => ({ moderationHealthService: health }));
// O mínimo de caracteres da contestação (APPEAL_MIN_CHARS) continua vindo do módulo de verdade.
vi.mock('../reports/appeals.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reports/appeals.service')>()),
  appealsService: appeals,
}));

const app = routerApp('/api/admin', adminRoutes);

type Method = 'get' | 'post' | 'put';
const ADMIN_ID = 10;
const ADMIN = bearer(ADMIN_ID, 'admin');
const UA = 'vitest-admin';
const ULID = '01HZXULIDEXAMPLE0000000000';
const LOCAL_IP = expect.stringMatching(/127\.0\.0\.1$|^::1$/);
/** De onde veio a ação, como vai para a trilha de auditoria. */
const ORIGIN = { ip: LOCAL_IP, userAgent: UA };

const call = (method: Method, url: string) => request(app)[method](`/api/admin${url}`);
/** Chamada já como admin logado, com o navegador identificado. */
const asAdmin = (method: Method, url: string) => call(method, url).set(ADMIN).set('User-Agent', UA);

const everyService = [
  adminSvc,
  finance,
  withdrawals,
  lgpd,
  mail,
  settings,
  moderation,
  health,
  appeals,
  { recordAction, audit, storageReport, runPurge },
];
const expectNothingReached = (): void => {
  for (const svc of everyService) {
    for (const [name, fn] of Object.entries(svc)) {
      expect(fn, `${name} não devia ter sido chamado`).not.toHaveBeenCalled();
    }
  }
};

beforeEach(() => vi.clearAllMocks());

/** Painel admin: borda HTTP. Quem entra, o que a validação recusa, o que chega aos services e o que fica registrado. */
describe('admin: quem pode chamar', () => {
  // Todas as rotas do painel, as do módulo e as que ele monta de denúncias e contestações.
  const routes: [Method, string][] = [
    ['get', '/metrics'],
    ['get', '/storage'],
    ['post', '/storage/purge'],
    ['get', '/settings'],
    ['put', '/settings/barter_enabled'],
    ['get', '/finance'],
    ['get', '/finance/export.csv'],
    ['get', '/moderation/health'],
    ['get', '/moderation/health/export.csv'],
    ['get', '/reports'],
    ['post', '/reports/5/dismiss'],
    ['get', '/appeals'],
    ['get', '/appeals/31/image'],
    ['post', '/appeals/31/uphold'],
    ['get', '/disputes'],
    ['post', '/disputes/4/resolve'],
    ['post', `/users/${ULID}/suspend`],
    ['post', `/users/${ULID}/ban`],
    ['post', `/users/${ULID}/reactivate`],
    ['get', '/withdrawals'],
    ['post', '/withdrawals/8/process'],
    ['post', '/withdrawals/8/complete'],
    ['post', '/withdrawals/8/fail'],
    ['get', '/deletion-requests'],
    ['get', '/emails'],
    ['post', '/deletion-requests/3/complete'],
    ['post', '/deletion-requests/3/reject'],
  ];

  it('nenhuma rota do painel responde sem login (401)', async () => {
    for (const [method, url] of routes) {
      const res = await call(method, url);
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body.error).toBe('missing_token');
    }
    expectNothingReached();
  });

  it('token de admin assinado com outro segredo é 401: o papel só vale em token nosso', async () => {
    const forged = jwt.sign({ sub: 'ulid-10', uid: ADMIN_ID, role: 'admin' }, 'outro-segredo');
    const res = await call('get', '/metrics').set({ Authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
    expectNothingReached();
  });

  it('logado sem ser admin é 403 em todas, inclusive nas de denúncia e contestação, e nada chega aos services', async () => {
    for (const role of ['client', 'freelancer']) {
      for (const [method, url] of routes) {
        const res = await call(method, url)
          .set(bearer(ADMIN_ID, role))
          // Corpo válido de propósito: quem barra é o papel, não a validação.
          .send(method === 'get' ? undefined : { resolution: 'refund_client', value: true });
        expect(res.status, `${role} ${method} ${url}`).toBe(403);
        expect(res.body).toEqual({
          error: 'admin_only',
          message: 'Acesso restrito a administradores',
        });
      }
    }
    expectNothingReached();
  });

  it('o que faz alguém admin é o papel do token: o mesmo usuário entra como admin', async () => {
    adminSvc.getMetrics.mockResolvedValue({ users: 3 });
    await request(app).get('/api/admin/metrics').set(bearer(ADMIN_ID, 'client')).expect(403);
    await request(app).get('/api/admin/metrics').set(bearer(ADMIN_ID, 'admin')).expect(200);
    expect(adminSvc.getMetrics).toHaveBeenCalledTimes(1);
  });

  it('admin suspenso ou banido perde o painel na hora, mesmo com token ainda válido (RN-007)', async () => {
    blocklist.add(ADMIN_ID);
    try {
      // Nem leitura nem escrita: uma conta barrada não consegue reativar a si mesma.
      const attempts: [Method, string][] = [
        ['get', '/metrics'],
        ['post', `/users/${ULID}/reactivate`],
        ['post', '/storage/purge'],
      ];
      for (const [method, url] of attempts) {
        const res = await asAdmin(method, url);
        expect(res.status, `${method} ${url}`).toBe(403);
        expect(res.body.error).toBe('account_blocked');
      }
      expectNothingReached();
    } finally {
      blocklist.delete(ADMIN_ID);
    }

    // Reativada, a mesma conta volta a entrar com o mesmo token.
    adminSvc.getMetrics.mockResolvedValue({ users: 3 });
    await asAdmin('get', '/metrics').expect(200);
  });

  it('rota que o painel não tem é 404 padronizado', async () => {
    const res = await asAdmin('post', `/users/${ULID}/delete`).expect(404);
    expect(res.body.error).toBe('not_found');
    expect(adminSvc.moderateUser).not.toHaveBeenCalled();
  });

  it('a lista conferida acima é a de todas as rotas registradas: rota nova no painel não escapa do 401 e do 403', () => {
    const layers = adminRoutes.stack as {
      route?: { path: string; methods: Record<string, boolean> };
    }[];
    const registered = layers.flatMap((layer) => {
      const route = layer.route;
      return route
        ? Object.keys(route.methods).map((method) => ({ method, path: route.path }))
        : [];
    });

    expect(registered).toHaveLength(routes.length);
    for (const { method, path } of registered) {
      // '/settings/:key' confere com '/settings/barter_enabled'; o ponto de 'export.csv' é literal.
      const pattern = new RegExp(`^${path.replace(/\./g, '\\.').replace(/:[^/]+/g, '[^/]+')}$`);
      const listed = routes.some(([m, url]) => m === method && pattern.test(url));
      expect(listed, `${method} ${path} está no router e fora da lista`).toBe(true);
    }
  });
});

describe('admin: visão geral', () => {
  it('GET /metrics devolve o resumo do service', async () => {
    const metrics = { users: 12, freelancers: 5, platformFees: 150, pendingDeletions: 1 };
    adminSvc.getMetrics.mockResolvedValue(metrics);
    const res = await asAdmin('get', '/metrics').expect(200);
    expect(res.body).toEqual(metrics);
    expect(adminSvc.getMetrics).toHaveBeenCalledTimes(1);
    expect(adminSvc.getMetrics).toHaveBeenCalledWith();
  });

  it('GET /storage devolve o uso do volume e o último expurgo', async () => {
    const report = { attachments: { files: 4, bytes: 2048 }, lastPurge: null };
    storageReport.mockResolvedValue(report);
    const res = await asAdmin('get', '/storage').expect(200);
    expect(res.body).toEqual(report);
    expect(storageReport).toHaveBeenCalledTimes(1);
    expect(runPurge).not.toHaveBeenCalled();
  });

  it('GET /emails lista a caixa de saída: 50 por padrão, de todos; com limite e usuário convertidos', async () => {
    mail.listRecent.mockResolvedValue([{ id: 1, subject: 'Bem-vindo' }]);

    const all = await asAdmin('get', '/emails').expect(200);
    expect(all.body).toEqual([{ id: 1, subject: 'Bem-vindo' }]);
    expect(mail.listRecent).toHaveBeenLastCalledWith(50, null);

    await asAdmin('get', '/emails?limit=200&userId=7').expect(200);
    expect(mail.listRecent).toHaveBeenLastCalledWith(200, 7);
    expect(mail.listRecent).toHaveBeenCalledTimes(2);
  });

  it('GET /emails recusa limite fora de 1 a 200 e usuário que não é id', async () => {
    for (const qs of ['limit=201', 'limit=0', 'limit=2.5']) {
      const res = await asAdmin('get', `/emails?${qs}`).expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty('limit');
    }
    for (const qs of ['userId=abc', 'userId=0', 'userId=-4', 'userId=7.5']) {
      const res = await asAdmin('get', `/emails?${qs}`).expect(422);
      expect(res.body.details).toHaveProperty('userId');
    }
    expect(mail.listRecent).not.toHaveBeenCalled();
  });

  it('falha em qualquer leitura do painel vira erro interno padronizado, sem vazar o detalhe', async () => {
    const reads: [string, ReturnType<typeof vi.fn>][] = [
      ['/metrics', adminSvc.getMetrics],
      ['/storage', storageReport],
      ['/settings', settings.listForAdmin],
      ['/finance', finance.report],
      ['/disputes', adminSvc.listOpenDisputes],
      ['/withdrawals', withdrawals.listForAdmin],
      ['/deletion-requests', lgpd.listDeletionRequestsForAdmin],
      ['/emails', mail.listRecent],
    ];
    for (const [url, read] of reads) {
      read.mockRejectedValueOnce(new Error('ER_ACCESS_DENIED_ERROR: escambo@10.0.0.5'));
      const res = await asAdmin('get', url);
      expect(res.status, url).toBe(500);
      expect(res.body, url).toEqual({
        error: 'internal_error',
        message: 'Erro interno do servidor',
      });
      expect(read, url).toHaveBeenCalledTimes(1);
    }
  });
});

describe('admin: armazenamento (ADR 31)', () => {
  it('POST /storage/purge roda o expurgo agora, à força, e audita o resultado em nome do admin', async () => {
    const result = { retentionDays: 180, purged: 3, orphansRemoved: 1, failed: 0, skipped: null };
    runPurge.mockResolvedValue(result);

    const res = await asAdmin('post', '/storage/purge').expect(200);

    expect(res.body).toEqual(result);
    expect(runPurge).toHaveBeenCalledTimes(1);
    // force: ignora a hora e a trava diária; trigger: fica dito que foi pelo painel.
    expect(runPurge).toHaveBeenCalledWith({ force: true, trigger: 'admin' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'attachments_purged',
      entityType: 'storage',
      newValue: result,
      ...ORIGIN,
    });
  });

  it('expurgo que falha é erro interno sem detalhe e não entra na auditoria', async () => {
    runPurge.mockRejectedValue(new Error('EACCES: /data/attachments'));
    const res = await asAdmin('post', '/storage/purge').expect(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('admin: parâmetros da plataforma (ADR 32)', () => {
  it('GET /settings lista os parâmetros editáveis', async () => {
    const list = [{ key: 'platform_fee_percentage', value: 15 }];
    settings.listForAdmin.mockResolvedValue(list);
    const res = await asAdmin('get', '/settings').expect(200);
    expect(res.body).toEqual(list);
    expect(settings.listForAdmin).toHaveBeenCalledTimes(1);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('PUT /settings/:key grava em nome do admin e audita o valor de antes e o de depois', async () => {
    settings.listForAdmin.mockResolvedValue([
      { key: 'tacit_approval_days', value: 5 },
      { key: 'platform_fee_percentage', value: 15 },
    ]);
    const item = { key: 'platform_fee_percentage', value: 12, updatedBy: ADMIN_ID };
    settings.update.mockResolvedValue(item);

    const res = await asAdmin('put', '/settings/platform_fee_percentage')
      .send({ value: 12 })
      .expect(200);

    expect(res.body).toEqual(item);
    expect(settings.update).toHaveBeenCalledTimes(1);
    expect(settings.update).toHaveBeenCalledWith('platform_fee_percentage', 12, ADMIN_ID);
    // O "antes" é lido antes de gravar: lido depois, a auditoria diria que nada mudou.
    expect(settings.listForAdmin).toHaveBeenCalledTimes(1);
    expect(settings.listForAdmin.mock.invocationCallOrder[0]!).toBeLessThan(
      settings.update.mock.invocationCallOrder[0]!,
    );
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'setting_updated',
      entityType: 'platform_setting',
      // O "antes" é o da chave mudada, não o do primeiro item da lista.
      oldValue: { key: 'platform_fee_percentage', value: 15 },
      newValue: { key: 'platform_fee_percentage', value: 12 },
      ...ORIGIN,
    });
  });

  it('o valor auditado depois é o que o service gravou; liga/desliga vai como booleano; sem valor anterior, o antes é null', async () => {
    settings.listForAdmin.mockResolvedValue([]);
    settings.update.mockResolvedValue({ key: 'maintenance_mode', value: true });

    await asAdmin('put', '/settings/maintenance_mode').send({ value: true }).expect(200);

    expect(settings.update).toHaveBeenCalledWith('maintenance_mode', true, ADMIN_ID);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        oldValue: { key: 'maintenance_mode', value: null },
        newValue: { key: 'maintenance_mode', value: true },
      }),
    );
  });

  it('quando o service grava um valor diferente do enviado, a resposta e a auditoria levam o gravado', async () => {
    settings.listForAdmin.mockResolvedValue([{ key: 'min_service_price', value: 10 }]);
    // O service relê o que ficou no banco: 19,999 enviado, 20 gravado.
    settings.update.mockResolvedValue({ key: 'min_service_price', value: 20 });

    const res = await asAdmin('put', '/settings/min_service_price')
      .send({ value: 19.999 })
      .expect(200);

    expect(res.body).toEqual({ key: 'min_service_price', value: 20 });
    expect(settings.update).toHaveBeenCalledWith('min_service_price', 19.999, ADMIN_ID);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'setting_updated',
      entityType: 'platform_setting',
      oldValue: { key: 'min_service_price', value: 10 },
      newValue: { key: 'min_service_price', value: 20 },
      ...ORIGIN,
    });
  });

  it('chave que não é parâmetro editável, ou valor que não é número nem booleano, é erro de validação', async () => {
    const badKey = await asAdmin('put', '/settings/jwt_secret').send({ value: 1 }).expect(422);
    expect(badKey.body.error).toBe('validation_error');
    expect(badKey.body.details).toHaveProperty('key');

    for (const value of ['12', null, [1]]) {
      const res = await asAdmin('put', '/settings/platform_fee_percentage')
        .send({ value })
        .expect(422);
      expect(res.body.details).toHaveProperty('value');
    }
    const empty = await asAdmin('put', '/settings/platform_fee_percentage').send({}).expect(422);
    expect(empty.body.details).toHaveProperty('value');

    expect(settings.listForAdmin).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('valor fora dos limites: a recusa do service chega com o código dele e nada é auditado', async () => {
    settings.listForAdmin.mockResolvedValue([{ key: 'platform_fee_percentage', value: 15 }]);
    settings.update.mockRejectedValue(
      new HttpError(
        422,
        'Comissão da plataforma: informe um inteiro entre 0 e 50 %',
        'value_out_of_range',
      ),
    );
    const res = await asAdmin('put', '/settings/platform_fee_percentage')
      .send({ value: 80 })
      .expect(422);
    expect(res.body).toEqual({
      error: 'value_out_of_range',
      message: 'Comissão da plataforma: informe um inteiro entre 0 e 50 %',
    });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('admin: financeiro (ADR 26)', () => {
  it('GET /finance sem filtro pede o relatório por mês, com o período a cargo do service', async () => {
    const report = { from: '2026-04-01', to: '2026-09-13', granularity: 'month', series: [] };
    finance.report.mockResolvedValue(report);

    const res = await asAdmin('get', '/finance').expect(200);

    expect(res.body).toEqual(report);
    expect(finance.report).toHaveBeenCalledTimes(1);
    const query = finance.report.mock.calls[0]![0] as Record<string, unknown>;
    expect(query).toEqual({ granularity: 'month' });
    expect(query.from).toBeUndefined();
    expect(query.to).toBeUndefined();
    // Só consulta: relatório na tela não é ação registrada.
    expect(recordAction).not.toHaveBeenCalled();
  });

  it('GET /finance repassa o período e a granularidade pedidos', async () => {
    finance.report.mockResolvedValue({});
    await asAdmin('get', '/finance?from=2026-09-01&to=2026-09-30&granularity=day').expect(200);
    expect(finance.report).toHaveBeenCalledWith({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'day',
    });
  });

  it('período recusado pelo service chega à tela com o código dele (400), não como erro interno', async () => {
    finance.report.mockRejectedValue(
      new HttpError(
        400,
        'Período inválido: a data inicial precisa ser até a final',
        'invalid_range',
      ),
    );
    const res = await asAdmin('get', '/finance?from=2026-09-10&to=2026-09-01').expect(400);
    expect(res.body).toEqual({
      error: 'invalid_range',
      message: 'Período inválido: a data inicial precisa ser até a final',
    });
    expect(finance.report).toHaveBeenCalledWith({
      from: '2026-09-10',
      to: '2026-09-01',
      granularity: 'month',
    });
    expect(finance.exportCsv).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
  });

  it('data fora de AAAA-MM-DD ou granularidade desconhecida é erro de validação, na tela e na exportação', async () => {
    for (const path of ['/finance', '/finance/export.csv']) {
      const from = await asAdmin('get', `${path}?from=01/09/2026`).expect(422);
      expect(from.body.details.from).toEqual(['Data no formato AAAA-MM-DD']);
      const to = await asAdmin('get', `${path}?to=2026-9-1`).expect(422);
      expect(to.body.details).toHaveProperty('to');
      const gran = await asAdmin('get', `${path}?granularity=week`).expect(422);
      expect(gran.body.details).toHaveProperty('granularity');
    }
    expect(finance.report).not.toHaveBeenCalled();
    expect(finance.exportCsv).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
  });

  it('GET /finance/export.csv entrega o CSV como anexo e registra a exportação nas ações do admin', async () => {
    const csv = '﻿id;data_hora_utc\r\n1;2026-09-10T12:00:00.000Z\r\n';
    finance.exportCsv.mockResolvedValue({
      fileName: 'escambo-ledger-2026-09-01_2026-09-30.csv',
      csv,
    });

    const res = await asAdmin('get', '/finance/export.csv?from=2026-09-01&to=2026-09-30').expect(
      200,
    );

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="escambo-ledger-2026-09-01_2026-09-30.csv"',
    );
    expect(res.text).toBe(csv);
    expect(finance.exportCsv).toHaveBeenCalledTimes(1);
    expect(finance.exportCsv).toHaveBeenCalledWith({
      from: '2026-09-01',
      to: '2026-09-30',
      granularity: 'month',
    });
    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'finance_exported',
      'finance',
      null,
      '2026-09-01 → 2026-09-30',
    );
  });

  it('exportação sem período fica registrada como "padrão → hoje"', async () => {
    finance.exportCsv.mockResolvedValue({ fileName: 'escambo-ledger.csv', csv: 'id\r\n' });
    await asAdmin('get', '/finance/export.csv').expect(200);
    expect(recordAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'finance_exported',
      'finance',
      null,
      'padrão → hoje',
    );
  });

  it('exportação só com o início ou só com o fim registra a ponta pedida e o padrão na outra', async () => {
    finance.exportCsv.mockResolvedValue({ fileName: 'escambo-ledger.csv', csv: 'id\r\n' });

    await asAdmin('get', '/finance/export.csv?from=2026-09-01').expect(200);
    expect(finance.exportCsv).toHaveBeenLastCalledWith({
      from: '2026-09-01',
      granularity: 'month',
    });
    expect(recordAction).toHaveBeenLastCalledWith(
      ADMIN_ID,
      'finance_exported',
      'finance',
      null,
      '2026-09-01 → hoje',
    );

    await asAdmin('get', '/finance/export.csv?to=2026-09-30&granularity=day').expect(200);
    expect(finance.exportCsv).toHaveBeenLastCalledWith({ to: '2026-09-30', granularity: 'day' });
    expect(recordAction).toHaveBeenLastCalledWith(
      ADMIN_ID,
      'finance_exported',
      'finance',
      null,
      'padrão → 2026-09-30',
    );
    expect(recordAction).toHaveBeenCalledTimes(2);
  });

  it('exportação que não pôde ser registrada nas ações do admin não entrega o arquivo', async () => {
    finance.exportCsv.mockResolvedValue({ fileName: 'escambo-ledger.csv', csv: 'id\r\n1\r\n' });
    recordAction.mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'));

    const res = await asAdmin('get', '/finance/export.csv?from=2026-09-01&to=2026-09-30').expect(
      500,
    );

    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(recordAction).toHaveBeenCalledTimes(1);
  });

  it('período recusado pelo service não gera arquivo nem registro de exportação', async () => {
    finance.exportCsv.mockRejectedValue(
      new HttpError(400, 'Período máximo de 400 dias', 'range_too_long'),
    );
    const res = await asAdmin('get', '/finance/export.csv?from=2024-01-01&to=2026-09-01').expect(
      400,
    );
    expect(res.body).toEqual({ error: 'range_too_long', message: 'Período máximo de 400 dias' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(recordAction).not.toHaveBeenCalled();
  });
});

describe('admin: disputas (RN-063)', () => {
  it('GET /disputes lista as disputas abertas', async () => {
    adminSvc.listOpenDisputes.mockResolvedValue([{ id: 4, status: 'open' }]);
    const res = await asAdmin('get', '/disputes').expect(200);
    expect(res.body).toEqual([{ id: 4, status: 'open' }]);
    expect(adminSvc.listOpenDisputes).toHaveBeenCalledTimes(1);
  });

  it('POST /disputes/:id/resolve decide em nome do admin logado e audita a decisão', async () => {
    const dispute = { id: 4, status: 'resolved', resolution: 'partial_split' };
    adminSvc.resolveDispute.mockResolvedValue(dispute);

    const res = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'partial_split', refundPercentage: 40, note: 'Entrega parcial' })
      .expect(200);

    expect(res.body).toEqual(dispute);
    expect(adminSvc.resolveDispute).toHaveBeenCalledTimes(1);
    expect(adminSvc.resolveDispute).toHaveBeenCalledWith(ADMIN_ID, 4, {
      resolution: 'partial_split',
      refundPercentage: 40,
      note: 'Entrega parcial',
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'dispute_resolved',
      entityType: 'dispute',
      entityId: 4,
      newValue: { resolution: 'partial_split', refundPercentage: 40 },
      ...ORIGIN,
    });
  });

  it('reembolso total e liberação total dispensam a porcentagem: na auditoria ela vai como null', async () => {
    adminSvc.resolveDispute.mockResolvedValue({ id: 4 });
    for (const resolution of ['refund_client', 'release_freelancer']) {
      vi.clearAllMocks();
      adminSvc.resolveDispute.mockResolvedValue({ id: 4 });
      await asAdmin('post', '/disputes/4/resolve').send({ resolution }).expect(200);
      expect(adminSvc.resolveDispute).toHaveBeenCalledWith(ADMIN_ID, 4, { resolution });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ newValue: { resolution, refundPercentage: null } }),
      );
    }
  });

  it('fora da divisão parcial, a porcentagem pode vir nula (o painel manda o campo vazio)', async () => {
    adminSvc.resolveDispute.mockResolvedValue({ id: 4 });
    await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'refund_client', refundPercentage: null })
      .expect(200);
    expect(adminSvc.resolveDispute).toHaveBeenCalledWith(ADMIN_ID, 4, {
      resolution: 'refund_client',
      refundPercentage: null,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 4,
        newValue: { resolution: 'refund_client', refundPercentage: null },
      }),
    );
  });

  it('divisão parcial exige a porcentagem (1 a 99, inteira)', async () => {
    const missing = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'partial_split' })
      .expect(422);
    expect(missing.body.error).toBe('validation_error');
    expect(missing.body.details.refundPercentage).toEqual([
      'refundPercentage é obrigatório em partial_split',
    ]);
    // null conta como ausente.
    const asNull = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'partial_split', refundPercentage: null })
      .expect(422);
    expect(asNull.body.details).toHaveProperty('refundPercentage');

    for (const refundPercentage of [-1, 101, 33.5, '40']) {
      const res = await asAdmin('post', '/disputes/4/resolve')
        .send({ resolution: 'partial_split', refundPercentage })
        .expect(422);
      expect(res.body.details).toHaveProperty('refundPercentage');
    }
    expect(adminSvc.resolveDispute).not.toHaveBeenCalled();

    // As pontas da divisão são 1% e 99%.
    adminSvc.resolveDispute.mockResolvedValue({ id: 4 });
    for (const refundPercentage of [1, 99]) {
      await asAdmin('post', '/disputes/4/resolve')
        .send({ resolution: 'partial_split', refundPercentage })
        .expect(200);
      expect(adminSvc.resolveDispute).toHaveBeenLastCalledWith(ADMIN_ID, 4, {
        resolution: 'partial_split',
        refundPercentage,
      });
    }
  });

  it('divisão com 0% ou 100% é recusada: tudo para um lado é release_freelancer ou refund_client', async () => {
    // Com 100% a contratação terminaria 'completed' (e no GMV) tendo devolvido tudo ao cliente.
    for (const refundPercentage of [0, 100]) {
      const res = await asAdmin('post', '/disputes/4/resolve')
        .send({ resolution: 'partial_split', refundPercentage })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toEqual({
        refundPercentage: [
          'Em partial_split a porcentagem vai de 1 a 99; para devolver tudo use refund_client, para liberar tudo use release_freelancer',
        ],
      });
    }
    expect(adminSvc.resolveDispute).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    // Fora da divisão a porcentagem que vier junto não é barrada (o service a ignora).
    adminSvc.resolveDispute.mockResolvedValue({ id: 4 });
    await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'refund_client', refundPercentage: 0 })
      .expect(200);
    await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'release_freelancer', refundPercentage: 100 })
      .expect(200);
    expect(adminSvc.resolveDispute).toHaveBeenCalledTimes(2);
  });

  it('decisão desconhecida, nota acima de 1000 caracteres, corpo vazio ou id inválido não chegam ao service', async () => {
    const unknown = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'split_half' })
      .expect(422);
    expect(unknown.body.details).toHaveProperty('resolution');

    const empty = await asAdmin('post', '/disputes/4/resolve').send({}).expect(422);
    expect(empty.body.details).toHaveProperty('resolution');

    const longNote = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'refund_client', note: 'x'.repeat(1001) })
      .expect(422);
    expect(longNote.body.details).toHaveProperty('note');

    for (const id of ['abc', '0', '-2', '1.5']) {
      const res = await asAdmin('post', `/disputes/${id}/resolve`)
        .send({ resolution: 'refund_client' })
        .expect(422);
      expect(res.body.details).toHaveProperty('id');
    }
    expect(adminSvc.resolveDispute).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    adminSvc.resolveDispute.mockResolvedValue({ id: 4 });
    await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'refund_client', note: 'x'.repeat(1000) })
      .expect(200);
    await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'refund_client', note: null })
      .expect(200);
    expect(adminSvc.resolveDispute).toHaveBeenCalledTimes(2);
  });

  it('disputa já resolvida: o 409 do service chega como está e nada é auditado', async () => {
    adminSvc.resolveDispute.mockRejectedValue(
      new HttpError(409, 'Disputa já resolvida', 'already_resolved'),
    );
    const res = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'refund_client' })
      .expect(409);
    expect(res.body).toEqual({ error: 'already_resolved', message: 'Disputa já resolvida' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('divisão que arredonda para um lado só: o 422 split_one_sided do service chega ao painel e nada é auditado', async () => {
    adminSvc.resolveDispute.mockRejectedValue(
      new HttpError(
        422,
        'Com essa porcentagem nada vai ao freelancer e tudo volta ao cliente: use "Devolver ao cliente" (refund_client).',
        'split_one_sided',
      ),
    );
    const res = await asAdmin('post', '/disputes/4/resolve')
      .send({ resolution: 'partial_split', refundPercentage: 95 })
      .expect(422);
    expect(res.body).toEqual({
      error: 'split_one_sided',
      message:
        'Com essa porcentagem nada vai ao freelancer e tudo volta ao cliente: use "Devolver ao cliente" (refund_client).',
    });
    expect(adminSvc.resolveDispute).toHaveBeenCalledWith(ADMIN_ID, 4, {
      resolution: 'partial_split',
      refundPercentage: 95,
    });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('admin: moderação de usuários (RN-007)', () => {
  it('suspender, banir e reativar: cada rota manda a sua ação, em nome do admin, e responde 204 sem corpo', async () => {
    adminSvc.moderateUser.mockResolvedValue(undefined);
    for (const action of ['suspend', 'ban', 'reactivate']) {
      vi.clearAllMocks();
      adminSvc.moderateUser.mockResolvedValue(undefined);

      const res = await asAdmin('post', `/users/${ULID}/${action}`).expect(204);

      expect(res.text).toBe('');
      expect(adminSvc.moderateUser).toHaveBeenCalledTimes(1);
      expect(adminSvc.moderateUser).toHaveBeenCalledWith(ADMIN_ID, ULID, action);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith({
        userId: ADMIN_ID,
        action: `user_${action}`,
        entityType: 'user',
        newValue: { ulid: ULID },
        ...ORIGIN,
      });
    }
  });

  it('sem navegador identificado, a auditoria guarda null no agente, não texto vazio', async () => {
    adminSvc.moderateUser.mockResolvedValue(undefined);
    await request(app)
      .post(`/api/admin/users/${ULID}/ban`)
      .set(ADMIN)
      .unset('User-Agent')
      .expect(204);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_ban', ip: LOCAL_IP, userAgent: null }),
    );
  });

  it('o identificador tem de ser um ULID de 26 caracteres', async () => {
    for (const ulid of [ULID.slice(0, 25), `${ULID}0`, '7']) {
      const res = await asAdmin('post', `/users/${ulid}/ban`).expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.details).toHaveProperty('ulid');
    }
    expect(adminSvc.moderateUser).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('usuário que não existe: 404 do service e nada na auditoria', async () => {
    adminSvc.moderateUser.mockRejectedValue(
      new HttpError(404, 'Usuário não encontrado', 'user_not_found'),
    );
    const res = await asAdmin('post', `/users/${ULID}/suspend`).expect(404);
    expect(res.body).toEqual({ error: 'user_not_found', message: 'Usuário não encontrado' });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('admin: saques (processamento manual)', () => {
  const withdrawal = { id: 8, status: 'processing', amount: 120 };

  it('GET /withdrawals sem filtro traz os abertos; cada filtro conhecido é repassado', async () => {
    withdrawals.listForAdmin.mockResolvedValue([withdrawal]);

    const res = await asAdmin('get', '/withdrawals').expect(200);
    expect(res.body).toEqual([withdrawal]);
    expect(withdrawals.listForAdmin).toHaveBeenLastCalledWith('open');

    for (const status of ['all', 'requested', 'processing', 'completed', 'failed', 'cancelled']) {
      await asAdmin('get', `/withdrawals?status=${status}`).expect(200);
      expect(withdrawals.listForAdmin).toHaveBeenLastCalledWith(status);
    }
  });

  it('filtro de saque desconhecido é erro de validação', async () => {
    const res = await asAdmin('get', '/withdrawals?status=paid').expect(422);
    expect(res.body.details).toHaveProperty('status');
    expect(withdrawals.listForAdmin).not.toHaveBeenCalled();
  });

  it('POST /withdrawals/:id/process assume o pagamento em nome do admin e audita', async () => {
    withdrawals.process.mockResolvedValue(withdrawal);

    const res = await asAdmin('post', '/withdrawals/8/process').expect(200);

    expect(res.body).toEqual(withdrawal);
    expect(withdrawals.process).toHaveBeenCalledTimes(1);
    expect(withdrawals.process).toHaveBeenCalledWith(ADMIN_ID, 8);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'withdrawal_processing',
      entityType: 'withdrawal',
      entityId: 8,
      ...ORIGIN,
    });
    expect(withdrawals.complete).not.toHaveBeenCalled();
    expect(withdrawals.fail).not.toHaveBeenCalled();
  });

  it('POST /withdrawals/:id/complete conclui com o comprovante do gateway, que fica na auditoria', async () => {
    withdrawals.complete.mockResolvedValue({ ...withdrawal, status: 'completed' });

    const res = await asAdmin('post', '/withdrawals/8/complete')
      .send({ gatewayRef: 'PIX-E2E-123' })
      .expect(200);

    expect(res.body).toEqual({ ...withdrawal, status: 'completed' });
    expect(withdrawals.complete).toHaveBeenCalledTimes(1);
    expect(withdrawals.complete).toHaveBeenCalledWith(ADMIN_ID, 8, 'PIX-E2E-123');
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'withdrawal_completed',
      entityType: 'withdrawal',
      entityId: 8,
      newValue: { gatewayRef: 'PIX-E2E-123' },
      ...ORIGIN,
    });
  });

  it('concluir sem comprovante (sem corpo, vazio ou nulo) manda null, não undefined', async () => {
    const bodies: (Record<string, unknown> | undefined)[] = [undefined, {}, { gatewayRef: null }];
    for (const body of bodies) {
      vi.clearAllMocks();
      withdrawals.complete.mockResolvedValue(withdrawal);
      const req = asAdmin('post', '/withdrawals/8/complete');
      await (body === undefined ? req : req.send(body)).expect(200);
      expect(withdrawals.complete).toHaveBeenCalledWith(ADMIN_ID, 8, null);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'withdrawal_completed', newValue: { gatewayRef: null } }),
      );
    }
  });

  it('POST /withdrawals/:id/fail encerra com o motivo, que fica na auditoria; sem motivo vai null', async () => {
    withdrawals.fail.mockResolvedValue({ ...withdrawal, status: 'failed' });

    const res = await asAdmin('post', '/withdrawals/8/fail')
      .send({ reason: 'Chave Pix inválida' })
      .expect(200);
    expect(res.body).toEqual({ ...withdrawal, status: 'failed' });
    expect(withdrawals.fail).toHaveBeenLastCalledWith(ADMIN_ID, 8, 'Chave Pix inválida');
    expect(audit).toHaveBeenLastCalledWith({
      userId: ADMIN_ID,
      action: 'withdrawal_failed',
      entityType: 'withdrawal',
      entityId: 8,
      newValue: { reason: 'Chave Pix inválida' },
      ...ORIGIN,
    });

    await asAdmin('post', '/withdrawals/8/fail').expect(200);
    expect(withdrawals.fail).toHaveBeenLastCalledWith(ADMIN_ID, 8, null);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'withdrawal_failed', newValue: { reason: null } }),
    );
    expect(withdrawals.fail).toHaveBeenCalledTimes(2);
  });

  it('falhar com o corpo vazio ou com o motivo nulo (o painel manda o campo vazio) também vale, e vai null', async () => {
    const bodies: Record<string, unknown>[] = [{}, { reason: null }];
    for (const body of bodies) {
      vi.clearAllMocks();
      withdrawals.fail.mockResolvedValue(withdrawal);
      await asAdmin('post', '/withdrawals/8/fail').send(body).expect(200);
      expect(withdrawals.fail).toHaveBeenCalledTimes(1);
      expect(withdrawals.fail).toHaveBeenCalledWith(ADMIN_ID, 8, null);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'withdrawal_failed', newValue: { reason: null } }),
      );
    }
  });

  it('comprovante acima de 100 e motivo acima de 255 caracteres são recusados; no limite passam', async () => {
    const longRef = await asAdmin('post', '/withdrawals/8/complete')
      .send({ gatewayRef: 'r'.repeat(101) })
      .expect(422);
    expect(longRef.body.details).toHaveProperty('gatewayRef');
    const longReason = await asAdmin('post', '/withdrawals/8/fail')
      .send({ reason: 'm'.repeat(256) })
      .expect(422);
    expect(longReason.body.details).toHaveProperty('reason');
    // Texto ou nada: número não vira comprovante nem motivo.
    const numericRef = await asAdmin('post', '/withdrawals/8/complete')
      .send({ gatewayRef: 123 })
      .expect(422);
    expect(numericRef.body.details).toHaveProperty('gatewayRef');
    const numericReason = await asAdmin('post', '/withdrawals/8/fail')
      .send({ reason: 404 })
      .expect(422);
    expect(numericReason.body.details).toHaveProperty('reason');
    expect(withdrawals.complete).not.toHaveBeenCalled();
    expect(withdrawals.fail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    withdrawals.complete.mockResolvedValue(withdrawal);
    withdrawals.fail.mockResolvedValue(withdrawal);
    await asAdmin('post', '/withdrawals/8/complete')
      .send({ gatewayRef: 'r'.repeat(100) })
      .expect(200);
    await asAdmin('post', '/withdrawals/8/fail')
      .send({ reason: 'm'.repeat(255) })
      .expect(200);
  });

  it('id de saque que não é inteiro positivo é erro de validação nas três ações', async () => {
    for (const action of ['process', 'complete', 'fail']) {
      for (const id of ['abc', '0', '-1', '8.5']) {
        const res = await asAdmin('post', `/withdrawals/${id}/${action}`).expect(422);
        expect(res.body.details).toHaveProperty('id');
      }
    }
    expect(withdrawals.process).not.toHaveBeenCalled();
    expect(withdrawals.complete).not.toHaveBeenCalled();
    expect(withdrawals.fail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('saque já encerrado: o 409 do service chega como está e nada é auditado', async () => {
    const closed = new HttpError(409, 'Saque já encerrado', 'invalid_transition');
    withdrawals.process.mockRejectedValue(closed);
    withdrawals.complete.mockRejectedValue(closed);
    withdrawals.fail.mockRejectedValue(closed);
    for (const action of ['process', 'complete', 'fail']) {
      const res = await asAdmin('post', `/withdrawals/8/${action}`).expect(409);
      expect(res.body).toEqual({ error: 'invalid_transition', message: 'Saque já encerrado' });
    }
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('admin: LGPD, pedidos de exclusão de conta', () => {
  const deletion = { id: 3, status: 'completed' };

  it('GET /deletion-requests sem filtro traz os pendentes; ?status=all, todos', async () => {
    lgpd.listDeletionRequestsForAdmin.mockResolvedValue([{ id: 3 }]);

    const res = await asAdmin('get', '/deletion-requests').expect(200);
    expect(res.body).toEqual([{ id: 3 }]);
    expect(lgpd.listDeletionRequestsForAdmin).toHaveBeenLastCalledWith('pending');

    await asAdmin('get', '/deletion-requests?status=all').expect(200);
    expect(lgpd.listDeletionRequestsForAdmin).toHaveBeenLastCalledWith('all');
    expect(lgpd.listDeletionRequestsForAdmin).toHaveBeenCalledTimes(2);
  });

  it('filtro de pedido desconhecido é erro de validação', async () => {
    const res = await asAdmin('get', '/deletion-requests?status=completed').expect(422);
    expect(res.body.details).toHaveProperty('status');
    expect(lgpd.listDeletionRequestsForAdmin).not.toHaveBeenCalled();
  });

  it('POST /deletion-requests/:id/complete atende o pedido em nome do admin e audita', async () => {
    lgpd.completeDeletion.mockResolvedValue(deletion);

    const res = await asAdmin('post', '/deletion-requests/3/complete').expect(200);

    expect(res.body).toEqual(deletion);
    expect(lgpd.completeDeletion).toHaveBeenCalledTimes(1);
    expect(lgpd.completeDeletion).toHaveBeenCalledWith(ADMIN_ID, 3);
    expect(lgpd.rejectDeletion).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'lgpd_deletion_completed',
      entityType: 'data_deletion_request',
      entityId: 3,
      ...ORIGIN,
    });
  });

  it('POST /deletion-requests/:id/reject recusa com a justificativa, que fica na auditoria', async () => {
    lgpd.rejectDeletion.mockResolvedValue({ id: 3, status: 'rejected' });

    const res = await asAdmin('post', '/deletion-requests/3/reject')
      .send({ note: 'Há contratação em andamento' })
      .expect(200);

    expect(res.body).toEqual({ id: 3, status: 'rejected' });
    expect(lgpd.rejectDeletion).toHaveBeenCalledTimes(1);
    expect(lgpd.rejectDeletion).toHaveBeenCalledWith(ADMIN_ID, 3, 'Há contratação em andamento');
    expect(lgpd.completeDeletion).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'lgpd_deletion_rejected',
      entityType: 'data_deletion_request',
      entityId: 3,
      newValue: { note: 'Há contratação em andamento' },
      ...ORIGIN,
    });
  });

  it('recusar exige justificativa de 3 a 500 caracteres', async () => {
    const noBody = await asAdmin('post', '/deletion-requests/3/reject').expect(422);
    expect(noBody.body.details).toHaveProperty('note');
    for (const note of ['ok', 'x'.repeat(501), null]) {
      const res = await asAdmin('post', '/deletion-requests/3/reject').send({ note }).expect(422);
      expect(res.body.details).toHaveProperty('note');
    }
    expect(lgpd.rejectDeletion).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    lgpd.rejectDeletion.mockResolvedValue({ id: 3 });
    for (const note of ['não', 'x'.repeat(500)]) {
      await asAdmin('post', '/deletion-requests/3/reject').send({ note }).expect(200);
      expect(lgpd.rejectDeletion).toHaveBeenLastCalledWith(ADMIN_ID, 3, note);
    }
  });

  it('id de pedido que não é inteiro positivo é erro de validação', async () => {
    for (const id of ['abc', '0', '-3', '3.5']) {
      const done = await asAdmin('post', `/deletion-requests/${id}/complete`).expect(422);
      expect(done.body.details).toHaveProperty('id');
      const rejected = await asAdmin('post', `/deletion-requests/${id}/reject`)
        .send({ note: 'Justificativa' })
        .expect(422);
      expect(rejected.body.details).toHaveProperty('id');
    }
    expect(lgpd.completeDeletion).not.toHaveBeenCalled();
    expect(lgpd.rejectDeletion).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('pedido com pendências: a recusa do service chega com o código dele e nada é auditado', async () => {
    lgpd.completeDeletion.mockRejectedValue(
      new HttpError(409, 'A conta ainda tem saldo ou contratação ativa', 'deletion_blocked'),
    );
    const res = await asAdmin('post', '/deletion-requests/3/complete').expect(409);
    expect(res.body).toEqual({
      error: 'deletion_blocked',
      message: 'A conta ainda tem saldo ou contratação ativa',
    });
    expect(audit).not.toHaveBeenCalled();
  });
});

/**
 * Rotas de outros módulos que o painel monta (denúncias, saúde da moderação, contestações): aqui
 * só se confere que cada endereço cai no controller certo, atrás do mesmo login de admin. As
 * regras de cada um ficam nos testes do módulo de denúncias.
 */
describe('admin: rotas montadas de denúncias e contestações', () => {
  it('GET /reports cai na fila de moderação (ADR 39): pendentes por padrão, resolvidas a pedido', async () => {
    moderation.listQueue.mockResolvedValue([{ key: 'avatar:9' }]);
    const res = await asAdmin('get', '/reports').expect(200);
    expect(res.body).toEqual([{ key: 'avatar:9' }]);
    expect(moderation.listQueue).toHaveBeenLastCalledWith('pending');

    await asAdmin('get', '/reports?status=resolved').expect(200);
    expect(moderation.listQueue).toHaveBeenLastCalledWith('resolved');
    expect(appeals.listForAdmin).not.toHaveBeenCalled();
  });

  it('POST /reports/:id/:action decide a denúncia em nome do admin logado e registra nas ações do admin', async () => {
    moderation.act.mockResolvedValue({
      result: { resolved: 2 },
      target: { type: 'avatar', id: 9, imageUrl: null },
    });

    const res = await asAdmin('post', '/reports/5/dismiss')
      .send({ note: 'Sem violação' })
      .expect(200);

    expect(res.body).toEqual({ resolved: 2 });
    expect(moderation.act).toHaveBeenCalledTimes(1);
    expect(moderation.act).toHaveBeenCalledWith(ADMIN_ID, 5, 'dismiss', 'Sem violação');
    expect(recordAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'reports_dismissed',
      'avatar',
      9,
      'Sem violação',
    );
    expect(appeals.decide).not.toHaveBeenCalled();
  });

  it('ação de denúncia desconhecida é erro de validação', async () => {
    const res = await asAdmin('post', '/reports/5/delete').expect(422);
    expect(res.body.details).toHaveProperty('action');
    expect(moderation.act).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
  });

  it('GET /moderation/health cai no painel de saúde, com 30 dias por padrão (ADR 47)', async () => {
    health.report.mockResolvedValue({ queue: { open: 2 } });
    const res = await asAdmin('get', '/moderation/health').expect(200);
    expect(res.body).toEqual({ queue: { open: 2 } });
    expect(health.report).toHaveBeenLastCalledWith(30);

    await asAdmin('get', '/moderation/health?days=7').expect(200);
    expect(health.report).toHaveBeenLastCalledWith(7);
    expect(health.history).not.toHaveBeenCalled();
  });

  it('GET /moderation/health/export.csv cai na exportação da série, não no painel (ADR 55)', async () => {
    health.history.mockResolvedValue({
      history: [
        { day: '2026-09-18', received: 1, flagged: 0, actioned: 1, dismissed: 0, medianHours: 2 },
      ],
      slaHours: 24,
    });

    const res = await asAdmin('get', '/moderation/health/export.csv?days=7').expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="escambo-moderacao-2026-09-18_2026-09-18.csv"',
    );
    expect(health.history).toHaveBeenCalledWith(7);
    expect(health.report).not.toHaveBeenCalled();
    expect(recordAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'moderation_health_exported',
      'moderation',
      null,
      '7 dias · 2026-09-18 → 2026-09-18',
    );
  });

  it('GET /appeals cai nas contestações (ADR 41), pendentes por padrão', async () => {
    appeals.listForAdmin.mockResolvedValue([{ id: 31 }]);
    const res = await asAdmin('get', '/appeals').expect(200);
    expect(res.body).toEqual([{ id: 31 }]);
    expect(appeals.listForAdmin).toHaveBeenCalledWith('pending');
    expect(moderation.listQueue).not.toHaveBeenCalled();
  });

  it('GET /appeals/:id/image cai na imagem em quarentena da remoção pedida, não na decisão', async () => {
    appeals.quarantineImage.mockRejectedValue(
      new HttpError(404, 'Remoção não encontrada', 'removal_not_found'),
    );

    const res = await asAdmin('get', '/appeals/31/image').expect(404);

    expect(res.body).toEqual({ error: 'removal_not_found', message: 'Remoção não encontrada' });
    expect(appeals.quarantineImage).toHaveBeenCalledTimes(1);
    expect(appeals.quarantineImage).toHaveBeenCalledWith(31);
    expect(appeals.decide).not.toHaveBeenCalled();
    expect(appeals.listForAdmin).not.toHaveBeenCalled();
  });

  it('POST /appeals/:id/:decision decide a contestação em nome do admin logado', async () => {
    appeals.decide.mockResolvedValue({ status: 'overturned' });

    const res = await asAdmin('post', '/appeals/31/overturn').expect(200);

    expect(res.body).toEqual({ status: 'overturned' });
    expect(appeals.decide).toHaveBeenCalledTimes(1);
    expect(appeals.decide).toHaveBeenCalledWith(ADMIN_ID, 31, 'overturn', null);
    expect(recordAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'appeal_overturned',
      'image_removal',
      31,
      null,
    );
    expect(moderation.act).not.toHaveBeenCalled();
  });
});
