import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { profilesRoutes } from './profiles.routes';

const { profiles, cpf, limiter } = vi.hoisted(() => ({
  profiles: { upsertCompany: vi.fn(), getPublicCompany: vi.fn() },
  cpf: { status: vi.fn(), verify: vi.fn() },
  limiter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('./profiles.service', () => ({ profilesService: profiles }));
vi.mock('./cpf.service', () => ({ cpfService: cpf }));
vi.mock('../../middlewares/rate-limit', () => ({ loginRateLimiter: limiter }));

const app = routerApp('/api/profiles', profilesRoutes);

const ULID = '01J8ZQ4M7N2K5X9RWTV3BHC6DE';
const AGENT = 'vitest-agent/1.0';
const CTX = { ip: expect.stringMatching(/127\.0\.0\.1$/), userAgent: AGENT };

/** Documentos (RF-018, RF-020): a borda HTTP do CPF do freelancer e da conta de empresa. */
describe('documentos: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['get', '/api/profiles/me/cpf'],
    ['put', '/api/profiles/me/cpf'],
    ['put', '/api/profiles/company'],
  ] as const)('%s %s exige login', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    for (const fn of [...Object.values(profiles), ...Object.values(cpf)]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  describe('CPF do freelancer (RF-020)', () => {
    it('GET /me/cpf devolve a situação de quem está logado', async () => {
      const status = { available: true, verified: false };
      cpf.status.mockResolvedValue(status);

      const res = await request(app).get('/api/profiles/me/cpf').set(bearer(7)).expect(200);

      expect(res.body).toEqual(status);
      expect(cpf.status).toHaveBeenCalledWith(7);
    });

    it('PUT /me/cpf: CPF com máscara chega só com os dígitos, com a data e o IP de quem pediu, e passa pelo limite do login', async () => {
      cpf.verify.mockResolvedValue({ verified: true });

      await request(app)
        .put('/api/profiles/me/cpf')
        .set(bearer(7))
        .set('User-Agent', AGENT)
        .send({ cpf: '529.982.247-25', birthDate: '1990-05-17' })
        .expect(200);

      expect(cpf.verify).toHaveBeenCalledWith(
        7,
        { cpf: '52998224725', birthDate: '1990-05-17' },
        CTX,
      );
      expect(limiter).toHaveBeenCalledTimes(1);
    });

    it('CPF com dígito errado, todos iguais ou com letra: 422 com a mensagem do CPF', async () => {
      for (const value of ['529.982.247-24', '111.111.111-11', '5299822472a', '']) {
        const res = await request(app)
          .put('/api/profiles/me/cpf')
          .set(bearer(7))
          .send({ cpf: value, birthDate: '1990-05-17' })
          .expect(422);
        expect(res.body.details.cpf).toEqual(['CPF inválido: confira os 11 dígitos']);
      }
      expect(cpf.verify).not.toHaveBeenCalled();
    });

    it('data que não existe, fora do formato ou antes de 1900: 422', async () => {
      for (const birthDate of ['1990-02-30', '17/05/1990', '1899-12-31', undefined]) {
        const res = await request(app)
          .put('/api/profiles/me/cpf')
          .set(bearer(7))
          .send({ cpf: '52998224725', birthDate })
          .expect(422);
        expect(res.body.details).toHaveProperty('birthDate');
      }
      expect(cpf.verify).not.toHaveBeenCalled();
    });

    it('o CPF nunca volta na mensagem de erro de validação', async () => {
      const res = await request(app)
        .put('/api/profiles/me/cpf')
        .set(bearer(7))
        .send({ cpf: '529.982.247-24', birthDate: '1990-05-17' })
        .expect(422);
      expect(JSON.stringify(res.body)).not.toContain('529.982.247-24');
    });
  });

  describe('empresa (RF-018)', () => {
    const body = {
      legalName: 'Padaria Pão Bom Ltda',
      tradeName: 'Pão Bom',
      cnpj: '12.ABC.345/01DE-35',
      logoUrl: `/api/media/2026/10/${ULID}.webp`,
      bio: 'Pães de fermentação natural.',
      website: 'https://paobom.com.br',
      city: 'Joinville',
      state: 'SC',
    };

    it('PUT /company: o CNPJ chega normalizado, o site com a barra, e o papel atual vai junto', async () => {
      profiles.upsertCompany.mockResolvedValue({ tradeName: 'Pão Bom' });

      await request(app)
        .put('/api/profiles/company')
        .set(bearer(7, 'company'))
        .set('User-Agent', AGENT)
        .send(body)
        .expect(200);

      expect(profiles.upsertCompany).toHaveBeenCalledWith(
        7,
        'company',
        { ...body, cnpj: '12ABC34501DE35', website: 'https://paobom.com.br/' },
        CTX,
      );
    });

    it('site vazio vira null; site sem http(s) ou malformado é recusado', async () => {
      profiles.upsertCompany.mockResolvedValue({});
      await request(app)
        .put('/api/profiles/company')
        .set(bearer(7, 'company'))
        .send({ ...body, website: '' })
        .expect(200);
      expect(profiles.upsertCompany.mock.lastCall![2].website).toBeNull();

      for (const website of ['paobom.com.br', 'javascript:alert(1)', 'ftp://paobom.com.br']) {
        const res = await request(app)
          .put('/api/profiles/company')
          .set(bearer(7, 'company'))
          .send({ ...body, website })
          .expect(422);
        expect(res.body.details.website).toEqual([
          'Site inválido: use o endereço completo, como https://suaempresa.com.br',
        ]);
      }
    });

    it('descrição curta com mais de 280 caracteres, logo fora da plataforma ou CNPJ inválido: 422', async () => {
      const res = await request(app)
        .put('/api/profiles/company')
        .set(bearer(7, 'company'))
        .send({ ...body, bio: 'x'.repeat(281), logoUrl: 'nao-e-url', cnpj: '12ABC34501DE36' })
        .expect(422);
      expect(res.body.details.bio).toEqual(['A descrição curta tem no máximo 280 caracteres']);
      expect(res.body.details).toHaveProperty('logoUrl');
      expect(res.body.details.cnpj[0]).toMatch(/^CNPJ inválido/);
      expect(profiles.upsertCompany).not.toHaveBeenCalled();
    });

    it('GET /company/:ulid é pública e procura pelo ulid da URL; ulid fora do formato é 422', async () => {
      profiles.getPublicCompany.mockResolvedValue({ userUlid: ULID, tradeName: 'Pão Bom' });

      const res = await request(app).get(`/api/profiles/company/${ULID}`).expect(200);

      expect(res.body).toEqual({ userUlid: ULID, tradeName: 'Pão Bom' });
      expect(profiles.getPublicCompany).toHaveBeenCalledWith(ULID);
      await request(app).get('/api/profiles/company/123').expect(422);
    });
  });
});
