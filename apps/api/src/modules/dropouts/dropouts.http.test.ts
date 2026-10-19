import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { adminRoutes } from '../admin/admin.routes';
import { contractsRoutes } from '../contracts/contracts.routes';
import { profilesRoutes } from '../profiles/profiles.routes';

const { service, audit } = vi.hoisted(() => ({
  service: {
    agree: vi.fn(),
    myDropouts: vi.fn(),
    appeal: vi.fn(),
    listAppealed: vi.fn(),
    listForUser: vi.fn(),
    decide: vi.fn(),
  },
  audit: vi.fn(),
}));
vi.mock('./dropouts.service', () => ({ dropoutsService: service }));
vi.mock('../audit/audit.service', () => ({ auditService: { log: audit } }));
const contracts = routerApp('/api/contracts', contractsRoutes);
const profiles = routerApp('/api/profiles', profilesRoutes);
const admin = routerApp('/api/admin', adminRoutes);
const ULID = '01JA0000000000000000000000';
const CLIENT = bearer(7),
  OWNER = bearer(44),
  ADMIN = bearer(90, 'admin');
const NOTE = 'Nota privada da equipe';
beforeEach(() => {
  vi.clearAllMocks();
  audit.mockResolvedValue(undefined);
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({});
});

describe('rotas protegidas RN-026', () => {
  it.each([
    [contracts, 'post', '/api/contracts/31/dropout/agreed'],
    [profiles, 'get', '/api/profiles/me/dropouts'],
    [profiles, 'post', '/api/profiles/me/dropouts/12/appeal'],
    [admin, 'get', '/api/admin/dropouts'],
    [admin, 'get', `/api/admin/users/${ULID}/dropouts`],
    [admin, 'post', '/api/admin/dropouts/12/excuse'],
  ] as const)('%s %s %s exige autenticação antes do service', async (app, method, url) => {
    const res = await request(app)[method](url).send({ note: NOTE });
    expect(res.status).toBe(401);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
  it('somente admin lê ou decide desistências de outra pessoa', async () => {
    for (const [method, url] of [
      ['get', '/api/admin/dropouts'],
      ['get', `/api/admin/users/${ULID}/dropouts`],
      ['post', '/api/admin/dropouts/12/excuse'],
    ] as const) {
      expect((await request(admin)[method](url).set(OWNER).send({ note: NOTE })).status).toBe(403);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('confirmação e contestação', () => {
  it('confirma em nome do cliente e audita a hora recebida, com origem', async () => {
    service.agree.mockResolvedValue({ agreedAt: '2026-10-09T15:00:00Z', counts: false });
    const res = await request(contracts)
      .post('/api/contracts/31/dropout/agreed')
      .set(CLIENT)
      .set('User-Agent', 'qa-dropouts')
      .send({});
    expect(res.status).toBe(200);
    expect(service.agree).toHaveBeenCalledWith(31, 7);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'dropout_agreed',
        entityId: 31,
        ip: expect.stringContaining('127.0.0.1'),
        userAgent: 'qa-dropouts',
      }),
    );
  });
  it('não aceita trocar titular, dinheiro ou notas na confirmação', async () => {
    for (const body of [
      { uid: 44 },
      { clientAgreedAt: '2026-10-09' },
      { note: NOTE },
      { expectedRefund: 0 },
    ]) {
      expect(
        (await request(contracts).post('/api/contracts/31/dropout/agreed').set(CLIENT).send(body))
          .status,
      ).toBe(422);
    }
    expect(service.agree).not.toHaveBeenCalled();
  });
  it('GET usa titular do token, não da query', async () => {
    await request(profiles).get('/api/profiles/me/dropouts?userId=7').set(OWNER).expect(200);
    expect(service.myDropouts).toHaveBeenCalledWith(44);
  });
  it('trim conserva texto de 20 a 1000 e passa id/titular canônicos', async () => {
    await request(profiles)
      .post('/api/profiles/me/dropouts/12/appeal')
      .set(OWNER)
      .send({ text: ` ${'a'.repeat(20)} ` })
      .expect(200);
    expect(service.appeal).toHaveBeenCalledWith(44, 12, 'a'.repeat(20));
    await request(profiles)
      .post('/api/profiles/me/dropouts/12/appeal')
      .set(OWNER)
      .send({ text: 'a'.repeat(1000) })
      .expect(200);
  });
  it.each([
    { text: 'a'.repeat(19) },
    { text: 'a'.repeat(1001) },
    { text: 'a'.repeat(20), uid: 7 },
    { text: ' '.repeat(20) },
    {},
  ])('corpo inválido não chega ao service: %j', async (body) => {
    await request(profiles)
      .post('/api/profiles/me/dropouts/12/appeal')
      .set(OWNER)
      .send(body)
      .expect(422);
    expect(service.appeal).not.toHaveBeenCalled();
  });
  it('erro de domínio não audita confirmação que não aconteceu', async () => {
    service.agree.mockRejectedValue(new HttpError(409, 'Fechado', 'dropout_agree_closed'));
    const res = await request(contracts).post('/api/contracts/31/dropout/agreed').set(CLIENT);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('dropout_agree_closed');
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('painel da equipe', () => {
  it('fila só aceita status appealed', async () => {
    await request(admin).get('/api/admin/dropouts?status=appealed').set(ADMIN).expect(200);
    expect(service.listAppealed).toHaveBeenCalledOnce();
    await request(admin).get('/api/admin/dropouts?status=decided').set(ADMIN).expect(422);
  });
  it('lista por ulid validado', async () => {
    await request(admin).get(`/api/admin/users/${ULID}/dropouts`).set(ADMIN).expect(200);
    expect(service.listForUser).toHaveBeenCalledWith(ULID);
    await request(admin).get('/api/admin/users/abc/dropouts').set(ADMIN).expect(422);
  });
  it.each(['excuse', 'uphold'])('decisão %s preserva nota privada e IP', async (decision) => {
    await request(admin)
      .post(`/api/admin/dropouts/12/${decision}`)
      .set(ADMIN)
      .send({ note: ` ${NOTE} ` })
      .expect(200);
    expect(service.decide).toHaveBeenCalledWith(
      90,
      12,
      decision,
      NOTE,
      expect.stringContaining('127.0.0.1'),
    );
    expect(audit).not.toHaveBeenCalled();
  });
  it.each([{ note: 'a'.repeat(9) }, { note: 'a'.repeat(501) }, { note: NOTE, uid: 44 }, {}])(
    'nota obrigatória e estrita %j',
    async (body) => {
      await request(admin).post('/api/admin/dropouts/12/excuse').set(ADMIN).send(body).expect(422);
      expect(service.decide).not.toHaveBeenCalled();
    },
  );
  it('ação fora de excuse/uphold é 422', async () => {
    await request(admin)
      .post('/api/admin/dropouts/12/overturn')
      .set(ADMIN)
      .send({ note: NOTE })
      .expect(422);
    expect(service.decide).not.toHaveBeenCalled();
  });
});
