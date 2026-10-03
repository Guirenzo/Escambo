import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { profilesRoutes } from './profiles.routes';

const { service } = vi.hoisted(() => ({
  service: {
    getMine: vi.fn(),
    upsertFreelancer: vi.fn(),
    upsertClient: vi.fn(),
    listMyPortfolio: vi.fn(),
    addPortfolioItem: vi.fn(),
    updatePortfolioItem: vi.fn(),
    removePortfolioItem: vi.fn(),
    reorderPortfolio: vi.fn(),
    getPublicFreelancer: vi.fn(),
  },
}));
vi.mock('./profiles.service', () => ({ profilesService: service }));

const app = routerApp('/api/profiles', profilesRoutes);

const ULID = '01J8ZQ4M7N2K5X9RWTV3BHC6DE';
/** Imagem enviada pela plataforma (ADR 36): /api/media/AAAA/MM/<ULID>.<ext>. */
const MEDIA = `/api/media/2026/09/${ULID}.png`;
const LINK = 'https://exemplo.test/trabalho';
/** Link externo no tamanho máximo (512 caracteres) e um caractere além dele. */
const MAX_LINK = `https://exemplo.test/${'a'.repeat(512 - 'https://exemplo.test/'.length)}`;
const LONG_LINK = `${MAX_LINK}a`;

