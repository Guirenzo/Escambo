import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boostsService } from './boosts.service';

const { repo, services, zone } = vi.hoisted(() => ({
  repo: {
    listPlans: vi.fn(),
    findPlan: vi.fn(),
    purchase: vi.fn(),
    listForUser: vi.fn(),
    findById: vi.fn(),
  },
  services: { findById: vi.fn() },
  zone: vi.fn(),
}));
vi.mock('./boosts.repository', () => ({ boostsRepository: repo }));
vi.mock('../services/services.repository', () => ({ servicesRepository: services }));
vi.mock('../auth/user-zone', () => ({ userZone: zone }));

const planRow = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  name: 'Destaque 7 dias',
  description: 'Topo da busca por 7 dias',
  duration_days: 7,
  price: '29.90',
  features: null,
  is_active: 1,
  ...o,
});

const boostRow = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 91,
  service_id: 3,
  plan_id: 1,
  plan_name: 'Destaque 7 dias',
  status: 'active',
  starts_at: new Date('2026-03-10T12:00:00Z'),
  expires_at: new Date('2026-03-17T12:00:00Z'),
  created_at: new Date('2026-03-10T12:00:01Z'),
  ...o,
});

/** Regras do impulsionamento, com o repository mockado: quem pode comprar, quanto custa e o que volta. */
describe('boostsService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('plans', () => {
    it('converte a linha do banco no plano da API, com o preço em número e o custo em créditos', async () => {
      repo.listPlans.mockResolvedValue([
        planRow({ features: { top_search: true, badge: 'Destaque' } }),
      ]);

      expect(await boostsService.plans()).toEqual([
        {
          id: 1,
          name: 'Destaque 7 dias',
          description: 'Topo da busca por 7 dias',
          durationDays: 7,
          price: 29.9,
          costCredits: 30,
          features: { top_search: true, badge: 'Destaque' },
        },
      ]);
      expect(repo.listPlans).toHaveBeenCalledTimes(1);
    });

    it('o custo em créditos é o preço arredondado para o inteiro mais próximo (1 crédito ≈ R$ 1)', async () => {
      repo.listPlans.mockResolvedValue([
        planRow({ id: 1, price: '99.90' }),
        planRow({ id: 2, price: '10.49' }),
        planRow({ id: 3, price: '10.50' }),
        planRow({ id: 4, price: '15.00' }),
      ]);

      const plans = await boostsService.plans();

      expect(plans.map((p) => [p.price, p.costCredits])).toEqual([
        [99.9, 100],
        [10.49, 10],
        [10.5, 11],
        [15, 15],
      ]);
    });

    it('impulsionamento nunca sai de graça: plano abaixo de R$ 0,50 custa 1 crédito, não 0', async () => {
      repo.listPlans.mockResolvedValue([
        planRow({ id: 1, price: '0.49' }),
        planRow({ id: 2, price: '0.10' }),
        planRow({ id: 3, price: '0.00' }),
        planRow({ id: 4, price: '0.50' }),
        planRow({ id: 5, price: '1.49' }),
      ]);

      const plans = await boostsService.plans();

      expect(plans.map((p) => [p.price, p.costCredits])).toEqual([
        [0.49, 1],
        [0.1, 1],
        [0, 1],
        [0.5, 1],
        [1.49, 1],
      ]);
    });

    it('features: aceita JSON em texto ou já convertido; nulo ou texto inválido vira null', async () => {
      repo.listPlans.mockResolvedValue([
        planRow({ id: 1, features: '{"homepage":true}' }),
        planRow({ id: 2, features: { homepage: false } }),
        planRow({ id: 3, features: null }),
        planRow({ id: 4, features: undefined }),
        planRow({ id: 5, features: '{homepage' }),
      ]);

      const plans = await boostsService.plans();

      expect(plans.map((p) => p.features)).toEqual([
        { homepage: true },
        { homepage: false },
        null,
        null,
        null,
      ]);
    });

    it('sem planos ativos, devolve lista vazia', async () => {
      repo.listPlans.mockResolvedValue([]);
      expect(await boostsService.plans()).toEqual([]);
    });
  });

  describe('buy', () => {
    it('compra para um serviço próprio: cobra o custo do plano em créditos pela duração dele', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(planRow({ id: 2, price: '29.90', duration_days: 7 }));
      repo.purchase.mockResolvedValue({ boostId: 91 });
      repo.findById.mockResolvedValue(boostRow({ plan_id: 2 }));

      const boost = await boostsService.buy(7, 3, 2);

      expect(services.findById).toHaveBeenCalledWith(3);
      expect(repo.findPlan).toHaveBeenCalledWith(2);
      expect(repo.purchase).toHaveBeenCalledTimes(1);
      expect(repo.purchase).toHaveBeenCalledWith({
        userId: 7,
        serviceId: 3,
        planId: 2,
        cost: 30,
        durationDays: 7,
      });
      // O que volta é o impulsionamento recém-criado, relido pelo id que a compra devolveu.
      expect(repo.findById).toHaveBeenCalledWith(91);
      expect(boost).toEqual({
        id: 91,
        serviceId: 3,
        planId: 2,
        planName: 'Destaque 7 dias',
        status: 'active',
        startsAt: '2026-03-10T12:00:00.000Z',
        expiresAt: '2026-03-17T12:00:00.000Z',
        createdAt: '2026-03-10T12:00:01.000Z',
      });
    });

    it('serviço que não existe: 404 e nada é cobrado', async () => {
      services.findById.mockResolvedValue(undefined);

      await expect(boostsService.buy(7, 3, 2)).rejects.toMatchObject({
        statusCode: 404,
        code: 'service_not_found',
        message: 'Serviço não encontrado',
      });

      expect(services.findById).toHaveBeenCalledWith(3);
      expect(repo.findPlan).not.toHaveBeenCalled();
      expect(repo.purchase).not.toHaveBeenCalled();
    });

    it('só o dono pode impulsionar o serviço: o de outra pessoa dá 403 e nada é cobrado', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 8, is_active: 1 });

      await expect(boostsService.buy(7, 3, 2)).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
        message: 'Você só pode impulsionar os seus serviços',
      });

      expect(repo.findPlan).not.toHaveBeenCalled();
      expect(repo.purchase).not.toHaveBeenCalled();
    });

    it('plano inexistente ou desativado: 404 e nada é cobrado', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(undefined);

      await expect(boostsService.buy(7, 3, 2)).rejects.toMatchObject({
        statusCode: 404,
        code: 'plan_not_found',
        message: 'Plano de impulsionamento não encontrado',
      });

      expect(repo.findPlan).toHaveBeenCalledWith(2);
      expect(repo.purchase).not.toHaveBeenCalled();
    });

    it('o dono é conferido antes do plano: serviço de outra pessoa com plano inexistente dá 403, não 404', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 8, is_active: 1 });
      repo.findPlan.mockResolvedValue(undefined);

      await expect(boostsService.buy(7, 3, 999)).rejects.toMatchObject({
        statusCode: 403,
        code: 'forbidden',
      });
    });

    it('o custo e a duração vêm do plano gravado, na regra de arredondamento da vitrine', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(planRow({ id: 5, price: '10.49', duration_days: 15 }));
      repo.purchase.mockResolvedValue({ boostId: 92 });
      repo.findById.mockResolvedValue(boostRow({ id: 92, plan_id: 5 }));

      const boost = await boostsService.buy(7, 3, 5);

      // R$ 10,49 são 10 créditos: o mesmo número que a vitrine mostra em costCredits.
      expect(repo.purchase).toHaveBeenCalledWith({
        userId: 7,
        serviceId: 3,
        planId: 5,
        cost: 10,
        durationDays: 15,
      });
      expect(repo.findById).toHaveBeenCalledWith(92);
      expect(boost.id).toBe(92);
      expect(boost.planId).toBe(5);
    });

    it('falha do banco na compra sobe como veio, e nenhum impulsionamento é devolvido', async () => {
      const boom = new Error('ER_LOCK_DEADLOCK');
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(planRow({ id: 2 }));
      repo.purchase.mockRejectedValue(boom);

      await expect(boostsService.buy(7, 3, 2)).rejects.toBe(boom);

      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('créditos insuficientes (a compra recusa): 409 e não procura impulsionamento nenhum', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(planRow({ id: 2, price: '99.90', duration_days: 30 }));
      repo.purchase.mockResolvedValue({ refused: 'insufficient_credits' });

      await expect(boostsService.buy(7, 3, 2)).rejects.toMatchObject({
        statusCode: 409,
        code: 'insufficient_credits',
        message: 'Créditos insuficientes para impulsionar',
      });

      expect(repo.purchase).toHaveBeenCalledWith({
        userId: 7,
        serviceId: 3,
        planId: 2,
        cost: 100,
        durationDays: 30,
      });
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('serviço pausado não é impulsionado: 409 service_inactive e nada é cobrado', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 0 });
      repo.findPlan.mockResolvedValue(planRow({ id: 2 }));

      await expect(boostsService.buy(7, 3, 2)).rejects.toMatchObject({
        statusCode: 409,
        code: 'service_inactive',
        message: 'Serviço pausado não pode ser impulsionado: reative-o antes',
      });

      expect(repo.findPlan).not.toHaveBeenCalled();
      expect(repo.purchase).not.toHaveBeenCalled();
    });

    it('plano abaixo de R$ 0,50 cobra 1 crédito na compra: o débito de 0 passaria sempre', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(planRow({ id: 6, price: '0.30', duration_days: 1 }));
      repo.purchase.mockResolvedValue({ boostId: 93 });
      repo.findById.mockResolvedValue(boostRow({ id: 93, plan_id: 6 }));

      await boostsService.buy(7, 3, 6);

      expect(repo.purchase).toHaveBeenCalledWith({
        userId: 7,
        serviceId: 3,
        planId: 6,
        cost: 1,
        durationDays: 1,
      });
    });

    it('serviço com impulsionamento ativo: 409 boost_active dizendo até quando vale o atual, no fuso de quem compra (RN-017)', async () => {
      services.findById.mockResolvedValue({ id: 3, user_id: 7, is_active: 1 });
      repo.findPlan.mockResolvedValue(planRow({ id: 2 }));
      repo.purchase.mockResolvedValue({
        refused: 'boost_active',
        activeUntil: new Date('2026-03-17T12:00:00Z'),
      });
      zone.mockResolvedValue('America/Manaus');

      await expect(boostsService.buy(7, 3, 2)).rejects.toMatchObject({
        statusCode: 409,
        code: 'boost_active',
        message:
          'Este serviço já tem um impulsionamento ativo até 17/03/2026 às 08:00; um novo só depois que ele terminar (RN-017)',
      });

      expect(zone).toHaveBeenCalledWith(7);
      expect(repo.findById).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('lista os impulsionamentos de quem pede, com as datas em ISO e o status do banco', async () => {
      repo.listForUser.mockResolvedValue([
        boostRow(),
        boostRow({
          id: 40,
          service_id: null,
          status: 'expired',
          // O mysql2 pode entregar a data como texto: a saída é ISO do mesmo jeito.
          starts_at: '2026-01-01T00:00:00Z',
          expires_at: '2026-01-31T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        }),
      ]);

      const mine = await boostsService.listMine(7);

      expect(repo.listForUser).toHaveBeenCalledWith(7);
      expect(mine).toEqual([
        {
          id: 91,
          serviceId: 3,
          planId: 1,
          planName: 'Destaque 7 dias',
          status: 'active',
          startsAt: '2026-03-10T12:00:00.000Z',
          expiresAt: '2026-03-17T12:00:00.000Z',
          createdAt: '2026-03-10T12:00:01.000Z',
        },
        {
          id: 40,
          serviceId: null,
          planId: 1,
          planName: 'Destaque 7 dias',
          status: 'expired',
          startsAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-31T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    it('quem nunca impulsionou recebe lista vazia', async () => {
      repo.listForUser.mockResolvedValue([]);
      expect(await boostsService.listMine(7)).toEqual([]);
    });
  });
});