/** Rotas e controllers dos perfis: quem pode chamar, o que a validação recusa, o que chega ao service. */
describe('perfis: borda HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('rotas protegidas', () => {
    const routes: Array<['get' | 'put' | 'post' | 'delete', string]> = [
      ['get', '/api/profiles/me'],
      ['put', '/api/profiles/freelancer'],
      ['put', '/api/profiles/client'],
      ['get', '/api/profiles/portfolio'],
      ['post', '/api/profiles/portfolio'],
      ['put', '/api/profiles/portfolio/order'],
      ['put', '/api/profiles/portfolio/5'],
      ['delete', '/api/profiles/portfolio/5'],
    ];

    it.each(routes)('%s %s exige login', async (method, path) => {
      const res = await request(app)[method](path).send({ fullName: 'Bruno Costa' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing_token');
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it('token que não foi assinado pela API é recusado', async () => {
      const res = await request(app)
        .get('/api/profiles/me')
        .set({ Authorization: 'Bearer nao.e.um-jwt' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      expect(service.getMine).not.toHaveBeenCalled();
    });

    describe('conta suspensa ou banida (RN-007)', () => {
      afterEach(() => blocklist.delete(7));

      it.each(routes)(
        '%s %s barra a conta bloqueada mesmo com token válido',
        async (method, path) => {
          blocklist.add(7);
          const agent = request(app);
          const res = await agent[method](path).set(bearer(7)).send({ fullName: 'Bruno Costa' });
          expect(res.status).toBe(403);
          expect(res.body.error).toBe('account_blocked');
          for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
        },
      );

      it('o bloqueio é da conta, não de todo mundo: outra pessoa logada continua passando', async () => {
        blocklist.add(7);
        service.getMine.mockResolvedValue({ freelancer: null, client: null });
        await request(app).get('/api/profiles/me').set(bearer(8)).expect(200);
        expect(service.getMine).toHaveBeenCalledWith(8);
      });

      it('o perfil público não depende de quem pede: segue aberto, sem token', async () => {
        blocklist.add(7);
        service.getPublicFreelancer.mockResolvedValue({ userUlid: ULID });
        await request(app).get(`/api/profiles/freelancer/${ULID}`).expect(200);
        expect(service.getPublicFreelancer).toHaveBeenCalledWith(ULID);
      });
    });
  });

  describe('GET /api/profiles/freelancer/:ulid (pública)', () => {
    it('mostra o perfil sem login, procurando pelo ulid da URL', async () => {
      const profile = { userUlid: ULID, fullName: 'Bruno Costa', level: 3, portfolio: [] };
      service.getPublicFreelancer.mockResolvedValue(profile);

      const res = await request(app).get(`/api/profiles/freelancer/${ULID}`).expect(200);

      expect(res.body).toEqual(profile);
      expect(service.getPublicFreelancer).toHaveBeenCalledWith(ULID);
    });

    it('ulid que não tem 26 caracteres é erro de validação e não chega ao service', async () => {
      for (const ulid of ['123', `${ULID}X`]) {
        const res = await request(app).get(`/api/profiles/freelancer/${ulid}`).expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(res.body.details).toHaveProperty('ulid');
      }
      expect(service.getPublicFreelancer).not.toHaveBeenCalled();
    });

    it('perfil que não existe é 404 com o código do service', async () => {
      service.getPublicFreelancer.mockRejectedValue(
        new HttpError(404, 'Perfil não encontrado', 'profile_not_found'),
      );
      const res = await request(app).get(`/api/profiles/freelancer/${ULID}`).expect(404);
      expect(res.body).toEqual({ error: 'profile_not_found', message: 'Perfil não encontrado' });
    });
  });

  describe('GET /api/profiles/me', () => {
    it('devolve os perfis de quem está logado', async () => {
      const mine = { freelancer: null, client: { fullName: 'Ana' } };
      service.getMine.mockResolvedValue(mine);

      const res = await request(app).get('/api/profiles/me').set(bearer(7)).expect(200);

      expect(res.body).toEqual(mine);
      expect(service.getMine).toHaveBeenCalledWith(7);
    });
  });

  describe('PUT /api/profiles/freelancer', () => {
    const body = {
      fullName: 'Bruno Costa',
      avatarUrl: MEDIA,
      bio: 'Desenvolvedor',
      headline: 'Dev Full Stack',
      city: 'Joinville',
      state: 'SC',
      latitude: -26.3,
      longitude: -48.84,
      isAvailable: false,
      availableDays: [1, 3],
      availablePeriods: { '1': ['morning', 'evening'] },
    };

    it('grava o perfil de quem está logado, só com os campos que a pessoa pode definir', async () => {
      service.upsertFreelancer.mockResolvedValue({ fullName: 'Bruno Costa', avgRating: 4.5 });

      const res = await request(app)
        .put('/api/profiles/freelancer')
        .set(bearer(7))
        // Nota, contadores e dono não são da pessoa: a validação descarta o que não é do perfil.
        .send({ ...body, avgRating: 5, totalReviews: 99, userId: 1 })
        .expect(200);

      expect(res.body).toEqual({ fullName: 'Bruno Costa', avgRating: 4.5 });
      expect(service.upsertFreelancer).toHaveBeenCalledTimes(1);
      expect(service.upsertFreelancer).toHaveBeenCalledWith(7, body);
    });

    it('só o nome é obrigatório; o que pode ficar em branco aceita null', async () => {
      service.upsertFreelancer.mockResolvedValue({});
      const minimal = { fullName: 'Bruno', avatarUrl: null, availableDays: null, state: null };

      await request(app).put('/api/profiles/freelancer').set(bearer(7)).send(minimal).expect(200);

      expect(service.upsertFreelancer).toHaveBeenCalledWith(7, minimal);
    });

    it.each([
      ['fullName', { fullName: 'B' }],
      ['fullName', { fullName: undefined }],
      ['fullName', { fullName: 'x'.repeat(151) }],
      ['bio', { bio: 'x'.repeat(2001) }],
      ['headline', { headline: 'x'.repeat(256) }],
      ['city', { city: 'x'.repeat(101) }],
      ['state', { state: 'SCX' }],
      ['state', { state: 'S' }],
      ['latitude', { latitude: 90.1 }],
      ['latitude', { latitude: -90.1 }],
      // Coordenada é número: texto não é convertido.
      ['latitude', { latitude: '-26.3' }],
      ['longitude', { longitude: -180.1 }],
      ['longitude', { longitude: 180.1 }],
      ['isAvailable', { isAvailable: 'sim' }],
      // Dias da semana vão de 0 (domingo) a 6 (sábado), inteiros, e a semana tem 7.
      ['availableDays', { availableDays: [7] }],
      ['availableDays', { availableDays: [-1] }],
      ['availableDays', { availableDays: [1.5] }],
      ['availableDays', { availableDays: [0, 1, 2, 3, 4, 5, 6, 0] }],
      // Período só de dia que existe e só manhã, tarde ou noite (ADR 34).
      ['availablePeriods', { availablePeriods: { '7': ['morning'] } }],
      ['availablePeriods', { availablePeriods: { '1': ['madrugada'] } }],
      [
        'availablePeriods',
        { availablePeriods: { '1': ['morning', 'afternoon', 'evening', 'morning'] } },
      ],
      // Foto: link completo ou imagem enviada pela plataforma; caminho solto não passa (ADR 36).
      ['avatarUrl', { avatarUrl: 'foto.png' }],
      ['avatarUrl', { avatarUrl: `/api/media/2026/13/${ULID}.png` }],
      ['avatarUrl', { avatarUrl: `/api/media/2026/09/../${ULID}.png` }],
    ])('recusa %s inválido na validação: %j', async (field, patch) => {
      const res = await request(app)
        .put('/api/profiles/freelancer')
        .set(bearer(7))
        .send({ ...body, ...patch })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details)).toEqual([field]);
      expect(service.upsertFreelancer).not.toHaveBeenCalled();
    });

    it('link de foto com mais de 512 caracteres é recusado (o de 512 passa, no teste dos limites)', async () => {
      const res = await request(app)
        .put('/api/profiles/freelancer')
        .set(bearer(7))
        .send({ ...body, avatarUrl: LONG_LINK })
        .expect(422);
      expect(res.body.error).toBe('validation_error');
      expect(Object.keys(res.body.details)).toEqual(['avatarUrl']);
      expect(service.upsertFreelancer).not.toHaveBeenCalled();
    });

    it('os limites exatos de cada campo ainda passam, e chegam ao service como vieram', async () => {
      service.upsertFreelancer.mockResolvedValue({});
      const atLimit = {
        fullName: 'x'.repeat(150),
        avatarUrl: MAX_LINK,
        bio: 'x'.repeat(2000),
        headline: 'x'.repeat(255),
        city: 'x'.repeat(100),
        state: 'SC',
        latitude: -90,
        longitude: 180,
        availableDays: [0, 1, 2, 3, 4, 5, 6],
        availablePeriods: { '0': [], '6': ['morning', 'afternoon', 'evening'] },
      };
      const shortest = { fullName: 'Bo', latitude: 90, longitude: -180, availableDays: [] };

      await request(app).put('/api/profiles/freelancer').set(bearer(7)).send(atLimit).expect(200);
      await request(app).put('/api/profiles/freelancer').set(bearer(7)).send(shortest).expect(200);

      expect(service.upsertFreelancer).toHaveBeenNthCalledWith(1, 7, atLimit);
      expect(service.upsertFreelancer).toHaveBeenNthCalledWith(2, 7, shortest);
    });

    it('se o service falha por um motivo inesperado, responde 500 em JSON sem expor o erro (RNF-039)', async () => {
      service.upsertFreelancer.mockRejectedValue(new Error("Table 'profiles_freelancer' is gone"));
      const res = await request(app)
        .put('/api/profiles/freelancer')
        .set(bearer(7))
        .send(body)
        .expect(500);
      expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno do servidor' });
    });
  });

  describe('PUT /api/profiles/client', () => {
    it('grava o perfil de cliente de quem está logado, sem campos de freelancer', async () => {
      service.upsertClient.mockResolvedValue({ fullName: 'Ana Souza', city: 'Joinville' });
      const body = {
        fullName: 'Ana Souza',
        avatarUrl: 'https://img.exemplo.test/ana.png',
        bio: null,
        city: 'Joinville',
        state: 'SC',
      };

      const res = await request(app)
        .put('/api/profiles/client')
        .set(bearer(8))
        .send({ ...body, headline: 'não é de cliente', isAvailable: true })
        .expect(200);

      expect(res.body).toEqual({ fullName: 'Ana Souza', city: 'Joinville' });
      expect(service.upsertClient).toHaveBeenCalledWith(8, body);
      expect(service.upsertFreelancer).not.toHaveBeenCalled();
    });

    it('nome curto, UF fora de 2 letras e foto que não é link são recusados', async () => {
      for (const [field, patch] of [
        ['fullName', { fullName: 'A' }],
        ['state', { fullName: 'Ana Souza', state: 'S' }],
        ['avatarUrl', { fullName: 'Ana Souza', avatarUrl: 'ana.png' }],
        ['bio', { fullName: 'Ana Souza', bio: 'x'.repeat(2001) }],
        ['city', { fullName: 'Ana Souza', city: 'x'.repeat(101) }],
        ['fullName', { fullName: 'x'.repeat(151) }],
        ['fullName', { city: 'Joinville' }],
      ] as const) {
        const res = await request(app)
          .put('/api/profiles/client')
          .set(bearer(8))
          .send(patch)
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual([field]);
      }
      expect(service.upsertClient).not.toHaveBeenCalled();
    });

    it('só o nome é obrigatório, e os limites exatos de cada campo ainda passam', async () => {
      service.upsertClient.mockResolvedValue({});
      const atLimit = {
        fullName: 'x'.repeat(150),
        avatarUrl: MEDIA,
        bio: 'x'.repeat(2000),
        city: 'x'.repeat(100),
        state: 'SC',
      };

      await request(app)
        .put('/api/profiles/client')
        .set(bearer(8))
        .send({ fullName: 'An' })
        .expect(200);
      await request(app).put('/api/profiles/client').set(bearer(8)).send(atLimit).expect(200);

      expect(service.upsertClient).toHaveBeenNthCalledWith(1, 8, { fullName: 'An' });
      expect(service.upsertClient).toHaveBeenNthCalledWith(2, 8, atLimit);
    });
  });

  describe('GET /api/profiles/portfolio', () => {
    it('lista o portfólio de quem está logado', async () => {
      const items = [{ id: 1, title: 'Site da padaria', sortOrder: 1 }];
      service.listMyPortfolio.mockResolvedValue(items);

      const res = await request(app).get('/api/profiles/portfolio').set(bearer(7)).expect(200);

      expect(res.body).toEqual(items);
      expect(service.listMyPortfolio).toHaveBeenCalledWith(7);
    });

    it('portfólio vazio é 200 com lista vazia, não 404', async () => {
      service.listMyPortfolio.mockResolvedValue([]);
      const res = await request(app).get('/api/profiles/portfolio').set(bearer(9)).expect(200);
      expect(res.body).toEqual([]);
      expect(service.listMyPortfolio).toHaveBeenCalledWith(9);
    });
  });

  describe('POST /api/profiles/portfolio', () => {
    it('cria o trabalho no portfólio de quem está logado, com o título sem espaços nas pontas', async () => {
      const items = [{ id: 10, title: 'Site da padaria' }];
      service.addPortfolioItem.mockResolvedValue(items);

      const res = await request(app)
        .post('/api/profiles/portfolio')
        .set(bearer(7))
        .send({ title: '  Site da padaria  ', description: 'Loja virtual', imageUrl: MEDIA })
        .expect(201);

      expect(res.body).toEqual(items);
      expect(service.addPortfolioItem).toHaveBeenCalledWith(7, {
        title: 'Site da padaria',
        description: 'Loja virtual',
        imageUrl: MEDIA,
      });
    });

    it('aceita o trabalho só com o link externo', async () => {
      service.addPortfolioItem.mockResolvedValue([]);
      await request(app)
        .post('/api/profiles/portfolio')
        .set(bearer(7))
        .send({ title: 'App de delivery', imageUrl: null, externalUrl: LINK })
        .expect(201);
      expect(service.addPortfolioItem).toHaveBeenCalledWith(7, {
        title: 'App de delivery',
        imageUrl: null,
        externalUrl: LINK,
      });
    });

    it('sem imagem nem link o trabalho é recusado, com a mensagem no campo da imagem', async () => {
      for (const extra of [{}, { imageUrl: null, externalUrl: null }]) {
        const res = await request(app)
          .post('/api/profiles/portfolio')
          .set(bearer(7))
          .send({ title: 'Site da padaria', ...extra })
          .expect(422);
        expect(res.body.details).toEqual({ imageUrl: ['Informe a imagem ou o link do trabalho'] });
      }
      expect(service.addPortfolioItem).not.toHaveBeenCalled();
    });

    it('título com menos de 3 letras (contadas sem os espaços), descrição longa e link inválido são recusados', async () => {
      const valid = { title: 'Site da padaria', externalUrl: LINK };
      for (const [field, patch] of [
        ['title', { title: '  ab  ' }],
        ['title', { title: 'x'.repeat(151) }],
        ['description', { description: 'x'.repeat(1001) }],
        ['externalUrl', { externalUrl: 'exemplo.test/trabalho' }],
        ['externalUrl', { externalUrl: LONG_LINK }],
        ['imageUrl', { imageUrl: '/uploads/foto.png' }],
        ['imageUrl', { imageUrl: LONG_LINK }],
      ] as const) {
        const res = await request(app)
          .post('/api/profiles/portfolio')
          .set(bearer(7))
          .send({ ...valid, ...patch })
          .expect(422);
        expect(Object.keys(res.body.details)).toEqual([field]);
      }
      expect(service.addPortfolioItem).not.toHaveBeenCalled();
    });

    it('título de 3 e de 150 letras, descrição de 1000 e link de 512 ainda passam', async () => {
      service.addPortfolioItem.mockResolvedValue([]);
      const shortest = { title: 'App', externalUrl: MAX_LINK };
      const longest = { title: 'x'.repeat(150), description: 'x'.repeat(1000), imageUrl: MEDIA };

      await request(app).post('/api/profiles/portfolio').set(bearer(7)).send(shortest).expect(201);
      await request(app).post('/api/profiles/portfolio').set(bearer(7)).send(longest).expect(201);

      expect(service.addPortfolioItem).toHaveBeenNthCalledWith(1, 7, shortest);
      expect(service.addPortfolioItem).toHaveBeenNthCalledWith(2, 7, longest);
    });

    it('quem ainda não tem perfil de freelancer: o 409 do service chega com o código dele', async () => {
      service.addPortfolioItem.mockRejectedValue(
        new HttpError(
          409,
          'Crie seu perfil de freelancer antes do portfólio',
          'no_freelancer_profile',
        ),
      );
      const res = await request(app)
        .post('/api/profiles/portfolio')
        .set(bearer(7))
        .send({ title: 'Site da padaria', externalUrl: LINK })
        .expect(409);
      expect(res.body).toEqual({
        error: 'no_freelancer_profile',
        message: 'Crie seu perfil de freelancer antes do portfólio',
      });
    });

    it('portfólio cheio: a recusa do service vira 409 com o código dele', async () => {
      service.addPortfolioItem.mockRejectedValue(
        new HttpError(409, 'O portfólio tem no máximo 12 itens', 'portfolio_full'),
      );
      const res = await request(app)
        .post('/api/profiles/portfolio')
        .set(bearer(7))
        .send({ title: 'Mais um', externalUrl: LINK })
        .expect(409);
      expect(res.body).toEqual({
        error: 'portfolio_full',
        message: 'O portfólio tem no máximo 12 itens',
      });
    });
  });

  describe('PUT /api/profiles/portfolio/order (ADR 43)', () => {
    it('"order" não é lido como id de trabalho: a rota reordena, na ordem enviada', async () => {
      const items = [{ id: 3 }, { id: 1 }, { id: 2 }];
      service.reorderPortfolio.mockResolvedValue(items);

      const res = await request(app)
        .put('/api/profiles/portfolio/order')
        .set(bearer(7))
        .send({ ids: [3, 1, 2] })
        .expect(200);

      expect(res.body).toEqual(items);
      expect(service.reorderPortfolio).toHaveBeenCalledWith(7, [3, 1, 2]);
      expect(service.updatePortfolioItem).not.toHaveBeenCalled();
    });

    it('trabalho repetido, lista vazia, mais de 12 ids ou id que não é inteiro positivo são recusados', async () => {
      const repeated = await request(app)
        .put('/api/profiles/portfolio/order')
        .set(bearer(7))
        .send({ ids: [3, 1, 3] })
        .expect(422);
      expect(repeated.body.details).toEqual({ ids: ['Trabalho repetido na ordem'] });

      const thirteen = Array.from({ length: 13 }, (_, i) => i + 1);
      for (const ids of [[], thirteen, [1, 0], [1, 2.5], ['1', '2'], undefined]) {
        const res = await request(app)
          .put('/api/profiles/portfolio/order')
          .set(bearer(7))
          .send({ ids })
          .expect(422);
        expect(Object.keys(res.body.details)).toEqual(['ids']);
      }
      expect(service.reorderPortfolio).not.toHaveBeenCalled();
    });

    it('doze trabalhos, o limite do portfólio, ainda podem ser reordenados', async () => {
      service.reorderPortfolio.mockResolvedValue([]);
      const twelve = Array.from({ length: 12 }, (_, i) => 12 - i);
      await request(app)
        .put('/api/profiles/portfolio/order')
        .set(bearer(7))
        .send({ ids: twelve })
        .expect(200);
      expect(service.reorderPortfolio).toHaveBeenCalledWith(7, twelve);
    });

    it('portfólio que mudou no meio do caminho: o 409 do service chega com o código dele', async () => {
      service.reorderPortfolio.mockRejectedValue(
        new HttpError(
          409,
          'O portfólio mudou enquanto você reordenava',
          'portfolio_order_mismatch',
        ),
      );
      const res = await request(app)
        .put('/api/profiles/portfolio/order')
        .set(bearer(7))
        .send({ ids: [3, 1] })
        .expect(409);
      expect(res.body).toEqual({
        error: 'portfolio_order_mismatch',
        message: 'O portfólio mudou enquanto você reordenava',
      });
      expect(service.reorderPortfolio).toHaveBeenCalledWith(7, [3, 1]);
    });
  });

  describe('PUT /api/profiles/portfolio/:id', () => {
    it('edita o trabalho da URL em nome de quem está logado', async () => {
      const items = [{ id: 12, title: 'Novo título' }];
      service.updatePortfolioItem.mockResolvedValue(items);

      const res = await request(app)
        .put('/api/profiles/portfolio/12')
        .set(bearer(7))
        .send({ title: ' Novo título ', externalUrl: LINK })
        .expect(200);

      expect(res.body).toEqual(items);
      expect(service.updatePortfolioItem).toHaveBeenCalledWith(7, 12, {
        title: 'Novo título',
        externalUrl: LINK,
      });
    });

    it('id que não é inteiro positivo é recusado', async () => {
      for (const id of ['abc', '0', '-1', '1.5']) {
        const res = await request(app)
          .put(`/api/profiles/portfolio/${id}`)
          .set(bearer(7))
          .send({ title: 'Novo título', externalUrl: LINK })
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      expect(service.updatePortfolioItem).not.toHaveBeenCalled();
      expect(service.reorderPortfolio).not.toHaveBeenCalled();
    });

    it('a edição passa pela mesma validação da criação (imagem ou link)', async () => {
      const res = await request(app)
        .put('/api/profiles/portfolio/12')
        .set(bearer(7))
        .send({ title: 'Novo título' })
        .expect(422);
      expect(res.body.details).toHaveProperty('imageUrl');
      expect(service.updatePortfolioItem).not.toHaveBeenCalled();
    });

    it('trabalho de outra pessoa: o 404 do service chega com o código dele', async () => {
      service.updatePortfolioItem.mockRejectedValue(
        new HttpError(404, 'Item do portfólio não encontrado', 'portfolio_item_not_found'),
      );
      const res = await request(app)
        .put('/api/profiles/portfolio/99')
        .set(bearer(7))
        .send({ title: 'Novo título', externalUrl: LINK })
        .expect(404);
      expect(res.body.error).toBe('portfolio_item_not_found');
    });
  });

  describe('DELETE /api/profiles/portfolio/:id', () => {
    it('remove o trabalho da URL em nome de quem está logado e devolve o que sobrou', async () => {
      const items = [{ id: 1, title: 'Site da padaria' }];
      service.removePortfolioItem.mockResolvedValue(items);

      const res = await request(app).delete('/api/profiles/portfolio/12').set(bearer(7));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(items);
      expect(service.removePortfolioItem).toHaveBeenCalledWith(7, 12);
    });

    it('id que não é inteiro positivo é recusado', async () => {
      // "order" só é rota no PUT: no DELETE cai como id e é recusado.
      for (const id of ['abc', '0', '-1', '1.5', 'order']) {
        const res = await request(app)
          .delete(`/api/profiles/portfolio/${id}`)
          .set(bearer(7))
          .expect(422);
        expect(res.body.error).toBe('validation_error');
        expect(Object.keys(res.body.details)).toEqual(['id']);
      }
      expect(service.removePortfolioItem).not.toHaveBeenCalled();
    });

    it('trabalho de outra pessoa (ou que não existe): o 404 do service chega com o código dele', async () => {
      service.removePortfolioItem.mockRejectedValue(
        new HttpError(404, 'Item do portfólio não encontrado', 'portfolio_item_not_found'),
      );
      const res = await request(app)
        .delete('/api/profiles/portfolio/99')
        .set(bearer(7))
        .expect(404);
      expect(res.body).toEqual({
        error: 'portfolio_item_not_found',
        message: 'Item do portfólio não encontrado',
      });
      expect(service.removePortfolioItem).toHaveBeenCalledWith(7, 99);
    });
  });
});
